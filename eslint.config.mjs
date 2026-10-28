import tseslint from "typescript-eslint";

// Correctness, not stylistic rewrites. Historical evaluation artifacts are data.
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/eval/results/**",
      "**/eval/long/results/**",
      "**/eval/long/repair-templates*/**",
      "**/eval/long/state-*/**",
      "scripts/quality/fixtures/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    rules: {
      "no-async-promise-executor": "error",
      "no-unsafe-finally": "error",
      "no-unreachable": "error",
      "no-constant-binary-expression": "error",
    },
  },
  {
    files: ["**/*.{ts,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.lint.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-async-promise-executor": "error",
      "no-unsafe-finally": "error",
      "no-unreachable": "error",
      "no-constant-binary-expression": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],
      "@typescript-eslint/no-unsafe-declaration-merging": "error",
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: false,
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "it", "describe"] },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];
