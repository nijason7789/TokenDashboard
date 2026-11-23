import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseRateLimitsResponse } from "../src/main/codex/rate-limits";
import {
  QuotaMonitor,
  resetCountdownMs,
} from "../src/main/services/quota-monitor";
import { QuotaProviderError } from "../src/main/services/quota-provider";

const window = {
  usedPercent: 30,
  windowDurationMins: 300,
  resetsAt: 1800000000,
};
const bucket = { limitId: "codex", primary: window, secondary: null };
const data = parseRateLimitsResponse({
  rateLimits: bucket,
  rateLimitsByLimitId: {
    codex: bucket,
    alternative: { ...bucket, limitId: "alternative" },
  },
});
function fixture() {
  let update = () => {};
  let failure = () => {};
  const unsubscribe = vi.fn();
  const session = {
    read: vi.fn(async () => data),
    subscribe: vi.fn((onUpdate: () => void, onFailure: () => void) => {
      update = onUpdate;
      failure = onFailure;
      return unsubscribe;
    }),
    close: vi.fn(async () => {}),
  };
  return {
    session,
    unsubscribe,
    update: () => update(),
    fail: () => failure(),
  };
}
function setup() {
  const first = fixture();
  const open = vi.fn<(signal: AbortSignal) => Promise<typeof first.session>>(
    async () => first.session,
  );
  const monitor = new QuotaMonitor({ open });
  return { ...first, monitor, open };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
});
afterEach(() => vi.useRealTimers());

it.each([30, 60, 120, 300] as const)(
  "refreshes initially and polls every %i seconds",
  async (interval) => {
    const { monitor, session, open } = setup();
    monitor.setInterval(interval);
    const ready = monitor.start();
    expect(monitor.status.phase).toBe("connecting");
    await ready;
    expect(monitor.status).toEqual({
      phase: "connected",
      snapshot: data,
      updatedAtMs: 0,
    });
    await vi.advanceTimersByTimeAsync(interval * 1000 - 1);
    expect(session.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.read).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledOnce();
    await monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("shares an active refresh, coalesces notifications, and uses the default interval", async () => {
  const { monitor, session, update } = setup();
  await monitor.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(session.read).toHaveBeenCalledTimes(2);
  let finish!: (value: typeof data) => void;
  session.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const manual = monitor.refresh();
  expect(monitor.refresh()).toBe(manual);
  await vi.advanceTimersByTimeAsync(0);
  update();
  update();
  update();
  finish(data);
  await manual;
  await vi.advanceTimersByTimeAsync(1000);
  expect(session.read).toHaveBeenCalledTimes(4);
  await monitor.stop();
});

it("retires a timed-out session, retains its timestamp and recovers on a fresh one", async () => {
  const { monitor, session, open, unsubscribe, update } = setup();
  const fresh = fixture();
  await monitor.start();
  await vi.advanceTimersByTimeAsync(20);
  session.read.mockImplementationOnce(() => new Promise(() => {}));
  const stalled = monitor.refresh();
  await vi.advanceTimersByTimeAsync(10000);
  await stalled;
  expect(monitor.status).toMatchObject({
    phase: "stale",
    snapshot: data,
    updatedAtMs: 0,
    reason: "timeout",
  });
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(session.close).toHaveBeenCalledOnce();
  update();
  open.mockResolvedValue(fresh.session);
  await vi.advanceTimersByTimeAsync(1999);
  expect(open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(open).toHaveBeenCalledTimes(2);
  expect(monitor.status.phase).toBe("connected");
  await monitor.stop();
});

it("responds to an idle transport failure and does not reuse a failed session", async () => {
  const { monitor, session, open, fail } = setup();
  await monitor.start();
  fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(monitor.status.phase).toBe("stale");
  expect(session.close).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();
  await monitor.stop();
});

it("bounds reconnect backoff and skips automatic retry for permanent errors", async () => {
  const { monitor, open } = setup();
  open.mockRejectedValue(new Error("private details"));
  await monitor.start();
  expect(monitor.status).toEqual({ phase: "error", reason: "unavailable" });
  let attempts = 1;
  for (const delay of [2, 4, 8, 16, 30, 60, 60]) {
    await vi.advanceTimersByTimeAsync(delay * 1000 - 1);
    expect(open).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(++attempts);
  }
  open.mockRejectedValue(new QuotaProviderError("unauthenticated", false));
  await vi.advanceTimersByTimeAsync(60000);
  expect(monitor.status).toEqual({ phase: "error", reason: "unauthenticated" });
  await vi.advanceTimersByTimeAsync(120000);
  expect(open).toHaveBeenCalledTimes(attempts + 1);
  await monitor.stop();
});

it("stops pending work without accepting late results and can restart", async () => {
  const { monitor, session, open, unsubscribe, update } = setup();
  let finish!: (value: typeof data) => void;
  session.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const started = monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  await monitor.stop();
  finish(data);
  await started;
  update();
  await monitor.refresh();
  await vi.advanceTimersByTimeAsync(300000);
  expect(monitor.status).toEqual({ phase: "disconnected" });
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(session.close).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  open.mockResolvedValue(fixture().session);
  await monitor.start();
  expect(monitor.status.phase).toBe("connected");
  await monitor.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("publishes missing and ambiguous domain results and computes countdown locally", async () => {
  const { monitor, session } = setup();
  const ambiguous = parseRateLimitsResponse({
    rateLimits: bucket,
    rateLimitsByLimitId: { alternative: { ...bucket, limitId: "alternative" } },
  });
  session.read.mockResolvedValueOnce(ambiguous);
  await monitor.start();
  expect(monitor.status).toMatchObject({
    phase: "connected",
    snapshot: {
      defaultSelection: { state: "ambiguous" },
      buckets: [{ weekly: { state: "missing" } }],
    },
  });
  expect(resetCountdownMs(null, 0)).toBeNull();
  expect(resetCountdownMs(2000, Date.now())).toBe(2000);
  await vi.advanceTimersByTimeAsync(3000);
  expect(resetCountdownMs(2000, Date.now())).toBe(0);
  expect(session.read).toHaveBeenCalledOnce();
  await monitor.stop();
});

it("does not postpone an idle update during a burst and supports changing interval", async () => {
  const { monitor, session, update } = setup();
  await monitor.start();
  await monitor.start();
  expect(() => monitor.setInterval(45 as 30)).toThrow(RangeError);
  monitor.setInterval(30);
  update();
  await vi.advanceTimersByTimeAsync(900);
  update();
  await vi.advanceTimersByTimeAsync(100);
  expect(session.read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30000);
  expect(session.read).toHaveBeenCalledTimes(3);
  await monitor.stop();
});

it("quarantines an overdue open and still closes its late session", async () => {
  const { monitor, session, open } = setup();
  let complete!: (value: typeof session) => void;
  open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const first = monitor.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(open.mock.calls[0]?.[0].aborted).toBe(true);
  expect(monitor.refresh()).toBe(first);
  await vi.advanceTimersByTimeAsync(60000);
  expect(open).toHaveBeenCalledOnce();
  complete(session);
  await first;
  await vi.advanceTimersByTimeAsync(0);
  expect(session.read).not.toHaveBeenCalled();
  expect(session.close).toHaveBeenCalledOnce();
  expect(monitor.status).toEqual({ phase: "error", reason: "cleanup" });
  await monitor.stop();
});

it.each(["timeout", "stop"])(
  "finishes %s with a permanently pending provider open",
  async (mode) => {
    const { monitor, open, session } = setup();
    open.mockImplementationOnce(() => new Promise(() => {}));
    const start = vi.fn();
    void monitor.start().then(start);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = vi.fn();
    if (mode === "stop") void monitor.stop().then(stopped);
    await vi.advanceTimersByTimeAsync(mode === "stop" ? 17_000 : 47_000);
    expect(start).toHaveBeenCalledOnce();
    if (mode === "stop") expect(stopped).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0].aborted).toBe(true);
    expect(monitor.status).toEqual({ phase: "error", reason: "cleanup" });
    await monitor.stop();
    await monitor.start();
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(300000);
    expect(open).toHaveBeenCalledOnce();
    expect(session.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not open another provider when shutdown cannot verify cleanup", async () => {
  const { monitor, session, open, fail } = setup();
  await monitor.start();
  session.close.mockRejectedValue(new Error("private details"));
  fail();
  await vi.advanceTimersByTimeAsync(300000);
  expect(monitor.status).toMatchObject({ phase: "stale", reason: "cleanup" });
  await monitor.stop();
  await monitor.start();
  await monitor.refresh();
  expect(monitor.status).toEqual({ phase: "error", reason: "cleanup" });
  expect(open).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("retires malformed provider results, suppresses old notifications and respects the retry delay", async () => {
  const { monitor, session, open, update } = setup();
  await monitor.start();
  session.read.mockImplementationOnce(async () => parseRateLimitsResponse({}));
  await monitor.refresh();
  expect(monitor.status).toMatchObject({ phase: "stale", snapshot: data });
  update();
  await monitor.refresh();
  expect(open).toHaveBeenCalledOnce();
  await monitor.stop();
});

it("keeps shutdown idempotent while an in-progress open relinquishes ownership", async () => {
  const { monitor, session, open } = setup();
  let complete!: (value: typeof session) => void;
  open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  void monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopped = monitor.stop();
  expect(monitor.stop()).toBe(stopped);
  expect(monitor.start()).toBe(stopped);
  expect(open.mock.calls[0]?.[0].aborted).toBe(true);
  complete(session);
  await stopped;
  expect(session.read).not.toHaveBeenCalled();
  expect(session.close).toHaveBeenCalledOnce();
  expect(monitor.status.phase).toBe("disconnected");
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for cleanup to finish, then starts the retry delay", async () => {
  const { monitor, session, open, fail } = setup();
  await monitor.start();
  let release!: () => void;
  session.close.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fail();
  await vi.advanceTimersByTimeAsync(60000);
  expect(monitor.status.phase).toBe("stale");
  expect(open).toHaveBeenCalledOnce();
  open.mockResolvedValue(fixture().session);
  release();
  await vi.advanceTimersByTimeAsync(1999);
  expect(open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(open).toHaveBeenCalledTimes(2);
  await monitor.stop();
});
