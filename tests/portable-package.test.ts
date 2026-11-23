import { describe, expect, it } from "vitest";
import { validateArchive } from "../scripts/verify-portable.mjs";

const entries = [
  "/dist",
  "/dist/main.cjs",
  "/dist/preload.cjs",
  "/dist/renderer",
  "/dist/renderer/index.html",
  "/dist/renderer/assets",
  "/dist/renderer/assets/index-abCD12_3.js",
  "/dist/renderer/assets/index-deFG45_6.css",
  "/package.json",
];

describe("Portable ASAR allowlist", () => {
  it("accepts the bundled application and its runtime manifest", () => {
    expect(() => validateArchive(entries)).not.toThrow();
  });

  it.each([
    "/auth.json",
    "/dist/renderer/assets/test.js",
    "/node_modules",
    "/.env",
  ])("rejects unexpected entry %s", (entry) => {
    expect(() => validateArchive([...entries, entry])).toThrow(/Unexpected/);
  });

  it("rejects a missing preload bundle", () => {
    expect(() =>
      validateArchive(entries.filter((entry) => entry !== "/dist/preload.cjs")),
    ).toThrow(/Missing/);
  });
});
