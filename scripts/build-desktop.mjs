import { build } from "vite";

for (const name of ["main", "preload"]) {
  await build({
    configFile: false,
    publicDir: false,
    build: {
      target: "node24",
      outDir: "dist",
      emptyOutDir: false,
      lib: {
        entry: `src/${name}/index.ts`,
        formats: ["cjs"],
        fileName: () => `${name}.cjs`,
      },
      rolldownOptions: { external: ["electron", /^node:/] },
    },
  });
}
