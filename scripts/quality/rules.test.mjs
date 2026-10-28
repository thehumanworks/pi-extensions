import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ESLint } from "eslint";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Bad examples are deliberately excluded from normal linting, but tested here
// against the real repository config rather than a duplicate rule list.
const eslint = new ESLint({ cwd: root, ignore: false });

async function messages(name, extension = "ts") {
  const path = new URL(`fixtures/${name}.${extension}`, import.meta.url);
  const source = await readFile(path, "utf8");
  const [result] = await eslint.lintText(source, { filePath: fileURLToPath(path) });
  assert.ok(result, `${name}: lint result missing`);
  assert.equal(result.fatalErrorCount, 0, `${name}: ${JSON.stringify(result.messages)}`);
  assert.ok(
    result.messages.every((message) => message.ruleId),
    `${name}: unexpected parser/ignore diagnostic`,
  );
  return result.messages;
}

const positiveFixtures = ["valid-extension", "valid-test", "valid-type-boundaries"];

for (const name of positiveFixtures) {
  test(`${name} is accepted`, async () => {
    assert.deepEqual(await messages(name), []);
  });
}

test("positive TypeScript fixtures satisfy the actual compiler and host API", () => {
  const configPath = fileURLToPath(new URL("../../tsconfig.lint.json", import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, "TypeScript config could not be read");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, [], "TypeScript config could not be parsed");
  // Deliberately invalid lint fixtures must not enter this compilation.
  const rootNames = positiveFixtures.map((name) =>
    fileURLToPath(new URL(`fixtures/${name}.ts`, import.meta.url)),
  );
  const program = ts.createProgram({ rootNames, options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const diagnosticText = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => "\n",
  });
  assert.equal(diagnostics.length, 0, diagnosticText);
});

test("every registered extension entrypoint has strict promise lint coverage", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  // Use default ignores here: fixtures intentionally bypass them in the rule tests.
  const coverageESLint = new ESLint({ cwd: root });
  let entrypointCount = 0;
  for (const workspace of manifest.workspaces) {
    const workspaceRoot = new URL(`../../${workspace}/`, import.meta.url);
    const workspaceManifest = JSON.parse(
      await readFile(new URL("package.json", workspaceRoot), "utf8"),
    );
    for (const entrypoint of workspaceManifest.pi?.extensions ?? []) {
      entrypointCount += 1;
      const path = fileURLToPath(new URL(entrypoint, workspaceRoot));
      assert.equal(await coverageESLint.isPathIgnored(path), false, `${path}: entrypoint ignored`);
      const config = await coverageESLint.calculateConfigForFile(path);
      assert.ok(config, `${path}: lint configuration missing`);
      const promiseRule = config.rules?.["@typescript-eslint/no-floating-promises"];
      assert.equal(promiseRule?.[0], 2, `${path}: discarded promises must be errors`);
      assert.equal(
        promiseRule?.[1]?.ignoreVoid,
        false,
        `${path}: void must not hide rejected promises`,
      );
    }
  }
  assert.ok(entrypointCount > 0, "no extension entrypoints were inspected");
});

const negativeCases = {
  "ts-ignore": "@typescript-eslint/ban-ts-comment",
  "ts-nocheck": "@typescript-eslint/ban-ts-comment",
  "undocumented-expect-error": "@typescript-eslint/ban-ts-comment",
  "unsafe-function-type": "@typescript-eslint/no-unsafe-function-type",
  "unsafe-declaration-merging": "@typescript-eslint/no-unsafe-declaration-merging",
  "optional-chain-assertion": "@typescript-eslint/no-non-null-asserted-optional-chain",
  "dropped-promise": "@typescript-eslint/no-floating-promises",
  "void-promise": "@typescript-eslint/no-floating-promises",
  "async-callback": "@typescript-eslint/no-misused-promises",
  "await-non-promise": "@typescript-eslint/await-thenable",
  "async-executor": "no-async-promise-executor",
  "masking-finally": "no-unsafe-finally",
  "dropped-assertion": "@typescript-eslint/no-floating-promises",
  unreachable: "no-unreachable",
  "constant-expression": "no-constant-binary-expression",
};

for (const [name, ruleId] of Object.entries(negativeCases)) {
  test(`${name} is rejected by ${ruleId}`, async () => {
    const diagnostics = await messages(name);
    assert.ok(
      diagnostics.some((message) => message.ruleId === ruleId && message.severity === 2),
      `${name}: ${JSON.stringify(diagnostics)}`,
    );
  });
}

for (const extension of ["js", "mjs", "cjs"]) {
  test(`${extension} syntax rules reject an async Promise executor`, async () => {
    const diagnostics = await messages("async-executor", extension);
    assert.ok(
      diagnostics.some(
        (message) => message.ruleId === "no-async-promise-executor" && message.severity === 2,
      ),
    );
  });
  test(`${extension} syntax rules accept a synchronous Promise executor`, async () => {
    assert.deepEqual(await messages("valid-executor", extension), []);
  });
}
