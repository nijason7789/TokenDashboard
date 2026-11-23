import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startWindowsCodex } from "../src/main/codex/windows-process";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  readdir: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({
  lstat: mocks.lstat,
  realpath: mocks.realpath,
  readdir: mocks.readdir,
}));

const image = "C:\\Applications\\codex.exe";
const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const nativePlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(public pid: number) {
    super();
    this.stdin.once("end", () => {
      this.exitCode = 0;
      this.emit("exit", 0);
      this.emit("close", 0);
    });
  }
  kill = vi.fn(() => {
    this.signalCode = "SIGTERM";
    this.emit("close", null, this.signalCode);
    return true;
  });
}

function prepare(reply?: string, match = "matched\r\n") {
  const helper = new Child(1);
  const codex = new Child(2);
  const inputs: string[] = [];
  helper.stdin.on("data", (data: Buffer) => {
    inputs.push(data.toString("utf8").trimEnd());
    if (inputs.length === 1 && reply !== undefined) {
      queueMicrotask(() => helper.stdout.write(reply));
    } else if (inputs.length === 2) {
      queueMicrotask(() => helper.stdout.write(match));
    }
  });
  codex.stdin.resume();
  mocks.spawn.mockImplementation((path: string) => {
    if (path === shell) return helper;
    if (path !== image) throw new Error("Unexpected path");
    queueMicrotask(() => codex.emit("spawn"));
    return codex;
  });
  return { helper, codex, inputs };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", {
    ...nativePlatform,
    value: "win32",
  });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("Path", "C:\\Applications");
  vi.stubEnv("TEMP", "C:\\Temp");
  vi.stubEnv("ProgramFiles", "");
  vi.stubEnv("LOCALAPPDATA", "");
  vi.stubEnv("APPDATA", "");
  mocks.lstat.mockImplementation(async (path: string) => {
    if (path !== "C:\\Applications" && path !== image)
      throw new Error("Missing fixture");
    return { isSymbolicLink: () => false, isFile: () => path === image };
  });
  mocks.realpath.mockResolvedValue(image);
});

afterEach(() => {
  Object.defineProperty(process, "platform", nativePlatform);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("launches the fixed validation helper without a shell and reaps it after matching the PID", async () => {
  const { helper, codex, inputs } = prepare("verified\r\n");
  const running = await startWindowsCodex();
  try {
    expect(mocks.spawn.mock.calls.map(([path]) => path)).toEqual([
      shell,
      image,
    ]);
    expect(mocks.spawn.mock.calls[0]?.[1].slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({
      shell: false,
      windowsHide: true,
    });
    expect(JSON.parse(inputs[0]!)).toEqual({ path: image, arch: process.arch });
    expect(inputs[1]).toBe(String(codex.pid));
    expect(helper.exitCode).toBe(0);
    expect(running.child).toBe(codex);
  } finally {
    await running.shutdown();
  }
});

it("fails closed on an unsupported system root or a junction", async () => {
  vi.stubEnv("SystemRoot", "D:\\Windows");
  await expect(startWindowsCodex()).rejects.toThrow(/unavailable/);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  mocks.lstat.mockResolvedValue({ isSymbolicLink: () => true });
  await expect(startWindowsCodex()).rejects.toThrow(/not found/);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it.each(["wrong\n", "verified\nextra\n"])(
  "rejects verifier output %j before launch",
  async (reply) => {
    const { helper } = prepare(reply);
    await expect(startWindowsCodex()).rejects.toThrow(/trust/);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(helper.exitCode).toBe(0);
  },
);

it("times out the verifier without starting the candidate", async () => {
  vi.useFakeTimers();
  const { helper } = prepare();
  const failure = expect(startWindowsCodex()).rejects.toThrow(/timeout/);
  await vi.advanceTimersByTimeAsync(10_000);
  await failure;
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(helper.exitCode).toBe(0);
});

it("kills the launched candidate on image verification failure", async () => {
  const { helper, codex } = prepare("verified\n", "wrong\n");
  await expect(startWindowsCodex()).rejects.toThrow(/image/);
  expect(codex.kill).toHaveBeenCalledOnce();
  expect(helper.exitCode).toBe(0);
});

it("binds approved mode to one canonical path and sends its SHA-256 only to the verifier", async () => {
  const { inputs } = prepare("verified\r\n");
  const sha256 = "a".repeat(64);
  const running = await startWindowsCodex(undefined, { path: image, sha256 });
  await running.shutdown();
  expect(JSON.parse(inputs[0]!)).toEqual({
    path: image,
    arch: process.arch,
    sha256,
  });
  expect(mocks.readdir).not.toHaveBeenCalled();
});

it("cancels verification before candidate spawn and reaps the helper", async () => {
  vi.useFakeTimers();
  const { helper } = prepare();
  const controller = new AbortController();
  const failure = expect(
    startWindowsCodex(controller.signal),
  ).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  controller.abort();
  await failure;
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(helper.exitCode).toBe(0);
});

it.each([false, true])(
  "reaps a child awaiting process-image verification (cancel=%s)",
  async (cancel) => {
    vi.useFakeTimers();
    const { helper, codex } = prepare("verified\r\n", "");
    const controller = new AbortController();
    const result = expect(startWindowsCodex(controller.signal)).rejects.toThrow(
      cancel ? "cancelled" : "timeout",
    );
    await vi.advanceTimersByTimeAsync(0);
    if (cancel) controller.abort(new Error("cancelled"));
    else await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(codex.kill).toHaveBeenCalledOnce();
    expect(helper.exitCode).toBe(0);
  },
);

it("does not start a verifier after a late discovery result", async () => {
  vi.useFakeTimers();
  let complete!: (value: string) => void;
  mocks.realpath.mockReturnValue(
    new Promise<string>((resolve) => {
      complete = resolve;
    }),
  );
  const result = expect(startWindowsCodex()).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(20_000);
  await result;
  complete(image);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("rejects invalid approved identities and never falls back when the verifier denies a digest", async () => {
  const sha256 = "a".repeat(64);
  await expect(
    startWindowsCodex(undefined, { path: "codex.exe", sha256 }),
  ).rejects.toThrow(/invalid/i);
  await expect(
    startWindowsCodex(undefined, { path: image, sha256: "abcd" }),
  ).rejects.toThrow(/invalid/i);
  expect(mocks.spawn).not.toHaveBeenCalled();

  const { helper, inputs } = prepare("digest rejected\r\n");
  await expect(
    startWindowsCodex(undefined, { path: image, sha256 }),
  ).rejects.toThrow(/trust/);
  expect(mocks.spawn.mock.calls.map(([path]) => path)).toEqual([shell]);
  expect(JSON.parse(inputs[0]!)).toMatchObject({ sha256 });
  expect(helper.exitCode).toBe(0);
  const verifier = Buffer.from(
    mocks.spawn.mock.calls[0]?.[1][4],
    "base64",
  ).toString("utf16le");
  expect(verifier.indexOf("if ($hex -ine $inputData.sha256)")).toBeGreaterThan(
    0,
  );
  expect(verifier.indexOf("if ($hex -ine $inputData.sha256)")).toBeLessThan(
    verifier.indexOf("WriteLine('verified')"),
  );
});
