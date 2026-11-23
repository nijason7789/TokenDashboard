import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listPackage, statFile } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const required = [
  "/dist",
  "/dist/main.cjs",
  "/dist/preload.cjs",
  "/dist/renderer",
  "/dist/renderer/index.html",
  "/dist/renderer/assets",
  "/package.json",
];
const asset = /^\/dist\/renderer\/assets\/index-[\w-]+\.(?:js|css)$/;

export function validateArchive(entries) {
  for (const entry of entries) {
    if (!required.includes(entry) && !asset.test(entry)) {
      throw new Error(`Unexpected ASAR entry: ${entry}`);
    }
  }
  for (const entry of required) {
    if (!entries.includes(entry))
      throw new Error(`Missing ASAR entry: ${entry}`);
  }
  for (const extension of [".js", ".css"]) {
    if (
      entries.filter((entry) => asset.test(entry) && entry.endsWith(extension))
        .length !== 1
    ) {
      throw new Error(`Expected one renderer ${extension} bundle`);
    }
  }
}

async function verifyPortable(writeChecksum) {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const artifact = `release/CodexQuotaMonitor-${version}-windows-x64-portable.exe`;
  const resources = "release/win-unpacked/resources";
  const files = await readdir(resources);
  if (files.sort().join(",") !== "app.asar,elevate.exe") {
    throw new Error("Unexpected packaged resources");
  }
  const archive = `${resources}/app.asar`;
  const entries = listPackage(archive).map((entry) =>
    entry.replaceAll("\\", "/"),
  );
  validateArchive(entries);
  for (const entry of entries) {
    const info = statFile(archive, entry.slice(1).replaceAll("/", sep), false);
    if (info.unpacked || info.link)
      throw new Error(`Expected packed ASAR entry: ${entry}`);
  }

  const wire = await getCurrentFuseWire(
    "release/win-unpacked/CodexQuotaMonitor.exe",
  );
  const expected = {
    RunAsNode: FuseState.DISABLE,
    EnableCookieEncryption: FuseState.ENABLE,
    EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
    EnableNodeCliInspectArguments: FuseState.DISABLE,
    EnableEmbeddedAsarIntegrityValidation: FuseState.ENABLE,
    OnlyLoadAppFromAsar: FuseState.ENABLE,
  };
  for (const [name, state] of Object.entries(expected)) {
    if (wire[FuseV1Options[name]] !== state)
      throw new Error(`Unexpected Electron fuse: ${name}`);
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  const line = `${hash.digest("hex")}  ${artifact.split("/").at(-1)}`;
  const sidecar = `${artifact}.sha256`;
  if (writeChecksum) {
    await writeFile(sidecar, `${line}\n`);
  } else if ((await readFile(sidecar, "utf8")).trimEnd() !== line) {
    throw new Error("Portable artifact SHA-256 mismatch");
  }
  console.log(entries.join("\n"));
  console.log("All six Electron fuses verified.");
  console.log(line);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = process.argv.slice(2);
  const writeChecksum =
    options.length === 1 && options[0] === "--write-checksum";
  if (options.length && !writeChecksum)
    throw new Error("Unknown package verification option");
  await verifyPortable(writeChecksum);
}
