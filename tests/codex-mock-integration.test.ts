import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { launchVerifiedCodex, PUBLISHER } from "../src/main/codex/process";
import { createCodexQuotaProvider } from "../src/main/codex/quota-provider";
import { CodexTransport } from "../src/main/codex/transport";
import { QuotaMonitor } from "../src/main/services/quota-monitor";

const fixture = fileURLToPath(
  new URL("./fixtures/mock-app-server.mjs", import.meta.url),
);
const image = "C:\\fixture\\codex.exe";

function launchFixture(scenario: string) {
  return launchVerifiedCodex([image], {
    env: {},
    verify: async () => ({
      evidence: { path: image, publisher: PUBLISHER, signature: "Valid" },
      matches: async () => true,
      close: async () => {},
    }),
    spawn: () =>
      spawn(process.execPath, [fixture, scenario], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
  });
}

async function startFixture(scenario = "normal", timeoutMs?: number) {
  const processOwner = await launchFixture(scenario);
  const transport = new CodexTransport(processOwner.child, { timeoutMs });
  const close = async () => {
    transport.close();
    await processOwner.shutdown();
    expect(
      processOwner.child.exitCode !== null ||
        processOwner.child.signalCode !== null,
    ).toBe(true);
    expect(processOwner.child.eventNames()).toEqual([]);
  };
  try {
    await transport.initialize();
    return { transport, close };
  } catch (error) {
    await close();
    throw error;
  }
}

it("exchanges schema-shaped messages with an isolated child and shuts it down", async () => {
  const { transport, close } = await startFixture();
  try {
    const updated = vi.fn();
    transport.subscribeRateLimits(updated);
    expect(await transport.readAccount()).toBe("chatgpt");
    const snapshot = await transport.readRateLimits();
    expect(snapshot.defaultSelection).toEqual({
      state: "selected",
      bucketId: "codex",
    });
    expect(snapshot.buckets[0]?.fiveHour).toMatchObject({
      state: "available",
      window: { remainingPercent: 77 },
    });
    await vi.waitFor(() =>
      expect(updated).toHaveBeenCalledWith(
        expect.objectContaining({ bucketId: "codex" }),
      ),
    );
  } finally {
    await close();
  }
});

it.each(["malformed", "exit"])(
  "cleans up the isolated child after %s",
  async (scenario) => {
    const { transport, close } = await startFixture(scenario);
    try {
      await expect(transport.readRateLimits()).rejects.toThrow();
    } finally {
      await close();
    }
  },
);

it("retires the timed-out child before a fresh handshake and quota read", async () => {
  const stalled = await startFixture("stall", 1_500);
  try {
    await expect(stalled.transport.readRateLimits()).rejects.toThrow(
      "Request timed out",
    );
  } finally {
    await stalled.close();
  }
  await expect(stalled.transport.readRateLimits()).rejects.toThrow(
    "Transport unavailable",
  );

  const fresh = await startFixture();
  try {
    const snapshot = await fresh.transport.readRateLimits();
    expect(snapshot.defaultSelection).toEqual({
      state: "selected",
      bucketId: "codex",
    });
  } finally {
    await fresh.close();
  }
});

it("reaps a crashed mock child before the monitor opens a replacement", async () => {
  const children: Awaited<ReturnType<typeof launchFixture>>["child"][] = [];
  const monitor = new QuotaMonitor(
    createCodexQuotaProvider(async () => {
      const prior = children.at(-1);
      if (prior) {
        expect(prior.exitCode).toBe(7);
        expect(prior.eventNames()).toEqual([]);
      }
      const running = await launchFixture(prior ? "normal" : "exit");
      children.push(running.child);
      return running;
    }),
  );

  try {
    await monitor.start();
    expect(monitor.status).toEqual({ phase: "error", reason: "transport" });
    await vi.waitFor(() => expect(monitor.status.phase).toBe("connected"), {
      timeout: 4500,
    });
    expect(children).toHaveLength(2);
  } finally {
    await monitor.stop();
  }
  expect(children[1]?.exitCode).toBe(0);
  expect(children[1]?.eventNames()).toEqual([]);
});
