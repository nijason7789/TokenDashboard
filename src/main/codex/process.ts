import { once, type EventEmitter } from "node:events";
import { win32 as windows } from "node:path";
import type { Readable, Writable } from "node:stream";

import { QuotaProviderError } from "../services/quota-provider";
import { startupDeadline, startupLimits } from "./startup-deadline";

export const SYSTEM_ROOT = "C:\\Windows";
export const SYSTEM_DIRECTORY = windows.join(SYSTEM_ROOT, "System32");
export const PUBLISHER = "OpenAI OpCo, LLC";
const args = Object.freeze([
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
]);
const timeoutMs = 5_000;
const graceMs = 250;

export interface CodexChild extends EventEmitter {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(): boolean;
}

interface Discovery {
  env: NodeJS.ProcessEnv;
  cwd: string;
  arch: string;
  list: (path: string) => Promise<string[]>;
  resolve: (path: string) => Promise<string | undefined>;
}

export function isLocalAbsolute(path: string) {
  return (
    /^[a-z]:\\(?:[^<>:"/\\|?*\x00-\x1f]+\\)*[^<>:"/\\|?*\x00-\x1f]+$/i.test(
      path,
    ) &&
    path
      .slice(3)
      .split("\\")
      .every(
        (part) =>
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

export async function discoverCodex({
  env,
  cwd,
  arch,
  list,
  resolve,
}: Discovery) {
  const roots = [
    env.ProgramFiles,
    env.LOCALAPPDATA,
    env.APPDATA,
    env.Path ?? env.PATH,
  ];
  const [programs, local, roaming, path = ""] = roots.map(
    (value) => value ?? "",
  );
  const locations: string[] = [];
  const allowRoot = (value: string) => {
    const base = cwd.toLowerCase().replace(/\\+$/, "");
    const lower = value.toLowerCase();
    return (
      isLocalAbsolute(value) && lower !== base && !lower.startsWith(base + "\\")
    );
  };

  if (local && allowRoot(local)) {
    const bin = windows.join(local, "OpenAI", "Codex", "bin");
    locations.push(windows.join(bin, "codex.exe"));
    for (const revision of (await list(bin))
      .filter((name) => /^[0-9a-f]{8,64}$/i.test(name))
      .sort()
      .reverse()
      .slice(0, 16)) {
      locations.push(windows.join(bin, revision, "codex.exe"));
    }
    locations.push(
      windows.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    );
  }

  if (programs && allowRoot(programs))
    locations.push(
      windows.join(programs, "OpenAI", "Codex", "bin", "codex.exe"),
    );

  const npmRoots = [
    ...(programs && allowRoot(programs)
      ? [windows.join(programs, "nodejs")]
      : []),
    ...(roaming && allowRoot(roaming) ? [windows.join(roaming, "npm")] : []),
  ];
  for (const root of path
    .split(";")
    .map((entry) => entry.trim().replace(/\\+$/, ""))
    .filter(allowRoot)
    .slice(0, 64)) {
    locations.push(windows.join(root, "codex.exe"));
    npmRoots.push(root);
  }

  const target =
    arch === "x64"
      ? "x86_64-pc-windows-msvc"
      : arch === "arm64"
        ? "aarch64-pc-windows-msvc"
        : null;
  if (target) {
    for (const root of npmRoots) {
      for (const prefix of ["", "node_modules\\@openai\\codex\\"]) {
        locations.push(
          windows.join(
            root,
            prefix,
            "node_modules",
            "@openai",
            "codex-win32-" + arch,
            "vendor",
            target,
            "bin",
            "codex.exe",
          ),
        );
      }
    }
  }

  const matches: string[] = [];
  for (const candidate of new Map(
    locations.map((location) => [location.toLowerCase(), location]),
  ).values()) {
    const canonical = await resolve(candidate);
    if (canonical?.toLowerCase() === candidate.toLowerCase())
      matches.push(canonical);
  }

  return matches;
}

interface VerificationLease {
  evidence: { path: string; signature: string; publisher: string };
  matches: (pid: number) => Promise<boolean>;
  close: () => Promise<void>;
}

export interface CodexProcessDependencies {
  env: NodeJS.ProcessEnv;
  verify: (path: string, signal: AbortSignal) => Promise<VerificationLease>;
  spawn: (
    path: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      shell: false;
      windowsHide: true;
      stdio: ["pipe", "pipe", "pipe"];
    },
  ) => CodexChild;
}

export interface RunningCodex {
  child: CodexChild;
  shutdown: () => Promise<void>;
}

function childEnvironment(env: NodeJS.ProcessEnv) {
  const allowed: NodeJS.ProcessEnv = {
    SystemRoot: SYSTEM_ROOT,
    WINDIR: SYSTEM_ROOT,
  };
  for (const key of ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) {
    const value = env[key];
    if (value && isLocalAbsolute(value)) allowed[key] = value;
  }
  return allowed;
}

function monitor(child: CodexChild): RunningCodex {
  const ignoreError = () => {};
  const streams = [child.stdin, child.stdout, child.stderr];
  child.on("error", ignoreError);
  for (const stream of streams) stream.on("error", ignoreError);
  child.stderr.resume();

  let closed = false;
  let resolveClosed!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const cleanup = () => {
    closed = true;
    child.off("close", cleanup);
    child.off("error", ignoreError);
    for (const stream of streams) {
      stream.destroy();
      stream.off("error", ignoreError);
    }
    resolveClosed();
  };
  child.once("close", cleanup);

  async function wait(ms: number) {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        finished.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  let shutdown: Promise<void> | undefined;
  return {
    child,
    shutdown: () =>
      (shutdown ??= (async () => {
        if (closed) return;
        if (child.pid === undefined) {
          cleanup();
          return;
        }
        child.stdin.end();
        if (await wait(graceMs)) return;
        child.kill();
        if (!(await wait(timeoutMs))) {
          cleanup();
          throw new Error("Codex process did not close");
        }
      })()),
  };
}

export async function launchVerifiedCodex(
  candidates: readonly string[],
  dependencies: CodexProcessDependencies,
  signal = new AbortController().signal,
): Promise<RunningCodex> {
  signal.throwIfAborted();
  if (candidates.length === 0) throw new Error("Codex executable not found");

  for (const candidate of candidates) {
    if (
      !isLocalAbsolute(candidate) ||
      windows.basename(candidate).toLowerCase() !== "codex.exe"
    )
      continue;
    let lease: VerificationLease;
    try {
      lease = await dependencies.verify(candidate, signal);
    } catch (error) {
      if (error instanceof QuotaProviderError) throw error;
      signal.throwIfAborted();
      continue;
    }

    let running: RunningCodex | undefined;
    let started = false;
    try {
      signal.throwIfAborted();
      if (
        lease.evidence.path.toLowerCase() !== candidate.toLowerCase() ||
        lease.evidence.signature !== "Valid" ||
        lease.evidence.publisher !== PUBLISHER
      )
        continue;

      const child = dependencies.spawn(candidate, args, {
        cwd: SYSTEM_DIRECTORY,
        env: childEnvironment(dependencies.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      running = monitor(child);
      const spawn = startupDeadline(signal, startupLimits.spawn);
      try {
        await once(child, "spawn", { signal: spawn.signal });
      } catch (error) {
        spawn.signal.throwIfAborted();
        throw error;
      } finally {
        spawn.clear();
      }
      started = true;
      if (
        !child.pid ||
        !(await lease.matches(child.pid)) ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error("Launched image did not match");
      }
      signal.throwIfAborted();
    } catch (error) {
      if (running) {
        // Reject a mismatched image immediately, without writing anything to its stdin.
        if (
          running.child.exitCode === null &&
          running.child.signalCode === null
        )
          running.child.kill();
        await running.shutdown().catch(() => {
          throw new QuotaProviderError("cleanup", false);
        });
      }
      if (error instanceof QuotaProviderError) throw error;
      signal.throwIfAborted();
      throw new Error(
        started
          ? "Codex process image could not be verified"
          : "Codex process could not start",
      );
    } finally {
      try {
        await lease.close();
      } catch {
        if (running) await running.shutdown().catch(() => {});
        throw new QuotaProviderError("cleanup", false);
      }
    }
    if (running) {
      if (signal.aborted) {
        await running.shutdown().catch(() => {
          throw new QuotaProviderError("cleanup", false);
        });
        signal.throwIfAborted();
      }
      return running;
    }
  }

  throw new Error("Codex executable trust could not be established");
}
