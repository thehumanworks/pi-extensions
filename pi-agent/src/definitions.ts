import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = typeof thinkingLevels[number];
export interface Definition {
  name: string;
  description: string;
  home: string;
  prompt: string;
  model?: string;
  thinking?: Thinking;
  tools?: string[];
  skills?: string[];
  excludeTools?: string[];
  readonly: boolean;
  metadata: Record<string, unknown>;
  warnings: string[];
  unsupported: string[];
}

export function checkName(name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("Agent names must be lowercase letters/numbers separated by single hyphens (max 64 characters).");
  }
  return name;
}

export function expandPath(path: string, base: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function split(source: string) {
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error("Agent definitions must be smaller than 1 MiB.");
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Expected Markdown with YAML frontmatter enclosed by --- lines.");
  const doc = YAML.parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Invalid YAML: ${doc.errors.map(e => e.message).join("; ")}`);
  const metadata: unknown = doc.toJS({ maxAliasCount: 50 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Frontmatter must be a mapping.");
  return { doc, metadata: metadata as Record<string, unknown>, prompt: match[2].trim() };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string.`);
  return value.trim();
}

const aliases: Record<string, string> = { Read: "read", Write: "write", Edit: "edit", Bash: "bash", Grep: "grep", Glob: "find", LS: "ls", Agent: "agent_run", Task: "agent_run" };
export function normalizeTool(name: string): string {
  if (!/^[\w.*-]+$/.test(name)) throw new Error(`Unsupported tool selector: ${name}. Use Pi tool names (not vendor permission expressions).`);
  return aliases[name] ?? name;
}
function list(value: unknown, field: string, commaSeparated = false): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (commaSeparated && typeof value === "string") value = value.split(",").map(s => s.trim()).filter(Boolean);
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim())) throw new Error(`${field} must be a list of names.`);
  return [...new Set((value as string[]).map(v => v.trim()))];
}

export function parseDefinition(source: string, file: string, defaultHomes: string): Definition {
  const { metadata: m, prompt } = split(source);
  const name = checkName(optionalString(m.name, "name") ?? basename(file, ".md"));
  const model = optionalString(m.model, "model");
  const home = optionalString(m.home, "home");
  const thinking = optionalString(m.thinking ?? m.effort, "thinking");
  if (thinking && thinking !== "inherit" && !thinkingLevels.includes(thinking as Thinking)) throw new Error(`Unsupported thinking effort: ${thinking}`);
  if (m.readonly !== undefined && typeof m.readonly !== "boolean") throw new Error("readonly must be boolean.");
  const known = new Set(["name", "description", "model", "thinking", "effort", "home", "tools", "skills", "disallowedTools", "readonly"]);
  // Preserve foreign fields without pretending their runtime semantics exist in Pi.
  const unsupported = ["permissionMode", "hooks", "mcpServers", "isolation", "maxTurns", "autoCompactWindow", "initialPrompt", "memory", "omitClaudeMd"].filter(k => m[k] !== undefined);
  if (m.is_background === true || m.background === true) unsupported.push("background execution (use agent_loop instead)");
  return {
    name, description: optionalString(m.description, "description") ?? "",
    home: home === undefined ? join(defaultHomes, name) : expandPath(home, dirname(file)),
    prompt, model: !model || ["inherit", "default"].includes(model) ? undefined : model,
    thinking: thinking === "inherit" ? undefined : thinking as Thinking | undefined,
    tools: list(m.tools, "tools", true)?.map(normalizeTool),
    excludeTools: list(m.disallowedTools, "disallowedTools", true)?.map(normalizeTool),
    skills: list(m.skills, "skills"), readonly: m.readonly === true, metadata: m,
    warnings: Object.keys(m).filter(k => !known.has(k)).map(k => `Preserved foreign field '${k}'; Pi does not implement it.`), unsupported,
  };
}

/** YAML's document API retains foreign keys and comments during additive normalization. */
export function withHome(source: string, home: string): string {
  const { doc, prompt } = split(source);
  doc.set("home", home);
  return `---\n${doc.toString()}---\n\n${prompt}\n`;
}

export function newDefinition(name: string, description: string, prompt: string, home: string): string {
  checkName(name);
  return `---\n${YAML.stringify({ name, description, home })}---\n\n${prompt}\n`;
}

export function matchesTool(pattern: string, name: string): boolean {
  return new RegExp(`^${pattern.split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);
}
export function permitsTool(def: Definition, name: string): boolean {
  if (def.readonly && !["read", "grep", "find", "ls"].includes(name)) return false;
  return (def.tools === undefined || def.tools.some(p => matchesTool(p, name))) && !def.excludeTools?.some(p => matchesTool(p, name));
}
