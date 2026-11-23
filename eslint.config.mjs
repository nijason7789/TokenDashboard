import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "release/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["**/tests/**", "**/fixtures/**"] },
      ],
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}", "src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["electron"],
          patterns: [
            "node:*",
            "**/main/**",
            "**/preload/**",
            "**/tests/**",
            "**/fixtures/**",
          ],
        },
      ],
    },
  },
);
