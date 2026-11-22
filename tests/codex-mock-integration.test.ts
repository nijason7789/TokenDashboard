import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { launchVerifiedCodex, PUBLISHER } from "../src/main/codex/process";
import { CodexTransport } from "../src/main/codex/transport";

const fixture = fileURLToPath(
  new URL("./fixtures/mock-app-server.mjs", import.meta.url),
);
const image = "C:\\fixture\\codex.exe";

async function startFixture(scenario = "normal") {
  const processOwner = await launchVerifiedCodex([image], {
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
  const transport = new CodexTransport(processOwner.child);
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
