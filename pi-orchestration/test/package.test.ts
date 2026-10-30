import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** Ignore partial package-local installs when the complete dependency set is hoisted. */
async function installedNodeModules(root: string, required: string[]): Promise<string> {
  for (let directory = root; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules");
    try {
      if ((await stat(candidate)).isDirectory() && (await Promise.all(required.map(name =>
        access(join(candidate, name, "package.json")).then(() => true, () => false)
      ))).every(Boolean)) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory) break;
  }
  throw new Error(`No complete node_modules found at or above ${root}; install the package's dependencies before testing prepack.`);
}

test("package fixtures select a complete local or hoisted dependency directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-package-layout-"));
  try {
    const project = join(root, "packages", "orchestration");
    const local = join(project, "node_modules");
    const hoisted = join(root, "node_modules");
    await mkdir(project, { recursive: true });
    // A dangling symlink must not be selected merely because symlink() accepts it.
    await symlink(join(root, "missing"), local, "junction");
    const required = ["jiti", "@types/node"];
    const install = async (directory: string, name: string) => {
      await mkdir(join(directory, name), { recursive: true });
      await writeFile(join(directory, name, "package.json"), "{}");
    };
    for (const name of required) await install(hoisted, name);
    assert.equal(await installedNodeModules(project, required), hoisted);
    await rm(local);
    await install(local, "jiti");
    // A workspace-local jiti exists here too, but @types/node is hoisted.
    assert.equal(await installedNodeModules(project, required), hoisted);
    await install(local, "@types/node");
    assert.equal(await installedNodeModules(project, required), local);
    await assert.rejects(installedNodeModules(project, ["missing"]), /No complete node_modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepack builds a source-only checkout with usable compiled entry points", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-orchestration-package-"));
  try {
    // No dist/ or tests: prepack must recreate the entire Node runtime from source.
    for (const path of ["package.json", "tsconfig.json", "tsconfig.build.json", "index.ts", "src", "bin", "examples", "README.md"]) {
      await cp(join(packageRoot, path), join(directory, path), { recursive: true });
    }
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const required = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies });
    await symlink(await installedNodeModules(packageRoot, required), join(directory, "node_modules"), "junction");
    execFileSync(npm, ["run", "check"], {
      cwd: directory, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const output = execFileSync(npm, ["pack", "--dry-run", "--json"], {
      cwd: directory, encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set(pack.files.map(file => file.path));
    for (const path of [
      "index.ts", "src/extension.ts", "bin/workflow.mjs", "README.md",
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

    const cli = execFileSync(process.execPath, [join(directory, "bin/workflow.mjs"), "--help"], { encoding: "utf8", timeout: 10_000 });
    assert.match(cli, /^workflow guide/m);
    assert.match(cli, /workflow worker start\|stop\|status/);
    // The compiled guide points at the README and examples that ship with the package.
    const guide = execFileSync(process.execPath, [join(directory, "bin/workflow.mjs"), "guide"], { encoding: "utf8", timeout: 10_000 });
    const pointers = [/ (\/\S+\/README\.md)$/m, / (\/\S+\/examples\/workflows\/)$/m].map(pattern => pattern.exec(guide)?.[1] ?? "missing");
    for (const path of pointers) await access(path);

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
