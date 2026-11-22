import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexTransport, validateOutbound } from "../src/main/codex/transport";

class MockProcess extends EventEmitter {
  stdout = new PassThrough();
  sent: Record<string, unknown>[] = [];
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      this.sent.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  reply(message: unknown) {
    this.stdout.write(JSON.stringify(message) + "\n");
  }
}

const init = {
  userAgent: "mock/1",
  codexHome: "C:\\mock",
  platformFamily: "windows",
  platformOs: "windows",
};
const limits = {
  rateLimits: { limitId: "codex", primary: null, secondary: null },
  rateLimitsByLimitId: null,
};
const emptyBucket = {
  bucketId: "codex",
  windows: [],
  fiveHour: { state: "missing" },
  weekly: { state: "missing" },
};
const snapshot = {
  buckets: [{ ...emptyBucket, source: "legacy" }],
  defaultSelection: { state: "selected", bucketId: "codex" },
};
async function ready() {
  const child = new MockProcess();
  const transport = new CodexTransport(child);
  const promise = transport.initialize();
  child.reply({ id: 1, result: init });
  await promise;
  return { child, transport };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("read-only stdio transport", () => {
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { timeoutMs: 1.5 },
    { maxMessageBytes: 0 },
    { maxMessageBytes: 1_048_577 },
    { maxMessageBytes: NaN },
  ])("rejects unsafe resource limits before attaching listeners", (options) => {
    const child = new MockProcess();
    expect(() => new CodexTransport(child, options)).toThrow(
      "Invalid transport limits",
    );
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("limits notification subscribers and rejects subscriptions after close", async () => {
    const { transport } = await ready();
    for (let i = 0; i < 16; i++) transport.subscribeRateLimits(() => {});
    expect(() => transport.subscribeRateLimits(() => {})).toThrow();
    transport.close();
    expect(() => transport.subscribeRateLimits(() => {})).toThrow();
  });

  it("closes safely when writing fails", async () => {
    const child = new MockProcess();
    child.stdin.write = () => {
      throw new Error("sensitive");
    };
    const transport = new CodexTransport(child);
    await expect(transport.initialize()).rejects.toThrow(
      "Invalid server message",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { account: null, userId: null, requiresOpenaiAuth: true },
    {
      account: { type: "apiKey" },
      userId: "fixture",
      requiresOpenaiAuth: false,
    },
    {
      account: {
        type: "chatgpt",
        email: "fixture@example.invalid",
        planType: "plus",
        workspaceName: "fixture",
      },
      userId: null,
      requiresOpenaiAuth: true,
    },
  ])("reduces account metadata to a status enum", async (result) => {
    const { child, transport } = await ready();
    const pending = transport.readAccount();
    child.reply({ id: 2, result });
    await expect(pending).resolves.toBe(
      result.account === null
        ? "unauthenticated"
        : result.account.type === "chatgpt"
          ? "chatgpt"
          : "unsupported",
    );
    transport.close();
  });

  it.each([
    null,
    {},
    { account: null, userId: null, requiresOpenaiAuth: "yes" },
    { account: { type: "future" }, userId: null, requiresOpenaiAuth: true },
    { account: {}, userId: null, requiresOpenaiAuth: true },
    { account: 1, userId: null, requiresOpenaiAuth: true },
    {
      account: {
        type: "chatgpt",
        email: 1,
        planType: "plus",
        workspaceName: null,
      },
      userId: null,
      requiresOpenaiAuth: true,
    },
    {
      account: {
        type: "chatgpt",
        email: null,
        planType: null,
        workspaceName: null,
      },
      userId: null,
      requiresOpenaiAuth: true,
    },
    {
      account: {
        type: "chatgpt",
        email: null,
        planType: "plus",
        workspaceName: 1,
      },
      userId: null,
      requiresOpenaiAuth: true,
    },
  ])("rejects malformed account response", async (result) => {
    const { child, transport } = await ready();
    const pending = transport.readAccount();
    const assertion = expect(pending).rejects.toThrow();
    child.reply({ id: 2, result });
    await assertion;
  });

  it.each([
    null,
    {},
    { ...init, userAgent: null },
    { ...init, codexHome: null },
    { ...init, platformFamily: "unix" },
    { ...init, platformOs: "linux" },
  ])("rejects malformed or unsupported initialization", async (result) => {
    const child = new MockProcess();
    const transport = new CodexTransport(child);
    const pending = transport.initialize();
    const assertion = expect(pending).rejects.toThrow();
    child.reply({ id: 1, result });
    await assertion;
    expect(child.sent).toHaveLength(1);
  });

  it("rejects runtime caller arguments without sending them", async () => {
    const { child, transport } = await ready();
    await expect(
      Reflect.apply(transport.readAccount, transport, [{ refreshToken: true }]),
    ).rejects.toThrow();
    await expect(
      Reflect.apply(transport.readRateLimits, transport, [
        { supportsLunaReserve: true },
      ]),
    ).rejects.toThrow();
    expect(child.sent).toHaveLength(2);
    transport.close();
  });
  it("handshakes then reads account and limits with fixed parameters", async () => {
    const { child, transport } = await ready();
    expect(child.sent).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex_quota_monitor",
            title: "Codex Quota Monitor",
            version: "0.1.0",
          },
          capabilities: null,
        },
      },
      { method: "initialized" },
    ]);
    const account = transport.readAccount();
    expect(child.sent[2]).toEqual({
      id: 2,
      method: "account/read",
      params: { refreshToken: false },
    });
    child.reply({
      id: 2,
      result: {
        account: {
          type: "chatgpt",
          email: null,
          planType: "plus",
          workspaceName: null,
        },
        userId: null,
        requiresOpenaiAuth: true,
      },
    });
    expect(await account).toBe("chatgpt");
    const result = transport.readRateLimits();
    expect(child.sent[3]).toEqual({
      id: 3,
      method: "account/rateLimits/read",
      params: { excludeResetCreditDetails: true },
    });
    child.reply({ id: 3, result: limits });
    expect(await result).toEqual(snapshot);
    transport.close();
  });

  it("handles partial UTF-8 and multiple messages while ignoring unknown and duplicate IDs", async () => {
    const { child, transport } = await ready();
    const result = transport.readRateLimits();
    const bytes = Buffer.from(
      JSON.stringify({ id: 2, result: { ...limits, label: "額度" } }) + "\n",
    );
    const split = bytes.indexOf(Buffer.from("額")) + 1;
    child.stdout.write(bytes.subarray(0, split));
    child.stdout.write(bytes.subarray(split));
    await expect(result).resolves.toEqual(snapshot);
    child.stdout.write('{"id":2,"result":null}\n{"id":999,"result":null}\n');
    const next = transport.readRateLimits();
    child.reply({ id: 3, result: limits });
    await expect(next).resolves.toEqual(snapshot);
    transport.close();
  });

  it("supports notifications and unsubscribing", async () => {
    const { child, transport } = await ready();
    const notify = vi.fn();
    const off = transport.subscribeRateLimits(notify);
    child.stdout.write(
      JSON.stringify({ method: "unknown", params: {} }) +
        "\n" +
        JSON.stringify({
          method: "account/rateLimits/updated",
          params: limits,
        }) +
        "\n",
    );
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      ...emptyBucket,
      source: "notification",
    });
    off();
    child.reply({ method: "account/rateLimits/updated", params: limits });
    expect(notify).toHaveBeenCalledTimes(1);
    transport.close();
  });

  it("rejects reads before initialization and duplicate initialization", async () => {
    const child = new MockProcess();
    const transport = new CodexTransport(child);
    await expect(transport.readAccount()).rejects.toThrow();
    const pending = transport.initialize();
    await expect(transport.initialize()).rejects.toThrow();
    child.reply({ id: 1, result: init });
    await pending;
    await expect(transport.initialize()).rejects.toThrow();
    expect(child.sent).toHaveLength(2);
    transport.close();
  });

  it.each([
    "null\n",
    "[]\n",
    "{}\n",
    '{"id":null,"result":null}\n',
    '{"method":1}\n',
    '{"id":2,"error":null}\n',
    "bad json\n",
    '{"id":2,"result":null}\n',
    '{"id":2,"result":{},"error":{"code":1,"message":"secret"}}\n',
    '{"id":2,"error":{"code":"bad","message":"secret"}}\n',
    '{"method":"exec","id":5,"params":{"command":"danger"}}\n',
    '{"method":"account/rateLimits/updated","params":null}\n',
  ])(
    "fails closed on malformed or unexpected server input %s",
    async (chunk) => {
      const { child, transport } = await ready();
      const pending = transport.readRateLimits();
      const assertion = expect(pending).rejects.toThrow();
      child.stdout.write(chunk);
      await assertion;
      expect(child.sent).toHaveLength(3);
      await expect(transport.readRateLimits()).rejects.toThrow();
    },
  );

  it.each(["exit", "error", "stdout-error", "stdin-error", "end"])(
    "cleans pending on %s",
    async (event) => {
      const { child, transport } = await ready();
      const pending = transport.readAccount();
      const assertion = expect(pending).rejects.toThrow();
      if (event === "stdout-error")
        child.stdout.emit("error", new Error("secret"));
      else if (event === "stdin-error")
        child.stdin.emit("error", new Error("secret"));
      else if (event === "end") child.stdout.emit("end");
      else child.emit(event, new Error("secret"));
      await assertion;
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      transport.close();
    },
  );

  it("times out then ignores a late response", async () => {
    const { child, transport } = await ready();
    const pending = transport.readAccount();
    const assertion = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    child.reply({ id: 2, result: {} });
    const next = transport.readRateLimits();
    child.reply({ id: 3, result: limits });
    await expect(next).resolves.toEqual(snapshot);
    transport.close();
  });

  it("enforces a pending limit without sending rejected requests", async () => {
    const { child, transport } = await ready();
    const pending = transport.readRateLimits();
    await expect(transport.readAccount()).rejects.toThrow(
      "Pending request limit",
    );
    expect(child.sent).toHaveLength(3);
    child.reply({ id: 2, result: limits });
    await pending;
    transport.close();
  });

  it("rejects an oversized frame before a newline", async () => {
    const child = new MockProcess();
    const transport = new CodexTransport(child, { maxMessageBytes: 128 });
    const pending = transport.initialize();
    const assertion = expect(pending).rejects.toThrow("Invalid server message");
    child.stdout.write(Buffer.alloc(129, 32));
    await assertion;
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("rejects invalid UTF-8 instead of replacing bytes", async () => {
    const { child, transport } = await ready();
    const pending = transport.readRateLimits();
    const assertion = expect(pending).rejects.toThrow("Invalid server message");
    child.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
    await assertion;
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("rejects handshake errors and redacts server messages", async () => {
    const child = new MockProcess();
    const transport = new CodexTransport(child);
    const pending = transport.initialize();
    const assertion = expect(pending).rejects.toThrow(
      "Server rejected request",
    );
    child.reply({ id: 1, error: { code: 1, message: "sensitive" } });
    await assertion;
    await expect(transport.readAccount()).rejects.toThrow();
    expect(child.sent).toHaveLength(1);
  });

  it.each([
    ["thread/start", {}],
    ["account/read", { refreshToken: true }],
    ["account/read", { refreshToken: false, command: "exec" }],
    ["account/rateLimits/read", { supportsLunaReserve: true }],
    ["initialized", {}],
    ["initialize", { capabilities: { experimentalApi: true } }],
  ])("rejects outbound method and parameter violations", (method, params) => {
    expect(() => validateOutbound(method, params)).toThrow(
      "Unauthorized outbound request",
    );
  });
});
