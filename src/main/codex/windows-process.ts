import { spawn } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { win32 as windows } from "node:path";
import {
  discoverCodex,
  isLocalAbsolute,
  launchVerifiedCodex,
  PUBLISHER,
  SYSTEM_DIRECTORY,
  SYSTEM_ROOT,
} from "./process";

import { QuotaProviderError } from "../services/quota-provider";
import {
  interruptStartup,
  startupDeadline,
  startupLimits,
} from "./startup-deadline";

// Fixed script. Candidate path, architecture and PID are data on stdin.
const verifier = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class QuotaFile {
  [StructLayout(LayoutKind.Sequential)]
  public struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);

  public static Info ReadInfo(SafeFileHandle handle, bool directory) {
    Info info;
    if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) ||
        (info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory) {
      throw new InvalidOperationException("Unsupported path");
    }
    return info;
  }

  public static SafeFileHandle LockDirectory(string path) {
    // Listing access participates in share checks. Attribute-only opens may not hold a share lock.
    var handle = CreateFileW(path, 0x81, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    try { ReadInfo(handle, true); return handle; }
    catch { handle.Dispose(); throw; }
  }

  public static FileStream OpenImage(string path) {
    // Generic read, share read only, open existing without following a reparse point.
    var handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
    try { ReadInfo(handle, false); return new FileStream(handle, FileAccess.Read); }
    catch { handle.Dispose(); throw; }
  }
}
'@
$locked = $null
$directories = [Collections.Generic.List[IDisposable]]::new()
try {
  Add-Type -TypeDefinition $source
  $inputData = [Console]::ReadLine() | ConvertFrom-Json
  $candidate = [string]$inputData.path
  $item = [IO.FileInfo]::new($candidate)
  $root = $item.Directory.Root.FullName
  if ([IO.DriveInfo]::new($root).DriveType -ne 'Fixed') { throw 'drive' }
  $parents = [Collections.Generic.Stack[string]]::new()
  for ($dir = $item.Directory; $null -ne $dir; $dir = $dir.Parent) { $parents.Push($dir.FullName) }
  foreach ($parent in $parents) { $directories.Add([QuotaFile]::LockDirectory($parent)) }
  $locked = [QuotaFile]::OpenImage($candidate)
  $identity = [QuotaFile]::ReadInfo($locked.SafeFileHandle, $false)
  $reader = [IO.BinaryReader]::new($locked)
  if ($locked.Length -lt 88 -or $reader.ReadUInt16() -ne 0x5a4d) { throw 'format' }
  $locked.Position = 60
  $offset = $reader.ReadInt32()
  if ($offset -lt 64 -or $offset -gt ($locked.Length - 24)) { throw 'format' }
  $locked.Position = $offset
  if ($reader.ReadUInt32() -ne 0x4550) { throw 'format' }
  $machine = $reader.ReadUInt16()
  if (($inputData.arch -eq 'x64' -and $machine -ne 0x8664) -or
      ($inputData.arch -eq 'arm64' -and $machine -ne 0xaa64)) { throw 'architecture' }
  $locked.Position = $offset + 22
  $characteristics = $reader.ReadUInt16()
  if (!($characteristics -band 2) -or ($characteristics -band 0x2000)) { throw 'format' }

  $signature = Get-AuthenticodeSignature -LiteralPath $candidate
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'signature' }
  $cert = $signature.SignerCertificate
  $publisher = $cert.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  $subject = $cert.SubjectName.Decode([Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines)
  if ($publisher -cne 'OpenAI OpCo, LLC' -or $subject -notmatch '(?m)^O\s*=\s*"?OpenAI OpCo, LLC"?\r?$') { throw 'publisher' }
  $locked.Position = 0
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = [Convert]::ToBase64String($sha.ComputeHash($locked)) } finally { $sha.Dispose() }
  if ($null -ne $inputData.sha256) {
    $hex = [BitConverter]::ToString([Convert]::FromBase64String($digest)).Replace('-', '')
    if ($hex -ine $inputData.sha256) { throw 'digest' }
  }
  [Console]::WriteLine('verified')
  $pidText = [Console]::ReadLine()
  if ($pidText -notmatch '^[1-9][0-9]{0,9}$') { throw 'process' }
  $launched = Get-Process -Id ([int]$pidText)
  try {
    $image = $launched.MainModule.FileName
    if (![string]::Equals($image, $candidate, [StringComparison]::OrdinalIgnoreCase)) { throw 'image' }
    $actual = [QuotaFile]::OpenImage($image)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $actualId = [QuotaFile]::ReadInfo($actual.SafeFileHandle, $false)
      if ($actualId.Volume -ne $identity.Volume -or $actualId.IndexHigh -ne $identity.IndexHigh -or
          $actualId.IndexLow -ne $identity.IndexLow -or
          [Convert]::ToBase64String($sha.ComputeHash($actual)) -cne $digest -or $launched.HasExited) { throw 'image' }
    } finally { $actual.Dispose(); $sha.Dispose() }
    [Console]::WriteLine('matched')
    [void][Console]::ReadLine()
  } finally { $launched.Dispose() }
} catch {
  exit 1
} finally {
  if ($locked) { $locked.Dispose() }
  foreach ($directory in $directories) { $directory.Dispose() }
}
`;

const powerShell = windows.join(
  SYSTEM_DIRECTORY,
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const verificationTimeoutMs = 10_000;

async function verifyWindowsImage(
  path: string,
  signal: AbortSignal,
  sha256?: string,
) {
  signal.throwIfAborted();
  const temp = process.env.TEMP;
  if (
    process.platform !== "win32" ||
    !["x64", "arm64"].includes(process.arch) ||
    process.env.SystemRoot?.toLowerCase() !== SYSTEM_ROOT.toLowerCase() ||
    !isLocalAbsolute(path) ||
    !temp ||
    !isLocalAbsolute(temp)
  ) {
    throw new Error("Windows image verification unavailable");
  }

  const helper = spawn(
    powerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(verifier, "utf16le").toString("base64"),
    ],
    {
      shell: false,
      windowsHide: true,
      cwd: SYSTEM_DIRECTORY,
      env: {
        SystemRoot: SYSTEM_ROOT,
        WINDIR: SYSTEM_ROOT,
        TEMP: temp,
        TMP: temp,
        PSModulePath: windows.join(
          SYSTEM_DIRECTORY,
          "WindowsPowerShell",
          "v1.0",
          "Modules",
        ),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  helper.stderr.resume();
  const ignoreError = () => {};
  helper.on("error", ignoreError);
  helper.stdin.on("error", ignoreError);
  helper.stdout.on("error", ignoreError);
  helper.stderr.on("error", ignoreError);

  let closed = false;
  const done = new Promise<void>((resolve) =>
    helper.once("close", () => {
      closed = true;
      helper.off("error", ignoreError);
      helper.stdin.off("error", ignoreError);
      helper.stdout.off("error", ignoreError);
      helper.stderr.off("error", ignoreError);
      resolve();
    }),
  );

  function exchange(input: string, expected: string) {
    return new Promise<void>((resolve, reject) => {
      if (closed) {
        reject(new Error("Image verifier closed"));
        return;
      }
      let output = "";
      const abort = () => finish(false, signal.reason);
      const finish = (
        ok: boolean,
        error = new Error("Image verification failed"),
      ) => {
        signal.removeEventListener("abort", abort);
        clearTimeout(timer);
        helper.stdout.off("data", onData);
        helper.off("close", onClose);
        if (ok) resolve();
        else reject(error);
      };
      const onClose = () => finish(false);
      const onData = (chunk: Buffer) => {
        if (output.length + chunk.length > expected.length + 2) {
          finish(false);
          return;
        }
        output += chunk.toString("latin1");
        if (output.includes("\n"))
          finish(output === expected + "\r\n" || output === expected + "\n");
      };
      const timer = setTimeout(
        () => finish(false, new QuotaProviderError("timeout", true)),
        verificationTimeoutMs,
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      helper.stdout.on("data", onData);
      helper.once("close", onClose);
      helper.stdin.write(input + "\n", (error) => {
        if (error) finish(false);
      });
    });
  }

  async function close() {
    if (closed) return;
    helper.stdin.end();
    async function wait(ms: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          done.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (await wait(250)) return;
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
    if (!(await wait(verificationTimeoutMs)))
      throw new QuotaProviderError("cleanup", false);
  }

  try {
    await exchange(
      JSON.stringify({ path, arch: process.arch, sha256 }),
      "verified",
    );
  } catch (error) {
    await close();
    throw error;
  }

  return {
    evidence: { path, signature: "Valid", publisher: PUBLISHER },
    async matches(pid: number) {
      await exchange(String(pid), "matched");
      return true;
    },
    close,
  };
}

export async function startWindowsCodex(
  parent = new AbortController().signal,
  approved?: Readonly<{ path: string; sha256: string }>,
) {
  const deadline = startupDeadline(parent, startupLimits.windows);
  try {
    return await start(deadline.signal, approved && { ...approved });
  } finally {
    deadline.clear();
  }
}

async function start(
  signal: AbortSignal,
  approved?: Readonly<{ path: string; sha256: string }>,
) {
  signal.throwIfAborted();
  if (
    process.platform !== "win32" ||
    process.env.SystemRoot?.toLowerCase() !== SYSTEM_ROOT.toLowerCase()
  ) {
    throw new Error("Windows image verification unavailable");
  }

  async function localEntry(path: string) {
    // Reject ordinary junctions before probing anything behind them.
    if (
      !isLocalAbsolute(path) ||
      path.slice(0, 2).toLowerCase() !== SYSTEM_ROOT.slice(0, 2).toLowerCase()
    )
      return;
    let entry = windows.parse(path).root;
    for (const part of path.slice(entry.length).split("\\")) {
      entry = windows.join(entry, part);
      signal.throwIfAborted();
      if ((await lstat(entry)).isSymbolicLink()) return;
    }
    return lstat(entry);
  }

  if (
    approved &&
    (!isLocalAbsolute(approved.path) ||
      windows.basename(approved.path).toLowerCase() !== "codex.exe" ||
      !/^[a-f0-9]{64}$/i.test(approved.sha256))
  )
    throw new Error("Invalid approved Codex identity");

  const resolve = async (path: string) => {
    try {
      return (await localEntry(path))?.isFile()
        ? await realpath(path)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const discovery = approved
    ? (async () => {
        const canonical = await resolve(approved.path);
        return canonical?.toLowerCase() === approved.path.toLowerCase()
          ? [canonical]
          : [];
      })()
    : discoverCodex({
        env: process.env,
        arch: process.arch,
        cwd: process.cwd(),
        async list(path) {
          try {
            return (await localEntry(path))?.isDirectory()
              ? await readdir(path)
              : [];
          } catch {
            return [];
          }
        },
        resolve,
      });
  // Discovery owns no process. Ignore a late filesystem result after cancellation.
  const candidates = await interruptStartup(discovery, signal);
  return launchVerifiedCodex(
    candidates,
    {
      env: process.env,
      verify: (path, phase) =>
        verifyWindowsImage(path, phase, approved?.sha256),
      spawn,
    },
    signal,
  );
}
