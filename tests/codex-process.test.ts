import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  discoverCodex,
  isLocalAbsolute,
  launchVerifiedCodex,
  type CodexChild,
} from "../src/main/codex/process";

const image = "C:\\Program Files\\OpenAI\\Codex\\bin\\codex.exe";
const trusted = {
  path: image,
  signature: "Valid",
  publisher: "OpenAI OpCo, LLC",
};
const pathEnv = "C:\\Program Files\\OpenAI\\Codex\\bin";
const discovery = (path = pathEnv) => ({
  env: { Path: path },
  arch: "x64",
  cwd: "C:\\work",
  list: async () => [],
  resolve: vi.fn(async (candidate: string): Promise<string | undefined> =>
    candidate.toLowerCase() === image.toLowerCase() ? image : undefined,
  ),
});

class TestChild extends EventEmitter implements CodexChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => {
    this.signalCode = "SIGTERM";
    this.emit("exit", null, "SIGTERM");
    this.emit("close", null, "SIGTERM");
    return true;
  });
}

function setup() {
  const child = new TestChild();
  const lease = {
    evidence: trusted,
    matches: vi.fn<(pid: number) => Promise<boolean>>(async () => true),
    close: vi.fn(async () => {}),
  };
  const deps = {
    verify: vi.fn<(path: string) => Promise<typeof lease>>(async () => lease),
    spawn: vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }),
    env: { USERPROFILE: "C:\\Users\\Example", OPENAI_API_KEY: "fixture-only" },
  };
  return { child, lease, deps };
}

afterEach(() => vi.useRealTimers());

it.each([
  "C:\\test\\..\\codex.exe",
  "C:\\test\\NUL.exe",
  "C:\\test\\codex.exe:alternate",
  "C:\\test\\codex.exe ",
  "\\\\?\\C:\\test\\codex.exe",
  "C:/test/codex.exe",
])("rejects unsafe path syntax %s", (path) => {
  expect(isLocalAbsolute(path)).toBe(false);
});

it("finds a canonical local native path and rejects unsafe PATH entries", async () => {
  const input = discovery(
    `.;relative;C:drive-relative;\\\\server\\share;C:\\work;${pathEnv}`,
  );
  expect(await discoverCodex(input)).toEqual([image]);
  expect(input.resolve.mock.calls).toHaveLength(3);
  expect(
    input.resolve.mock.calls.every(([path]) => path.startsWith(pathEnv + "\\")),
  ).toBe(true);
});

it("rejects a missing or redirected executable", async () => {
  const input = discovery();
  input.resolve.mockResolvedValue("C:\\elsewhere\\codex.exe");
  expect(await discoverCodex(input)).toEqual([]);
  await expect(launchVerifiedCodex([], setup().deps)).rejects.toThrow(
    /not found/i,
  );
});

it.each([
  ["arm64", "aarch64-pc-windows-msvc"],
  ["ia32", null],
])(
  "discovers supported desktop and npm install layouts on %s",
  async (arch, target) => {
    const local = "C:\\Users\\Fixture\\AppData\\Local";
    const roaming = "C:\\Users\\Fixture\\AppData\\Roaming";
    const programs = "C:\\Program Files";
    const vendorRoot = `${roaming}\\npm\\node_modules\\@openai\\codex-win32-${arch}`;
    const result = await discoverCodex({
      env: {
        PATH: "C:\\tools",
        LOCALAPPDATA: local,
        APPDATA: roaming,
        ProgramFiles: programs,
      },
      cwd: "C:\\work",
      arch,
      list: async () => ["invalid-revision", "abcd1234"],
      resolve: async (path) => path,
    });
    expect(result).toContain(
      `${local}\\OpenAI\\Codex\\bin\\abcd1234\\codex.exe`,
    );
    expect(result).toContain(`${programs}\\OpenAI\\Codex\\bin\\codex.exe`);
    expect(result).toContain("C:\\tools\\codex.exe");
    expect(result.some((path) => path.includes("invalid-revision"))).toBe(
      false,
    );
    if (target)
      expect(result).toContain(
        `${vendorRoot}\\vendor\\${target}\\bin\\codex.exe`,
      );
    else
      expect(result.some((path) => path.includes("node_modules"))).toBe(false);
  },
);

it("does not inspect nonnative or relative candidates", async () => {
  const { deps } = setup();
  await expect(
    launchVerifiedCodex(["codex.exe", "C:\\tools\\codex.cmd"], deps),
  ).rejects.toThrow(/trust/);
  expect(deps.verify).not.toHaveBeenCalled();
  expect(deps.spawn).not.toHaveBeenCalled();
});

it.each([
  { ...trusted, signature: "UnknownError" },
  { ...trusted, publisher: "Other Publisher" },
  { ...trusted, path: "C:\\elsewhere\\codex.exe" },
])(
  "rejects untrusted executable evidence before spawning",
  async (evidence) => {
    const { deps, lease } = setup();
    deps.verify.mockResolvedValue({ ...lease, evidence });
    await expect(launchVerifiedCodex([image], deps)).rejects.toThrow(/trust/i);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledOnce();
  },
);

it("fails closed on verifier failure", async () => {
  const { deps } = setup();
  deps.verify.mockRejectedValue(new Error("private path or timeout"));
  await expect(launchVerifiedCodex([image], deps)).rejects.toThrow(
    "Codex executable trust could not be established",
  );
  expect(deps.spawn).not.toHaveBeenCalled();
});

it("starts only the verified image with fixed arguments and a minimal environment", async () => {
  const { deps, child, lease } = setup();
  const running = await launchVerifiedCodex([image], {
    ...deps,
    env: { ...deps.env, CODEX_ARGS: "-c features.plugins=true" },
  });
  expect(deps.spawn).toHaveBeenCalledExactlyOnceWith(
    image,
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "features.plugins=false",
      "-c",
      "analytics.enabled=false",
      "-c",
      'otel.exporter="none"',
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
    ],
    expect.objectContaining({
      shell: false,
      cwd: "C:\\Windows\\System32",
      windowsHide: true,
      env: {
        USERPROFILE: "C:\\Users\\Example",
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
      },
    }),
  );
  expect(lease.matches).toHaveBeenCalledExactlyOnceWith(child.pid);
  expect(lease.close).toHaveBeenCalledOnce();
  const closing = running.shutdown();
  expect(running.shutdown()).toBe(closing);
  await closing;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.eventNames()).toEqual([]);
  expect(child.stdin.destroyed).toBe(true);
});

it("kills a process whose launched image does not match", async () => {
  const { deps, child, lease } = setup();
  lease.matches.mockResolvedValue(false);
  await expect(launchVerifiedCodex([image], deps)).rejects.toThrow(/image/i);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.eventNames()).toEqual([]);
  expect(lease.close).toHaveBeenCalledOnce();
});

it("cleans up when spawn fails or the process exits", async () => {
  const { deps, child } = setup();
  deps.spawn.mockImplementationOnce(() => {
    child.pid = undefined;
    queueMicrotask(() =>
      child.emit("error", new Error("fixture startup failure")),
    );
    return child;
  });
  await expect(launchVerifiedCodex([image], deps)).rejects.toThrow(/start/i);
  expect(child.eventNames()).toEqual([]);

  const next = setup();
  const running = await launchVerifiedCodex([image], next.deps);
  next.child.exitCode = 7;
  next.child.emit("exit", 7, null);
  next.child.emit("close", 7, null);
  await running.shutdown();
  expect(next.child.kill).not.toHaveBeenCalled();
  expect(next.child.eventNames()).toEqual([]);
});

it("handles a synchronous spawn error and releases the lease", async () => {
  const { deps, lease } = setup();
  deps.spawn.mockImplementation(() => {
    throw new Error("private details");
  });
  await expect(launchVerifiedCodex([image], deps)).rejects.toThrow(
    "Codex process could not start",
  );
  expect(lease.close).toHaveBeenCalledOnce();
});

it("cleans up if the verification lease fails after the child starts", async () => {
  const { deps, child, lease } = setup();
  lease.close.mockRejectedValueOnce(new Error("private verifier detail"));
  await expect(launchVerifiedCodex([image], deps)).rejects.toThrow("cleanup");
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.eventNames()).toEqual([]);
});

it("bounds forced shutdown when a process fails to close", async () => {
  vi.useFakeTimers();
  const { deps, child } = setup();
  child.kill.mockReturnValue(false);
  const running = await launchVerifiedCodex([image], deps);
  const rejected = expect(running.shutdown()).rejects.toThrow(
    "Codex process did not close",
  );
  await vi.advanceTimersByTimeAsync(5_250);
  await rejected;
  expect(child.eventNames()).toEqual([]);
  expect(child.stdout.destroyed).toBe(true);
});

it.each([false, true])(
  "reaps a child that has not emitted spawn (cancel=%s)",
  async (cancel) => {
    vi.useFakeTimers();
    const { deps, child, lease } = setup();
    deps.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const result = expect(
      launchVerifiedCodex([image], deps, controller.signal),
    ).rejects.toThrow(cancel ? "cancelled" : "timeout");
    await vi.advanceTimersByTimeAsync(0);
    if (cancel) controller.abort(new Error("cancelled"));
    else await vi.advanceTimersByTimeAsync(5_000);
    await result;
    child.emit("spawn");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(lease.matches).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledOnce();
  },
);

it("withholds a verified child when cancellation occurs while closing the verifier", async () => {
  vi.useFakeTimers();
  const { deps, child, lease } = setup();
  let closed!: () => void;
  lease.close.mockReturnValue(
    new Promise<void>((resolve) => {
      closed = resolve;
    }),
  );
  const controller = new AbortController();
  const result = expect(
    launchVerifiedCodex([image], deps, controller.signal),
  ).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(0);
  expect(lease.close).toHaveBeenCalledOnce();
  controller.abort(new Error("cancelled"));
  closed();
  await vi.advanceTimersByTimeAsync(250);
  await result;
  expect(child.kill).toHaveBeenCalledOnce();
});
