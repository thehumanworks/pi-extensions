import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BotError } from "./errors.js";
import { botsRoot, resolveSource } from "./paths.js";
import { initBot, inspectBot, parseDefinition } from "./project.js";
import { acquireLock } from "./lock.js";
import type { BotInfo, InitBotOptions, ThinkingLevel } from "./types.js";

export interface BotSummary { name: string; description: string; sourceDir: string }
export interface TextEdit { oldText: string; newText: string }
export interface BotPatch {
  description?: string;
  prompt?: string;
  edits?: TextEdit[];
  model?: string | null;
  thinking?: ThinkingLevel | null;
  inherit?: "none" | "global";
  tools?: string[] | null;
  excludeTools?: string[] | null;
  excludeExtensions?: string[] | null;
  excludeMcpServers?: string[] | null;
  builtinTools?: string[] | null;
  skills?: string[] | null;
  maintenance?: boolean;
  /** Complete BOT.md replacement; cannot be combined with other changes. */
  definition?: string;
}
export function validateName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new BotError("INVALID_INPUT", "Bot names use 1–63 lowercase letters, digits, - or _, starting with a letter or digit.");
  return name;
}
/** Metadata-only discovery: listing the roster never executes a bot's TypeScript. */
export async function listBots(root = botsRoot()): Promise<{ bots: BotSummary[]; errors: string[] }> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bots: [], errors: [] }; throw error; }
  const bots: BotSummary[] = [], errors: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const sourceDir = join(root, entry.name), file = join(sourceDir, "BOT.md");
    if (!existsSync(file)) continue;
    try {
      const definition = parseDefinition(await readFile(file, "utf8"), sourceDir);
      bots.push({ name: entry.name, description: definition.description, sourceDir });
    } catch (error) { errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { bots, errors };
}
/** Create a named project in the user's roster. initBot remains the arbitrary-directory API. */
export async function createBot(name: string, options: InitBotOptions = {}, root = botsRoot()): Promise<BotInfo> {
  validateName(name);
  await mkdir(root, { recursive: true });
  const release = await acquireLock(join(root, `.sdk-create-${name}.lock`));
  try {
    const source = join(root, name);
    if (existsSync(join(source, "BOT.md"))) throw new BotError("CONFLICT", `Bot ${name} already exists at ${source}.`);
    return await initBot(source, { ...options, name });
  } finally { await release(); }
}
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const spans = edits.map(({ oldText, newText }, i) => {
    if (!oldText) throw new BotError("INVALID_INPUT", `Edit ${i + 1}: oldText must not be empty.`);
    const start = text.indexOf(oldText);
    if (start < 0 || text.indexOf(oldText, start + 1) >= 0) throw new BotError("INVALID_INPUT", `Edit ${i + 1}: oldText must match exactly once.`);
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) if (spans[i].start < spans[i - 1].end) throw new BotError("INVALID_INPUT", "Edits overlap; combine them.");
  for (const span of spans.reverse()) text = text.slice(0, span.start) + span.newText + text.slice(span.end);
  return text;
}
/** Edit a live definition. This does not take the execution lock: the runtime reloads at its next boundary. */
export async function editBot(source: string, patch: BotPatch): Promise<{ sourceDir: string; definition: string }> {
  const sourceDir = await resolveSource(source), file = join(sourceDir, "BOT.md");
  const release = await acquireLock(join(sourceDir, ".sdk-definition.lock"));
  try {
    const current = await readFile(file, "utf8");
    let next: string;
    if (patch.definition !== undefined) {
      if (Object.entries(patch).some(([key, value]) => key !== "definition" && value !== undefined)) throw new BotError("INVALID_INPUT", "definition cannot be combined with other changes.");
      next = patch.definition;
    } else {
      if (patch.prompt !== undefined && patch.edits !== undefined) throw new BotError("INVALID_INPUT", "Use prompt or edits, not both.");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(current);
      for (const key of ["description", "model", "thinking", "inherit", "tools", "excludeTools", "excludeExtensions", "excludeMcpServers", "builtinTools", "skills", "maintenance"] as const) {
        if (patch[key] === null) delete frontmatter[key];
        else if (patch[key] !== undefined) frontmatter[key] = patch[key];
      }
      const prompt = patch.prompt ?? (patch.edits ? applyTextEdits(body, patch.edits) : body);
      // JSON flow values are valid YAML and preserve unknown frontmatter values.
      next = `---\n${Object.entries(frontmatter).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${prompt.trim()}\n`;
    }
    parseDefinition(next, sourceDir);
    // SDK maintenance shares this lock. External editors/shells do not; detect observed changes
    // but do not claim this comparison is a cross-process filesystem CAS.
    if (await readFile(file, "utf8") !== current) throw new BotError("CONFLICT", "BOT.md changed while editing; reload it and retry.");
    const temporary = join(sourceDir, `.sdk-definition-${randomUUID()}.tmp`);
    try { await writeFile(temporary, next.endsWith("\n") ? next : `${next}\n`, { flag: "wx" }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    return { sourceDir, definition: next };
  } finally { await release(); }
}
/** Administrative operation. Callers such as the Pi UI must obtain human confirmation. */
export async function archiveBot(source: string): Promise<string> {
  const sourceDir = await resolveSource(source);
  const release = await acquireLock(join(sourceDir, ".sdk-source.lock"));
  let definitionRelease: (() => Promise<void>) | undefined;
  try {
    definitionRelease = await acquireLock(join(sourceDir, ".sdk-definition.lock"));
    const target = resolve(dirname(sourceDir), ".archive", `${basename(sourceDir)}-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(dirname(target), { recursive: true });
    await rename(sourceDir, target);
    return target;
  } finally { await definitionRelease?.(); await release(); }
}
export { inspectBot };
