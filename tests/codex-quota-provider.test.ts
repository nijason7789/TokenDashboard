import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexQuotaProvider } from "../src/main/codex/quota-provider";
import { QuotaProviderError } from "../src/main/services/quota-provider";

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signalCode = null;
  pid = 1;
  kill = vi.fn(() => true);
  requests: string[] = [];
  account: "chatgpt" | "apiKey" | null = "chatgpt";
  stall = false;
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      const request = JSON.parse(chunk.toString());
      this.requests.push(request.method);
      let result: unknown;
      if (request.method === "initialize")
        result = {
          userAgent: "fixture",
          codexHome: "C:\\fixture",
          platformFamily: "windows",
          platformOs: "windows",
        };
      if (request.method === "account/read")
        result = {
          account: this.account && {
            type: this.account,
            email: null,
            planType: "plus",
            workspaceName: null,
          },
          userId: null,
          requiresOpenaiAuth: true,
        };
      if (request.method === "account/rateLimits/read")
        result = {
          rateLimits: { limitId: "codex", primary: null, secondary: null },
          rateLimitsByLimitId: null,
        };
      if (request.id !== undefined && !this.stall)
        queueMicrotask(() => this.reply({ id: request.id, result }));
      done();
    },
  });
  reply(value: unknown) {
    this.stdout.write(JSON.stringify(value) + "\n");
  }
}

function fixture() {
  const child = new Child();
  const shutdown = vi.fn(async () => {});
  const launch = vi.fn(async () => ({ child, shutdown }));
  const provider = createCodexQuotaProvider(launch);
  return { child, shutdown, launch, provider };
}

afterEach(() => vi.useRealTimers());

it("adapts the fixed M2 methods and cleans up subscriptions on duplicate close", async () => {
  const { child, shutdown, provider } = fixture();
  const session = await provider.open(new AbortController().signal);
  const update = vi.fn();
  const failure = vi.fn();
  const unsubscribe = session.subscribe(update, failure);
  child.reply({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: { limitId: "codex", primary: null, secondary: null },
    },
  });
  expect(update).toHaveBeenCalledOnce();
  expect((await session.read()).defaultSelection).toEqual({
    state: "selected",
    bucketId: "codex",
  });
  expect(child.requests).toEqual([
    "initialize",
    "initialized",
    "account/read",
    "account/rateLimits/read",
  ]);
  unsubscribe();
  await session.close();
  await session.close();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(child.stdout.listenerCount("data")).toBe(0);
  expect(child.listenerCount("exit")).toBe(0);
  expect(failure).not.toHaveBeenCalled();
  await expect(session.read()).rejects.toThrow();
  expect(() => session.subscribe(update, failure)).toThrow();
});

it("reports idle malformed messages and process failure once", async () => {
  const { child, provider } = fixture();
  const session = await provider.open(new AbortController().signal);
  const failed = vi.fn();
  session.subscribe(vi.fn(), failed);
  child.stdout.write("{broken\n");
  expect(failed).toHaveBeenCalledOnce();
  await expect(session.read()).rejects.toThrow();
  await session.close();
});

it("isolates throwing subscribers and removes each subscription", async () => {
  const { child, provider } = fixture();
  const session = await provider.open(new AbortController().signal);
  const update = vi.fn(() => {
    throw new Error("observer");
  });
  const failure = vi.fn(() => {
    throw new Error("observer");
  });
  const remove = session.subscribe(update, failure);
  child.reply({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: { limitId: "codex", primary: null, secondary: null },
    },
  });
  expect(update).toHaveBeenCalledOnce();
  child.stdout.write("{broken\n");
  expect(failure).toHaveBeenCalledOnce();
  remove();
  await session.close();
});

it("filters other buckets and suppresses repeated identical notifications per session", async () => {
  const { child, provider } = fixture();
  const session = await provider.open(new AbortController().signal);
  const update = vi.fn();
  session.subscribe(update, vi.fn());
  const notify = (limitId: string | null, usedPercent = 0) =>
    child.reply({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId,
          primary: { windowDurationMins: 300, resetsAt: null, usedPercent },
          secondary: null,
        },
      },
    });
  notify("other");
  expect(update).not.toHaveBeenCalled();
  notify("codex");
  notify("codex");
  expect(update).toHaveBeenCalledTimes(1);
  notify(null);
  notify(null);
  expect(update).toHaveBeenCalledTimes(2);
  notify("codex", 20);
  expect(update).toHaveBeenCalledTimes(3);
  await session.close();
});

it("caps session subscriptions", async () => {
  const { provider } = fixture();
  const session = await provider.open(new AbortController().signal);
  for (let count = 0; count < 16; count++) session.subscribe(vi.fn(), vi.fn());
  expect(() => session.subscribe(vi.fn(), vi.fn())).toThrow();
  await session.close();
});

it("rejects unsupported account types without reading quota", async () => {
  const { child, provider, shutdown } = fixture();
  child.account = "apiKey";
  await expect(
    provider.open(new AbortController().signal),
  ).rejects.toMatchObject({ reason: "unsupported", retryable: false });
  expect(child.requests).not.toContain("account/rateLimits/read");
  expect(shutdown).toHaveBeenCalledOnce();
});

it("preserves classified launcher errors and sanitizes unclassified trust failures", async () => {
  const classified = new QuotaProviderError("unavailable", true);
  const provider = createCodexQuotaProvider(
    vi.fn().mockRejectedValue(classified),
  );
  await expect(provider.open(new AbortController().signal)).rejects.toBe(
    classified,
  );
  const unclassified = createCodexQuotaProvider(
    vi.fn().mockRejectedValue(new Error("private details")),
  );
  await expect(
    unclassified.open(new AbortController().signal),
  ).rejects.toMatchObject({ reason: "trust", retryable: false });
});

it("closes a session whose handshake times out", async () => {
  vi.useFakeTimers();
  const { child, provider, shutdown } = fixture();
  child.stall = true;
  const failure = expect(
    provider.open(new AbortController().signal),
  ).rejects.toMatchObject({ reason: "timeout", retryable: true });
  await vi.advanceTimersByTimeAsync(10_000);
  await failure;
  expect(shutdown).toHaveBeenCalledOnce();
  expect(child.stdout.listenerCount("data")).toBe(0);
});

it("rejects a timed-out read and closes all pending transport work on cancellation", async () => {
  vi.useFakeTimers();
  const { child, provider, shutdown } = fixture();
  const cancel = new AbortController();
  const session = await provider.open(cancel.signal);
  child.stall = true;
  const failed = vi.fn();
  session.subscribe(vi.fn(), failed);
  const rejected = expect(session.read()).rejects.toMatchObject({
    reason: "transport",
    retryable: true,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(failed).toHaveBeenCalledOnce();
  cancel.abort();
  await session.close();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects unauthenticated status without reading quota", async () => {
  const { child, provider, shutdown } = fixture();
  child.account = null;
  await expect(
    provider.open(new AbortController().signal),
  ).rejects.toMatchObject({ reason: "unauthenticated", retryable: false });
  expect(child.requests).toEqual(["initialize", "initialized", "account/read"]);
  expect(shutdown).toHaveBeenCalledOnce();
});

it("does not launch an already cancelled open and closes a launch resolved after cancellation", async () => {
  const { provider, launch, shutdown } = fixture();
  const aborted = new AbortController();
  aborted.abort();
  await expect(provider.open(aborted.signal)).rejects.toThrow();
  expect(launch).not.toHaveBeenCalled();
  const cancel = new AbortController();
  const pending = provider.open(cancel.signal);
  cancel.abort();
  await expect(pending).rejects.toThrow();
  expect(shutdown).toHaveBeenCalledOnce();
});

it("closes a pending read on abort and surfaces cleanup failures as terminal", async () => {
  const { provider, shutdown } = fixture();
  const cancel = new AbortController();
  const session = await provider.open(cancel.signal);
  shutdown.mockRejectedValueOnce(new Error("private child error"));
  cancel.abort();
  await expect(session.close()).rejects.toMatchObject({
    reason: "cleanup",
    retryable: false,
  });
  expect(shutdown).toHaveBeenCalledOnce();
});

it("cancels a pending handshake and prevents a late reply from issuing account RPC", async () => {
  vi.useFakeTimers();
  const { child, shutdown, provider } = fixture();
  child.stall = true;
  const controller = new AbortController();
  const result = expect(provider.open(controller.signal)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(child.requests).toEqual(["initialize"]);
  controller.abort();
  child.reply({ id: 1, result: {} });
  await result;
  expect(child.requests).toEqual(["initialize"]);
  expect(shutdown).toHaveBeenCalledOnce();
});

it("does not issue RPC if a launcher returns after the overall deadline", async () => {
  vi.useFakeTimers();
  const { child, launch, shutdown, provider } = fixture();
  let finish!: (running: { child: Child; shutdown: typeof shutdown }) => void;
  launch.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const result = expect(
    provider.open(new AbortController().signal),
  ).rejects.toMatchObject({ reason: "timeout" });
  await vi.advanceTimersByTimeAsync(30_000);
  finish({ child, shutdown });
  await result;
  expect(child.requests).toEqual([]);
  expect(shutdown).toHaveBeenCalledOnce();
});

it("quarantines an unresolved launch after the cleanup bound and still reaps its late child", async () => {
  vi.useFakeTimers();
  const { child, launch, shutdown, provider } = fixture();
  let finish!: (running: { child: Child; shutdown: typeof shutdown }) => void;
  launch.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const result = expect(
    provider.open(new AbortController().signal),
  ).rejects.toMatchObject({
    reason: "cleanup",
    retryable: false,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(
    provider.open(new AbortController().signal),
  ).rejects.toMatchObject({
    reason: "unavailable",
  });
  await vi.advanceTimersByTimeAsync(16_000);
  await result;
  await expect(
    provider.open(new AbortController().signal),
  ).rejects.toMatchObject({ reason: "cleanup" });
  expect(launch).toHaveBeenCalledOnce();
  finish({ child, shutdown });
  await vi.advanceTimersByTimeAsync(0);
  expect(shutdown).toHaveBeenCalledOnce();
  expect(child.requests).toEqual([]);
});

it("shares the handshake deadline between initialization and account classification", async () => {
  vi.useFakeTimers();
  const { child, shutdown, provider } = fixture();
  child.stall = true;
  const result = expect(
    provider.open(new AbortController().signal),
  ).rejects.toMatchObject({ reason: "timeout" });
  await vi.advanceTimersByTimeAsync(9_000);
  child.reply({
    id: 1,
    result: {
      userAgent: "fixture",
      codexHome: "C:\\fixture",
      platformFamily: "windows",
      platformOs: "windows",
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(child.requests).toEqual(["initialize", "initialized", "account/read"]);
  await vi.advanceTimersByTimeAsync(1_000);
  await result;
  expect(shutdown).toHaveBeenCalledOnce();
});
