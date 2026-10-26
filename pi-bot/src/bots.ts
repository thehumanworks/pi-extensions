import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

/** Names that would collide with /bot subcommands. */
export const RESERVED_NAMES = new Set(["list", "new", "create", "edit", "info", "show", "resume", "exit", "delete", "help"]);
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface BotDefinition {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  /** Tool allowlist; undefined keeps the session's default tools. */
  tools?: string[];
  /** Shared-skill allowlist (names or paths); undefined keeps every skill. Home skills always load. */
  skills?: string[];
  /** Persona system prompt (the BOT.md body). */
  prompt: string;
  /** Unrecognized frontmatter, preserved on save. */
  extra: Record<string, unknown>;
}

export interface Bot extends BotDefinition {
  home: string;
  file: string;
}

export interface TextEdit { oldText: string; newText: string }

export interface BotPatch {
  description?: string;
  model?: string | null;
  thinking?: ThinkingLevel | null;
  tools?: string[] | null;
  skills?: string[] | null;
  prompt?: string;
  /** Exact replacements in the persona, each matched once against the current text. */
  edits?: TextEdit[];
}

/** Apply exact, non-overlapping replacements, each of which must match the original text exactly once. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const spans = edits.map(({ oldText, newText }, index) => {
    if (!oldText) throw new Error(`Edit ${index + 1}: oldText is empty.`);
    const start = text.indexOf(oldText);
    if (start < 0) throw new Error(`Edit ${index + 1}: oldText was not found in the persona.`);
    if (text.indexOf(oldText, start + 1) >= 0) throw new Error(`Edit ${index + 1}: oldText matches more than once; include more surrounding text.`);
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) throw new Error("Edits overlap; merge them into one edit.");
  }
  let result = text;
  for (const span of spans.reverse()) result = result.slice(0, span.start) + span.newText + result.slice(span.end);
  return result;
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Root of all bot homes: $PI_BOT_HOME, else <agent dir>/bots. */
export function botsRoot(): string {
  const override = process.env.PI_BOT_HOME;
  return resolve(override ? expandHome(override) : join(getAgentDir(), "bots"));
}

export function botPaths(home: string) {
  return {
    definition: join(home, "BOT.md"),
    memoryIndex: join(home, "MEMORY.md"),
    memory: join(home, "memory"),
    skills: join(home, "skills"),
    scripts: join(home, "scripts"),
    tasks: join(home, "tasks"),
    journal: join(home, "journal"),
    sessions: join(home, "sessions"),
  };
}

export function isValidName(name: string): boolean {
  return NAME.test(name) && !RESERVED_NAMES.has(name);
}

export function validateName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid bot name "${name}": use up to 63 lowercase letters, digits, "-" or "_", starting with a letter or digit.`);
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is reserved for /bot subcommands; choose another name.`);
  return name;
}

export function validateThinking(value: string): ThinkingLevel {
  if (!(THINKING_LEVELS as readonly string[]).includes(value)) throw new Error(`Invalid thinking level "${value}": use one of ${THINKING_LEVELS.join(", ")}.`);
  return value as ThinkingLevel;
}

function list(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!raw || raw.some(item => typeof item !== "string")) throw new Error(`"${field}" must be a list of strings.`);
  const items = [...new Set((raw as string[]).map(item => item.trim()).filter(Boolean))];
  return items.length ? items : undefined;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`"${field}" must be a string.`);
  return value.trim() || undefined;
}

/** Parse BOT.md. The directory name is the bot's identity; a differing frontmatter name is ignored. */
export function parseBot(content: string, name: string): BotDefinition {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
  const { name: _name, description, model, thinking, effort, tools, skills, ...extra } = frontmatter;
  const level = optionalString(thinking ?? effort, "thinking");
  return {
    name,
    description: optionalString(description, "description") ?? "",
    model: optionalString(model, "model"),
    thinking: level === undefined ? undefined : validateThinking(level),
    tools: list(tools, "tools"),
    skills: list(skills, "skills"),
    prompt: body.trim(),
    extra,
  };
}

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_ ./@+-]*$/;
const AMBIGUOUS = /^(true|false|yes|no|on|off|y|n|null|~)$|^[-+.]?\d/i;

function yaml(value: unknown): string {
  if (typeof value === "string") return PLAIN.test(value) && value === value.trim() && !AMBIGUOUS.test(value) ? value : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(yaml).join(", ")}]`;
  // JSON is valid YAML flow syntax for numbers, booleans and mappings.
  return JSON.stringify(value);
}

export function serializeBot(bot: BotDefinition): string {
  const fields: Array<[string, unknown]> = [
    ["name", bot.name], ["description", bot.description], ["model", bot.model], ["thinking", bot.thinking],
    ["tools", bot.tools], ["skills", bot.skills], ...Object.entries(bot.extra),
  ];
  const lines = fields.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${yaml(value)}`);
  return `---\n${lines.join("\n")}\n---\n\n${bot.prompt.trim()}\n`;
}

export async function loadBot(name: string, root = botsRoot()): Promise<Bot> {
  validateName(name);
  const home = join(root, name), file = botPaths(home).definition;
  let content: string;
  try { content = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown bot "${name}" (no ${file}).`);
    throw error;
  }
  return { ...parseBot(content, name), home, file };
}

export async function listBots(root = botsRoot()): Promise<{ bots: Bot[]; errors: string[] }> {
  let entries: string[];
  try { entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && isValidName(entry.name)).map(entry => entry.name).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bots: [], errors: [] };
    throw error;
  }
  const bots: Bot[] = [], errors: string[] = [];
  for (const name of entries) {
    if (!existsSync(join(root, name, "BOT.md"))) continue;
    try { bots.push(await loadBot(name, root)); }
    catch (error) { errors.push(`${name}: ${(error as Error).message}`); }
  }
  return { bots, errors };
}

const MEMORY_TEMPLATE = `# Memory index

<!-- One line per memory: - [Title](memory/<file>.md) — one-line hook. Keep under 200 lines. -->
`;
const SCRIPTS_TEMPLATE = `# Scripts

<!-- One line per reusable script: - \`scripts/<file>\` — purpose and usage. -->
`;

/** Create the home layout, keeping any files that already exist. */
export async function scaffoldHome(home: string): Promise<void> {
  const paths = botPaths(home);
  for (const dir of [paths.memory, paths.skills, paths.scripts, paths.tasks, paths.journal, paths.sessions]) await mkdir(dir, { recursive: true });
  for (const [file, content] of [[paths.memoryIndex, MEMORY_TEMPLATE], [join(paths.scripts, "README.md"), SCRIPTS_TEMPLATE]]) {
    await writeFile(file, content, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
  }
}

export async function createBot(definition: Omit<BotDefinition, "extra"> & { extra?: Record<string, unknown> }, root = botsRoot()): Promise<Bot> {
  validateName(definition.name);
  if (!definition.description.trim()) throw new Error("A bot needs a description of its job.");
  if (!definition.prompt.trim()) throw new Error("A bot needs a persona prompt.");
  const home = join(root, definition.name), file = botPaths(home).definition;
  if (existsSync(file)) throw new Error(`Bot "${definition.name}" already exists at ${home}.`);
  await mkdir(home, { recursive: true });
  const bot: BotDefinition = { ...definition, description: definition.description.trim(), extra: definition.extra ?? {} };
  await writeFile(file, serializeBot(bot), { flag: "wx" });
  await scaffoldHome(home);
  return { ...bot, home, file };
}

export async function updateBot(name: string, patch: BotPatch, root = botsRoot()): Promise<Bot> {
  const bot = await loadBot(name, root);
  const next: Bot = { ...bot };
  if (patch.description !== undefined) next.description = patch.description.trim();
  if (patch.prompt !== undefined && patch.edits?.length) throw new Error("Use either prompt (full replacement) or edits, not both.");
  if (patch.prompt !== undefined) next.prompt = patch.prompt.trim();
  if (patch.edits?.length) next.prompt = applyTextEdits(bot.prompt, patch.edits).trim();
  if (patch.model !== undefined) next.model = patch.model ?? undefined;
  if (patch.thinking !== undefined) next.thinking = patch.thinking ?? undefined;
  if (patch.tools !== undefined) next.tools = patch.tools?.length ? patch.tools : undefined;
  if (patch.skills !== undefined) next.skills = patch.skills?.length ? patch.skills : undefined;
  if (!next.description) throw new Error("A bot needs a description of its job.");
  if (!next.prompt) throw new Error("A bot needs a persona prompt.");
  await writeFile(bot.file, serializeBot(next));
  await scaffoldHome(bot.home);
  return next;
}

/** Replace BOT.md with edited text after validating it. */
export async function writeDefinition(name: string, content: string, root = botsRoot()): Promise<Bot> {
  const bot = await loadBot(name, root);
  const parsed = parseBot(content, name);
  if (!parsed.description) throw new Error("BOT.md frontmatter needs a description.");
  if (!parsed.prompt) throw new Error("BOT.md needs a persona prompt body.");
  await writeFile(bot.file, content.endsWith("\n") ? content : `${content}\n`);
  return { ...parsed, home: bot.home, file: bot.file };
}

/** Move a home under <root>/.archive instead of deleting memories and history. */
export async function archiveBot(name: string, root = botsRoot()): Promise<string> {
  const bot = await loadBot(name, root);
  const target = join(root, ".archive", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(join(root, ".archive"), { recursive: true });
  await rename(bot.home, target);
  return target;
}

/** Resolve symlinks through the deepest existing ancestor, so not-yet-created files compare correctly. */
function real(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(real(parent), basename(absolute));
  }
}

export function isInside(path: string, dir: string): boolean {
  const rel = relative(real(dir), real(path));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** The bot owning a session directory of the form <root>/<name>/sessions. */
export function botForSessionDir(dir: string | undefined, root = botsRoot()): string | undefined {
  if (!dir) return undefined;
  const parts = relative(real(root), real(dir)).split(/[\\/]/);
  return parts.length === 2 && parts[1] === "sessions" && isValidName(parts[0]!) ? parts[0] : undefined;
}
