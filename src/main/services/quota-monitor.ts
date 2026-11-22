import type { QuotaSnapshot } from "../codex/rate-limits";
import {
  QuotaProviderError,
  type QuotaFailure,
  type QuotaProvider,
  type QuotaSession,
} from "./quota-provider";

export type PollInterval = 30 | 60 | 120 | 300;
type QuotaData = { snapshot: QuotaSnapshot; updatedAtMs: number };
export type QuotaStatus =
  | { phase: "disconnected" | "connecting" }
  | ({ phase: "connected" } & QuotaData)
  | { phase: "error"; reason: QuotaFailure }
  | ({ phase: "stale"; reason: QuotaFailure } & QuotaData);

const intervals: readonly number[] = [30, 60, 120, 300];
const retryDelays = [2_000, 4_000, 8_000, 16_000, 30_000];
const requestTimeoutMs = 10_000;
const notificationDelayMs = 1_000;

export function resetCountdownMs(
  resetAtMs: number | null,
  nowMs: number,
): number | null {
  return resetAtMs === null ? null : Math.max(0, resetAtMs - nowMs);
}

function interruptible<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export class QuotaMonitor {
  #status: QuotaStatus = { phase: "disconnected" };
  #data?: QuotaData;
  #running = false;
  #unreaped = false;
  #interval: PollInterval = 60;
  #timer?: ReturnType<typeof setTimeout>;
  #flight?: Promise<void>;
  #stopping?: Promise<void>;
  #operation?: AbortController;
  #connection?: { session: QuotaSession; unsubscribe?: () => void };
  #broken = false;
  #notified = false;
  #failures = 0;
  #retryDelay = 0;

  constructor(
    private readonly provider: QuotaProvider,
    private readonly now = Date.now,
  ) {}

  get status(): QuotaStatus {
    return this.#status;
  }

  setInterval(seconds: PollInterval) {
    if (!intervals.includes(seconds))
      throw new RangeError("Unsupported quota polling interval");
    this.#interval = seconds;
    if (this.#running && !this.#flight && this.#status.phase === "connected")
      this.#schedule();
  }

  start(): Promise<void> {
    if (this.#stopping || this.#unreaped)
      return this.#stopping ?? Promise.resolve();
    if (this.#running) return this.#flight ?? Promise.resolve();
    this.#running = true;
    this.#status = { phase: "connecting" };
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.#running || this.#unreaped) return Promise.resolve();
    if (this.#flight) return this.#flight;
    if (this.#retryDelay) return Promise.resolve();
    clearTimeout(this.#timer);
    this.#notified = false;
    this.#flight = Promise.resolve()
      .then(() => this.#read())
      .finally(() => {
        this.#flight = undefined;
        this.#schedule();
      });
    return this.#flight;
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#running = false;
    clearTimeout(this.#timer);
    this.#operation?.abort();
    this.#stopping = Promise.resolve()
      .then(async () => {
        await this.#flight;
        await this.#retire();
        this.#data = undefined;
        this.#notified = false;
        this.#broken = false;
        this.#failures = 0;
        this.#retryDelay = 0;
        this.#status = this.#unreaped
          ? { phase: "error", reason: "cleanup" }
          : { phase: "disconnected" };
      })
      .finally(() => {
        this.#stopping = undefined;
      });
    return this.#stopping;
  }

  async #read() {
    if (!this.#running) return;
    const operation = new AbortController();
    this.#operation = operation;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(deadline);
      deadline = setTimeout(
        () => operation.abort(new QuotaProviderError("timeout", true)),
        requestTimeoutMs,
      );
    };
    try {
      if (this.#broken) throw new QuotaProviderError("transport", true);
      if (!this.#connection) {
        if (!this.#data) this.#status = { phase: "connecting" };
        arm();
        const session = await this.provider.open(operation.signal);
        const connection: { session: QuotaSession; unsubscribe?: () => void } =
          { session };
        this.#connection = connection;
        operation.signal.throwIfAborted();
        connection.unsubscribe = session.subscribe(
          () => {
            if (
              !this.#running ||
              this.#connection !== connection ||
              this.#notified
            )
              return;
            this.#notified = true;
            if (!this.#flight) this.#schedule();
          },
          () => {
            if (
              !this.#running ||
              this.#connection !== connection ||
              this.#broken
            )
              return;
            this.#broken = true;
            this.#operation?.abort(new QuotaProviderError("transport", true));
            void this.refresh();
          },
        );
      }
      operation.signal.throwIfAborted();
      arm();
      const snapshot = await interruptible(
        this.#connection.session.read(),
        operation.signal,
      );
      operation.signal.throwIfAborted();
      if (!this.#running) return;
      this.#data = { snapshot, updatedAtMs: this.now() };
      this.#status = { phase: "connected", ...this.#data };
      this.#failures = 0;
      this.#retryDelay = 0;
    } catch (error) {
      const cause =
        error instanceof QuotaProviderError && error.reason === "cleanup"
          ? error
          : operation.signal.aborted
            ? operation.signal.reason
            : error;
      const failure =
        cause instanceof QuotaProviderError
          ? cause
          : new QuotaProviderError("unavailable", true);
      if (failure.reason === "cleanup") this.#unreaped = true;
      if (this.#running) this.#report(failure.reason);
      await this.#retire();
      if (!this.#running) return;
      if (this.#unreaped) this.#report("cleanup");
      else if (failure.retryable) {
        const delay = retryDelays[this.#failures];
        if (delay !== undefined) this.#failures++;
        this.#retryDelay = delay ?? this.#interval * 1000;
      } else {
        this.#retryDelay = 0;
      }
    } finally {
      clearTimeout(deadline);
      this.#operation = undefined;
    }
  }

  async #retire() {
    const connection = this.#connection;
    this.#connection = undefined;
    this.#broken = false;
    this.#notified = false;
    if (!connection) return;
    try {
      try {
        connection.unsubscribe?.();
      } finally {
        await connection.session.close();
      }
    } catch {
      this.#unreaped = true;
    }
  }

  #report(reason: QuotaFailure) {
    this.#status = this.#data
      ? { phase: "stale", reason, ...this.#data }
      : { phase: "error", reason };
  }

  #schedule() {
    clearTimeout(this.#timer);
    if (!this.#running || this.#unreaped) return;
    const delay =
      this.#retryDelay ||
      (this.#status.phase === "connected"
        ? this.#notified
          ? notificationDelayMs
          : this.#interval * 1000
        : undefined);
    if (delay !== undefined)
      this.#timer = setTimeout(() => {
        this.#retryDelay = 0;
        void this.refresh();
      }, delay);
  }
}
