import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the reserved entry isolated from normal scripts and without a live launcher", () => {
  const entry = "scripts/m2-4-live-smoke.mjs";
  for (const file of [
    "package.json",
    ".github/workflows/ci.yml",
    "electron-builder.yml",
    "src/main/index.ts",
  ]) {
    expect(readFileSync(file, "utf8")).not.toContain("m2-4-live-smoke");
  }
  const source = readFileSync(entry, "utf8");
  expect(source).toMatch(/disabled pending separate authorization/);
  expect(source).not.toMatch(/\b(?:import|require|spawn|exec)\b/);
});
