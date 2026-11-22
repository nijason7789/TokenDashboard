import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
  test: {
    root: ".",
    include: ["tests/**/*.{test.ts,test.tsx}"],
    coverage: { include: ["src/**/*.{ts,tsx}"], reporter: ["text", "lcov"] },
  },
});
