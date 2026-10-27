import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

test("prepack builds a source-only checkout with usable compiled entry points", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-orchestration-package-"));
  try {
    // No dist/ or tests: prepack must recreate the entire Node runtime from source.
    for (const path of ["package.json", "tsconfig.json", "tsconfig.build.json", "index.ts", "src", "bin", "examples", "README.md"]) {
      await cp(join(packageRoot, path), join(directory, path), { recursive: true });
    }
    await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(directory, "node_modules"), "junction");
    execFileSync(npm, ["run", "check"], {
      cwd: directory, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const output = execFileSync(npm, ["pack", "--dry-run", "--json"], {
      cwd: directory, encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set(pack.files.map(file => file.path));
    for (const path of [
      "index.ts", "src/extension.ts", "bin/pi-workflow.mjs", "README.md",
      "dist/index.js", "dist/index.d.ts", "dist/recipes.js", "dist/recipes.d.ts",
      "dist/cli.js", "dist/worker.js", "dist/engine/index.js", "dist/engine/index.d.ts",
    ]) assert.ok(files.has(path), `missing runtime file: ${path}`);
    assert.equal([...files].filter(path => path.startsWith("examples/workflows/")).length, 9);
    for (const path of files) {
      assert.doesNotMatch(path, /(^|\/)(node_modules|test|eval)(\/|$)|tsconfig.*\.json$/);
      if (path.endsWith(".js")) {
        assert.doesNotMatch(await readFile(join(directory, path), "utf8"), /(?:from\s*|import\s*\()["'][^"']+\.ts["']/);
      }
    }

    const cli = execFileSync(process.execPath, [join(directory, "bin/pi-workflow.mjs"), "--help"], { encoding: "utf8", timeout: 10_000 });
    assert.match(cli, /pi-workflow run/);
    assert.match(cli, /pi-workflow worker start\|stop\|status/);

    await writeFile(join(directory, "smoke-workflow.ts"), `
      import { defineWorkflow } from "@nothumanwork/pi-orchestration";
      import { bestOf } from "@nothumanwork/pi-orchestration/recipes";
      import { Type } from "typebox";
      export default defineWorkflow({
        name: "package-smoke",
        args: Type.Object({ topic: Type.String() }),
        async run(ctx) { return ctx.args.topic; },
      });
      if (typeof bestOf !== "function") throw new Error("Missing recipes export");
    `);
    // Exercise the same compiled loader used by the standalone worker.
    const loaderUrl = pathToFileURL(join(directory, "dist/loader.js")).href;
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { validateWorkflow } from ${JSON.stringify(loaderUrl)};
      console.log(JSON.stringify(await validateWorkflow("./smoke-workflow.ts", process.cwd())));
    `], { cwd: directory, encoding: "utf8", timeout: 10_000 });
    const validation = JSON.parse(result);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
    assert.equal(validation.name, "package-smoke");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
