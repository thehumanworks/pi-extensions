import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { Type } from "typebox";
import type { CatalogEntry, ValidationResult, WorkflowDefinition } from "./index.ts";
import type { WorkflowRef } from "./protocol.ts";
import { agentDirectory } from "./paths.ts";
import { WorkflowError } from "./errors.ts";
import { lintDeterminism } from "./validation.ts";
export { lintDeterminism } from "./validation.ts";

export interface LoadedWorkflow { definition: WorkflowDefinition; path: string; hash: string; source: string }
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
let installedAliases: Promise<Record<string, string>> | undefined;
function dependencyAliases(): Promise<Record<string, string>> {
  return installedAliases ??= Promise.all(["typebox", "@earendil-works/pi-durable", "@earendil-works/pi-ai"].map(async name => {
    const entry = import.meta.resolve(name);
    // These installed packages publish their entry in build/ or dist/. Use
    // their export maps, rather than treating that entry file as a directory.
    const manifest = JSON.parse(await readFile(new URL("../package.json", entry), "utf8")) as { exports: Record<string, unknown> };
    const aliases: Record<string, string> = {};
    for (const subpath of Object.keys(manifest.exports)) {
      const specifier = subpath === "." ? name : name + subpath.slice(1);
      if (!subpath.includes("*")) aliases[specifier] = fileURLToPath(import.meta.resolve(specifier));
      else if (subpath.endsWith("/*")) {
        // pi-ai's public providers/*, api/* and utils/* exports map to matching
        // directories. Jiti then resolves the ordinary .js extension itself.
        aliases[specifier.slice(0, -2)] = dirname(fileURLToPath(import.meta.resolve(specifier)));
      }
    }
    return aliases;
  })).then(parts => Object.assign({}, ...parts));
}
export async function resolveWorkflow(ref: WorkflowRef | string, cwd: string): Promise<string> {
  const reference = typeof ref === "string" ? (/[/\\]|\.[cm]?[jt]s$/.test(ref) ? { path: ref } : { name: ref }) : ref;
  const candidates = "path" in reference
    ? [isAbsolute(reference.path) ? reference.path : resolve(cwd, reference.path)]
    : [join(cwd, ".pi", "workflows", reference.name + ".ts"), join(agentDirectory(), "workflows", reference.name + ".ts")];
  for (const candidate of candidates) {
    try { await access(candidate); return await realpath(candidate); } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  if ("name" in reference) {
    const declared = (await catalog(cwd)).find(entry => entry.name === reference.name && entry.error === undefined);
    if (declared) return declared.path;
  }
  throw new WorkflowError("workflow_not_found", `Workflow not found: ${"path" in reference ? reference.path : reference.name}. Use catalog --cwd ${cwd}, or pass a workflow file path.`);
}
export async function loadWorkflow(ref: WorkflowRef | string, cwd: string): Promise<LoadedWorkflow> {
  const path = await resolveWorkflow(ref, cwd);
  const source = await readFile(path, "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  // Aliases let project workflows import the installed extension even when Pi's
  // package installation is outside that project's node_modules directory.
  const loader = createJiti(import.meta.url, {
    moduleCache: false, fsCache: false, interopDefault: true,
    alias: {
      ...await dependencyAliases(),
      "@nothumanwork/pi-orchestration/recipes": join(packageRoot, "dist", "recipes.js"),
      "@nothumanwork/pi-orchestration": join(packageRoot, "dist", "index.js"),
    },
  });
  let definition: WorkflowDefinition;
  try { definition = await loader.import<WorkflowDefinition>(path, { default: true }); }
  catch (error) { throw new WorkflowError("invalid_workflow", `Cannot load ${path}: ${loadMessage(error)}`); }
  if (!definition || typeof definition !== "object" || typeof definition.run !== "function" || typeof definition.name !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.name)) {
    throw new WorkflowError("invalid_workflow", `${path} must export default defineWorkflow({ name: 'kebab-case', async run(ctx) { ... } }).`);
  }
  // Args always arrive as a JSON object (tool `args`, CLI --args), so only an object schema can check them.
  if (definition.args !== undefined && !Type.IsObject(definition.args)) {
    throw new WorkflowError("invalid_workflow", `${path}: args must be Type.Object({...}) from "typebox"; got ${describeArgs(definition.args)}.`);
  }
  return { definition, path, hash, source };
}
// Node's "Require stack:" lists loader internals, not the workflow's mistake.
function loadMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\n\s*Require stack:[\s\S]*$/, "");
  return /Cannot find module '@sinclair\/typebox/.test(message) ? `${message} Use import { Type } from "typebox" (bundled with pi-orchestration).` : message;
}
function describeArgs(args: unknown): string {
  try { return JSON.stringify(args)?.slice(0, 120) ?? String(args); } catch { return String(args); }
}
type Diagnostic = ValidationResult["diagnostics"][number];
function loadDiagnostic(error: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof WorkflowError ? error.code : "invalid_workflow";
  // Parse errors end with "\n <file>:<line>:<column>", the column 0-based; lift that into fields.
  const at = /\s*\n\s*(\S.*):(\d+):(\d+)\s*$/.exec(message);
  return at ? { code, message: message.slice(0, at.index), path: at[1], line: Number(at[2]), column: Number(at[3]) + 1 } : { code, message };
}
export async function validateWorkflow(ref: WorkflowRef | string, cwd: string): Promise<ValidationResult> {
  let path: string;
  try { path = await resolveWorkflow(ref, cwd); } catch (error) { return { valid: false, diagnostics: [loadDiagnostic(error)] }; }
  // Lint even when loading fails, so one pass reports every problem.
  const lint = await readFile(path, "utf8").then(lintDeterminism, () => []);
  try {
    const loaded = await loadWorkflow({ path }, cwd);
    return { valid: lint.length === 0, path, name: loaded.definition.name, hash: loaded.hash, args: loaded.definition.args ?? Type.Object({}), diagnostics: lint };
  } catch (error) {
    const failure = loadDiagnostic(error);
    // The loader and the lint both see a syntax error in the workflow file; keep the loader's, which has the column.
    return { valid: false, path, diagnostics: [failure, ...lint.filter(item => item.code !== "syntax_error" || failure.path !== path)] };
  }
}
export async function catalog(cwd: string): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const names = new Set<string>();
  for (const [source, directory] of [["project", join(cwd, ".pi", "workflows")], ["user", join(agentDirectory(), "workflows")]] as const) {
    let files: string[];
    try { files = (await readdir(directory)).filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const filename of files) {
      let loaded: LoadedWorkflow;
      try { loaded = await loadWorkflow({ path: join(directory, filename) }, cwd); }
      catch (error) {
        // One broken file must not hide every other workflow. Report it in place.
        entries.push({ name: basename(filename, ".ts"), path: join(directory, filename), args: Type.Object({}), source,
          error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // Project definitions take precedence over user definitions of the same name.
      if (names.has(loaded.definition.name)) continue;
      names.add(loaded.definition.name);
      entries.push({ name: loaded.definition.name, description: loaded.definition.description, path: loaded.path, args: loaded.definition.args ?? Type.Object({}), source });
    }
  }
  return entries;
}
