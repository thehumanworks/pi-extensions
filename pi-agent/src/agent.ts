import { readFileSync, type PathLike } from "node:fs";
import YAML from "yaml";

// Agent definition files follow Claude Code's subagent format:
// https://code.claude.com/docs/en/sub-agents.md

export const PERMISSION_MODES = ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"] as const;
export const MEMORY_SCOPES = ["user", "project", "local"] as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;
export const CACHE_TTLS = ["5m", "1h"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type AgentColor = (typeof COLORS)[number];
export type CacheTtl = (typeof CACHE_TTLS)[number];

/** A server name already configured in the session, or `{ name: config }` defined inline. */
export type McpServerSpec = string | Record<string, Record<string, unknown>>;

export type HookCommand = { type: string; command?: string; [key: string]: unknown };
export type HookMatcher = { matcher?: string; hooks: HookCommand[] };

export type AgentDefinition = {
  name: string;
  description: string;
  /** Omitted inherits every available tool. */
  tools?: string[];
  disallowedTools?: string[];
  /** An alias (`sonnet`, `opus`, `haiku`, `fable`), a full model ID, or `inherit`. */
  model?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  skills?: string[];
  mcpServers?: McpServerSpec[];
  hooks?: Record<string, HookMatcher[]>;
  memory?: MemoryScope;
  background?: boolean;
  effort?: EffortLevel;
  isolation?: "worktree";
  color?: AgentColor;
  initialPrompt?: string;
  experimental?: { cacheTtl?: CacheTtl };
};

export type AgentFile = {
  definition: AgentDefinition;
  /** The Markdown body, used as the agent's system prompt. */
  prompt: string;
  /** Every parsed frontmatter key, including ones this parser does not know. */
  frontmatter: Record<string, unknown>;
};

export class AgentDefinitionError extends Error {
  constructor(message: string, readonly source?: string) {
    super(source ? `${source}: ${message}` : message);
    this.name = "AgentDefinitionError";
  }
}

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Splits a file into raw frontmatter and body. The opening `---` must be the first line. */
export function splitFrontmatter(content: string): { frontmatter?: string; body: string } {
  const text = content.replace(/^\uFEFF/, "");
  const match = FRONTMATTER.exec(text);
  if (!match) return { body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

/**
 * Parses an agent definition file. Returns undefined for a file that Claude Code would treat
 * as documentation: one without frontmatter or without a `name`. Throws AgentDefinitionError
 * for a file Claude Code would skip as invalid.
 */
export function parseAgentDefinition(content: string, source?: string): AgentFile | undefined {
  const { frontmatter: raw, body } = splitFrontmatter(content);
  if (raw === undefined) return undefined;

  const fail = (message: string): never => {
    throw new AgentDefinitionError(message, source);
  };

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    return fail(`invalid frontmatter YAML: ${(error as Error).message}`);
  }
  if (parsed == null) return undefined;
  if (!isRecord(parsed)) return fail("frontmatter must be a YAML mapping");
  const fm = parsed;
  if (fm.name == null) return undefined;

  const name = scalarString(fm.name, "name", fail);
  if (!name) fail("name must not be empty");
  if (name.startsWith("-")) fail(`name "${name}" must not start with "-"`);
  if (name.includes(":")) fail(`name "${name}" must not contain ":", which is reserved for plugin agents`);

  const description = fm.description == null ? fail("description is required") : scalarString(fm.description, "description", fail);
  if (!description.trim()) fail("description must not be empty");

  const definition: AgentDefinition = { name, description };
  const set = <K extends keyof AgentDefinition>(key: K, value: AgentDefinition[K] | undefined) => {
    if (value !== undefined) definition[key] = value;
  };

  set("tools", optional(fm.tools, (v) => toolList(v, "tools", fail)));
  set("disallowedTools", optional(fm.disallowedTools, (v) => toolList(v, "disallowedTools", fail)));
  set("model", optional(fm.model, (v) => scalarString(v, "model", fail)));
  set("permissionMode", optional(fm.permissionMode, (v) => {
    const mode = scalarString(v, "permissionMode", fail);
    return oneOf(mode === "manual" ? "default" : mode, PERMISSION_MODES, "permissionMode", fail);
  }));
  set("maxTurns", optional(fm.maxTurns, (v) => {
    const turns = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
    if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1) fail("maxTurns must be a positive integer");
    return turns as number;
  }));
  set("skills", optional(fm.skills, (v) => toolList(v, "skills", fail)));
  set("mcpServers", optional(fm.mcpServers, (v) => mcpServers(v, fail)));
  set("hooks", optional(fm.hooks, (v) => hooks(v, fail)));
  set("memory", optional(fm.memory, (v) => oneOf(v, MEMORY_SCOPES, "memory", fail)));
  set("background", optional(fm.background, (v) => {
    if (typeof v !== "boolean") fail("background must be true or false");
    return v as boolean;
  }));
  set("effort", optional(fm.effort, (v) => oneOf(v, EFFORT_LEVELS, "effort", fail)));
  set("isolation", optional(fm.isolation, (v) => oneOf(v, ["worktree"] as const, "isolation", fail)));
  set("color", optional(fm.color, (v) => oneOf(v, COLORS, "color", fail)));
  set("initialPrompt", optional(fm.initialPrompt, (v) => scalarString(v, "initialPrompt", fail)));
  set("experimental", optional(fm.experimental, (v) => {
    if (!isRecord(v)) fail("experimental must be a mapping");
    // Claude Code ignores any cacheTtl other than 5m or 1h.
    const ttl = (v as Record<string, unknown>).cacheTtl;
    return CACHE_TTLS.includes(ttl as CacheTtl) ? { cacheTtl: ttl as CacheTtl } : {};
  }));

  return { definition, prompt: body.trim(), frontmatter: fm };
}

export function loadAgentDefinition(filePath: PathLike): AgentFile | undefined {
  const path = filePath.toString();
  return parseAgentDefinition(readFileSync(path, "utf8"), path);
}

type Fail = (message: string) => never;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value == null ? undefined : parse(value);
}

// YAML reads `name: 123` or `model: 4.5` as numbers; the field still means the written text.
function scalarString(value: unknown, field: string, fail: Fail): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fail(`${field} must be a string`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fail: Fail): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  return fail(`${field} must be one of ${allowed.join(", ")}`);
}

/**
 * Accepts a comma-separated string or a YAML list. Commas inside parentheses stay with
 * their entry, so `Agent(worker, researcher), Read` yields two entries.
 */
function toolList(value: unknown, field: string, fail: Fail): string[] {
  const entries = Array.isArray(value)
    ? value.map((entry) => scalarString(entry, field, fail))
    : splitTopLevel(scalarString(value, field, fail));
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function mcpServers(value: unknown, fail: Fail): McpServerSpec[] {
  if (!Array.isArray(value)) fail("mcpServers must be a list");
  return (value as unknown[]).map((entry) => {
    if (typeof entry === "string") return entry;
    if (isRecord(entry) && Object.values(entry).every(isRecord)) return entry as Record<string, Record<string, unknown>>;
    return fail("each mcpServers entry must be a server name or a mapping of name to server config");
  });
}

function hooks(value: unknown, fail: Fail): Record<string, HookMatcher[]> {
  if (!isRecord(value)) fail("hooks must be a mapping of event name to matchers");
  const result: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) fail(`hooks.${event} must be a list`);
    result[event] = (matchers as unknown[]).map((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) fail(`each hooks.${event} entry needs a hooks list`);
      const matcher = (entry as Record<string, unknown>).matcher;
      if (matcher != null && typeof matcher !== "string") fail(`hooks.${event} matcher must be a string`);
      const commands = ((entry as Record<string, unknown>).hooks as unknown[]).map((hook) => {
        if (!isRecord(hook) || typeof hook.type !== "string") fail(`each hooks.${event} hook needs a type`);
        return hook as HookCommand;
      });
      return matcher == null ? { hooks: commands } : { matcher: matcher as string, hooks: commands };
    });
  }
  return result;
}
