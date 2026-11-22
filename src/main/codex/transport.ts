import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  parseRateLimitsNotification,
  parseRateLimitsResponse,
  type QuotaBucket,
  type QuotaSnapshot,
} from "./rate-limits";

export interface TransportProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
}

const initialization = {
  clientInfo: {
    name: "codex_quota_monitor",
    title: "Codex Quota Monitor",
    version: "0.1.0",
  },
  capabilities: null,
};
const allowed = new Map<string, unknown>([
  ["initialize", initialization],
  ["initialized", undefined],
  ["account/read", { refreshToken: false }],
  ["account/rateLimits/read", { excludeResetCreditDetails: true }],
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function equal(value: unknown, expected: unknown): boolean {
  if (!object(expected)) return value === expected;
  return (
    object(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, entry]) => Object.hasOwn(value, key) && equal(value[key], entry),
    )
  );
}

export function validateOutbound(method: string, params: unknown): void {
  if (!allowed.has(method) || !equal(params, allowed.get(method))) {
    throw new Error("Unauthorized outbound request");
  }
}

type Pending = {
  id: number;
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexTransport {
  #child: TransportProcess;
  #pending: Pending | undefined;
  #nextId = 1;
  #state: "new" | "initializing" | "ready" | "closed" = "new";
  #buffer: Buffer;
  #length = 0;
  #timeoutMs: number;
  #maxBytes: number;
  #listeners = new Set<(payload: QuotaBucket) => void>();
  #onFailure: (() => void) | undefined;

  constructor(
    child: TransportProcess,
    options: {
      timeoutMs?: number;
      maxMessageBytes?: number;
      onFailure?: () => void;
    } = {},
  ) {
    this.#child = child;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxBytes = options.maxMessageBytes ?? 1_048_576;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs <= 0 ||
      this.#timeoutMs > 60_000 ||
      !Number.isSafeInteger(this.#maxBytes) ||
      this.#maxBytes <= 0 ||
      this.#maxBytes > 1_048_576
    ) {
      throw new Error("Invalid transport limits");
    }
    this.#buffer = Buffer.allocUnsafe(this.#maxBytes);
    this.#onFailure = options.onFailure;
    child.stdout.on("data", this.#onData);
    child.stdout.on("error", this.#onError);
    child.stdout.on("end", this.#onError);
    child.stdin.on("error", this.#onError);
    child.on("exit", this.#onError);
    child.on("error", this.#onError);
  }

  async initialize(): Promise<void> {
    if (this.#state !== "new" || arguments.length)
      throw new Error("Invalid initialization state");
    this.#state = "initializing";
    try {
      await this.#request("initialize", initialization);
      this.#write("initialized", undefined);
      this.#state = "ready";
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async readAccount(): Promise<"chatgpt" | "unauthenticated" | "unsupported"> {
    if (this.#state !== "ready" || arguments.length)
      throw new Error("Transport unavailable");
    return (await this.#request("account/read", { refreshToken: false })) as
      "chatgpt" | "unauthenticated" | "unsupported";
  }

  async readRateLimits(): Promise<QuotaSnapshot> {
    if (this.#state !== "ready" || arguments.length)
      throw new Error("Transport unavailable");
    return (await this.#request("account/rateLimits/read", {
      excludeResetCreditDetails: true,
    })) as QuotaSnapshot;
  }

  subscribeRateLimits(listener: (payload: QuotaBucket) => void): () => void {
    if (
      this.#state === "closed" ||
      typeof listener !== "function" ||
      this.#listeners.size >= 16
    ) {
      throw new Error("Transport unavailable");
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#buffer = Buffer.alloc(0);
    this.#length = 0;
    this.#listeners.clear();
    this.#onFailure = undefined;
    const child = this.#child;
    child.stdout.off("data", this.#onData);
    child.stdout.off("error", this.#onError);
    child.stdout.off("end", this.#onError);
    child.stdin.off("error", this.#onError);
    child.off("exit", this.#onError);
    child.off("error", this.#onError);
    this.#reject(new Error("Invalid server message"));
  }

  #onError = () => {
    const notify = this.#onFailure;
    this.close();
    notify?.();
  };

  #reject(error: Error): void {
    if (!this.#pending) return;
    const pending = this.#pending;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #write(method: string, params: unknown, id?: number): void {
    validateOutbound(method, params);
    const message = id === undefined ? { method } : { method, id, params };
    this.#child.stdin.write(JSON.stringify(message) + "\n");
  }

  #request(method: string, params: unknown): Promise<unknown> {
    validateOutbound(method, params);
    if (this.#pending)
      return Promise.reject(new Error("Pending request limit"));
    if (!Number.isSafeInteger(this.#nextId))
      return Promise.reject(new Error("Request ID limit"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#reject(new Error("Request timed out")),
        this.#timeoutMs,
      );
      this.#pending = { id, method, resolve, reject, timer };
      try {
        this.#write(method, params, id);
      } catch {
        this.#onError();
      }
    });
  }

  #onData = (chunk: Buffer) => {
    if (this.#state === "closed") return;
    try {
      if (!Buffer.isBuffer(chunk)) throw new Error();
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (this.#length + part.length > this.#maxBytes) throw new Error();
        part.copy(this.#buffer, this.#length);
        this.#length += part.length;
        if (newline !== -1) {
          const line = new TextDecoder("utf-8", { fatal: true }).decode(
            this.#buffer.subarray(0, this.#length),
          );
          this.#length = 0;
          this.#message(JSON.parse(line));
          if (this.#isClosed()) return;
        }
        offset = end + 1;
      }
    } catch {
      this.#onError();
    }
  };

  #isClosed(): boolean {
    return this.#state === "closed";
  }

  #message(message: unknown): void {
    if (!object(message)) throw new Error();
    if (Object.hasOwn(message, "method")) {
      if (Object.hasOwn(message, "id") || typeof message.method !== "string")
        throw new Error();
      if (message.method === "account/rateLimits/updated") {
        const update = parseRateLimitsNotification(message.params);
        for (const listener of this.#listeners) listener(update);
      }
      return;
    }
    if (
      !Object.hasOwn(message, "id") ||
      (!Number.isSafeInteger(message.id) && typeof message.id !== "string")
    )
      throw new Error();
    const pending = this.#pending;
    if (!pending || message.id !== pending.id) return;
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) throw new Error();
    if (hasError) {
      if (
        !object(message.error) ||
        !Number.isSafeInteger(message.error.code) ||
        typeof message.error.message !== "string"
      )
        throw new Error();
      this.#reject(new Error("Server rejected request"));
      return;
    }
    let result = message.result;
    if (pending.method === "initialize") {
      if (
        !object(result) ||
        typeof result.userAgent !== "string" ||
        typeof result.codexHome !== "string" ||
        result.platformFamily !== "windows" ||
        result.platformOs !== "windows"
      )
        throw new Error();
      result = undefined;
    } else if (pending.method === "account/read") {
      if (
        !object(result) ||
        typeof result.requiresOpenaiAuth !== "boolean" ||
        !(result.userId === null || typeof result.userId === "string")
      )
        throw new Error();
      if (result.account === null) result = "unauthenticated";
      else if (
        object(result.account) &&
        typeof result.account.type === "string"
      ) {
        if (result.account.type === "chatgpt") {
          if (
            !(
              result.account.email === null ||
              typeof result.account.email === "string"
            ) ||
            typeof result.account.planType !== "string" ||
            !(
              result.account.workspaceName === null ||
              typeof result.account.workspaceName === "string"
            )
          )
            throw new Error();
          result = "chatgpt";
        } else if (
          ["apiKey", "amazonBedrock", "gcp"].includes(result.account.type)
        )
          result = "unsupported";
        else throw new Error();
      } else throw new Error();
    } else {
      result = parseRateLimitsResponse(result);
    }
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
}
