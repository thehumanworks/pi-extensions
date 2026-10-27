import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { Type } from "typebox";
import type { CatalogEntry, ValidationResult, WorkflowDefinition } from "./index.ts";
import type { WorkflowRef } from "./protocol.ts";
import { agentDirectory } from "./paths.ts";
import { WorkflowError } from "./errors.ts";
import { lintDeterminism } from "./validation.ts";
export { lintDeterminism } from "./validation.ts";

export interface LoadedWorkflow { definition: WorkflowDefinition; path: string; hash: string }
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
    const declared = (await catalog(cwd)).find(entry => entry.name === reference.name);
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
  catch (error) { throw new WorkflowError("invalid_workflow", `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!definition || typeof definition !== "object" || typeof definition.run !== "function" || typeof definition.name !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.name)) {
    throw new WorkflowError("invalid_workflow", `${path} must export default defineWorkflow({ name: 'kebab-case', async run(ctx) { ... } }).`);
  }
  if (definition.args !== undefined && !Type.IsSchema(definition.args)) {
    throw new WorkflowError("invalid_workflow", `${path}: args must be a TypeBox schema.`);
  }
  return { definition, path, hash };
}
export async function validateWorkflow(ref: WorkflowRef | string, cwd: string): Promise<ValidationResult> {
  try {
    const loaded = await loadWorkflow(ref, cwd);
    const diagnostics = lintDeterminism(await readFile(loaded.path, "utf8"));
    return { valid: diagnostics.length === 0, path: loaded.path, name: loaded.definition.name, hash: loaded.hash, args: loaded.definition.args ?? Type.Object({}), diagnostics };
  } catch (error) { return { valid: false, diagnostics: [{ message: error instanceof Error ? error.message : String(error), code: error instanceof WorkflowError ? error.code : "invalid_workflow" }] }; }
}
export async function catalog(cwd: string): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const names = new Set<string>();
  for (const [source, directory] of [["project", join(cwd, ".pi", "workflows")], ["user", join(agentDirectory(), "workflows")]] as const) {
    let files: string[];
    try { files = (await readdir(directory)).filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const filename of files) {
      const loaded = await loadWorkflow({ path: join(directory, filename) }, cwd);
      // Project definitions take precedence over user definitions of the same name.
      if (names.has(loaded.definition.name)) continue;
      names.add(loaded.definition.name);
      entries.push({ name: loaded.definition.name, description: loaded.definition.description, path: loaded.path, args: loaded.definition.args ?? Type.Object({}), source });
    }
  }
  return entries;
}
