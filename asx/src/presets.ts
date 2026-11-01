import { access, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ThinkingLevel } from "./index.ts";
import { WorkflowError } from "./errors.ts";
import { mismatchLines } from "./engine/mismatch.ts";
import { agentDirectory } from "./paths.ts";

/**
 * A preset is `<name>.toml`: a reusable agent with a templated task. Its agent is a full pi
 * session (pi's tools, the user's extensions, MCP servers, skills and context files).
 */
export const PresetSchema = Type.Object({
  /** `provider/modelId`, as `pi --model`. */
  model: Type.String({ pattern: "^[^/]+/.+$" }),
  thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => Type.Literal(level)))),
  /** Appended to pi's system prompt. */
  instructions: Type.Optional(Type.String()),
  /** LiquidJS template of the user prompt; `{% sh cmd %}` inserts command output. */
  task: Type.String({ minLength: 1 }),
  /** Working directory, relative to the run's. */
  cwd: Type.Optional(Type.String()),
  /** The final reply is also written here, relative to the run's cwd. */
  outputFilePath: Type.Optional(Type.String()),
  /** Tool allowlist with pi's --tools semantics: names, `*` patterns, `+name`/`-name` modifiers. Omitted: every tool. */
  includeTools: Type.Optional(Type.Array(Type.String())),
  /** Denylist applied after includeTools, as pi's --exclude-tools. */
  excludeTools: Type.Optional(Type.Array(Type.String())),
  /** `verdict`: the reply ends with {"approved": bool, "feedback": string}; `repeat … until` reads it. */
  output: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("verdict")])),
  retries: Type.Optional(Type.Integer({ minimum: 0 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
}, { additionalProperties: false });

export type PresetSpec = Static<typeof PresetSchema> & { thinking?: ThinkingLevel };
export interface Preset extends PresetSpec { name: string; path: string }

export const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Where presets are looked up, in order: project, `ASX_PRESET_DIR`, user. */
export function presetDirectories(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [join(cwd, ".pi", "presets")];
  if (env.ASX_PRESET_DIR) dirs.push(isAbsolute(env.ASX_PRESET_DIR) ? env.ASX_PRESET_DIR : resolve(cwd, env.ASX_PRESET_DIR));
  dirs.push(join(agentDirectory(env), "presets"));
  return dirs;
}

export function parsePreset(name: string, path: string, source: string): Preset {
  let value: unknown;
  try { value = parseToml(source); }
  catch (error) { throw new WorkflowError("invalid_preset", `${path}: ${(error as Error).message}`); }
  if (!Value.Check(PresetSchema, value)) {
    throw new WorkflowError("invalid_preset", `${path} is not a valid preset:\n${mismatchLines(PresetSchema, value, "preset").join("\n")}`);
  }
  return { ...value, name, path } as Preset;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function findPreset(name: string, dirs: readonly string[]): Promise<string | undefined> {
  if (!PRESET_NAME.test(name)) throw new WorkflowError("invalid_preset", `Invalid preset name "${name}".`);
  for (const dir of dirs) {
    const path = join(dir, `${name}.toml`);
    if (await exists(path)) return path;
  }
  return undefined;
}

export async function loadPreset(name: string, dirs: readonly string[]): Promise<Preset> {
  const path = await findPreset(name, dirs);
  if (!path) throw new WorkflowError("preset_not_found", `Preset "${name}" not found. Looked for ${name}.toml in ${dirs.join(", ")}.`);
  return parsePreset(name, path, await readFile(path, "utf8"));
}

export interface PresetListing { name: string; path: string; source: string; error?: string; preset?: Preset }

/** Every preset in the directories, first directory winning on duplicate names. Broken files are reported in place. */
export async function listPresets(dirs: readonly string[]): Promise<PresetListing[]> {
  const entries: PresetListing[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let files: string[];
    try { files = (await readdir(dir)).filter(file => file.endsWith(".toml")).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const file of files) {
      const name = basename(file, ".toml");
      if (seen.has(name)) continue;
      seen.add(name);
      const path = join(dir, file);
      try { entries.push({ name, path, source: dir, preset: parsePreset(name, path, await readFile(path, "utf8")) }); }
      catch (error) { entries.push({ name, path, source: dir, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  return entries;
}
