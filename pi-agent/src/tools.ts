import type { AgentDefinition } from "./agent.ts";

// An agent's `tools` field is an allowlist and `disallowedTools` a denylist, as in Claude Code:
// an allowlist grants only what it names, MCP tools included, and the denylist removes tools
// from whatever remains. Entries are tool names or Pi's `*` patterns. Claude Code's tool names
// are translated to Pi's, so definitions written for Claude Code grant the equivalent Pi tools.

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "bash",
  PowerShell: "powershell",
  Grep: "grep",
  Glob: "find",
  LS: "ls",
};

// Claude Code tools this package cannot provide yet. Agent and Task spawn subagents.
const UNAVAILABLE_TOOLS = new Set(["Agent", "Task"]);

export type ToolPolicy = {
  /** Whether the agent may call the tool, directly or from another tool such as codemode. */
  allows: (name: string) => boolean;
  /** Whether the policy restricts anything; false when the agent sets neither field. */
  restricted: boolean;
  warnings: string[];
};

export function toolPolicy(definition: AgentDefinition): ToolPolicy {
  const warnings: string[] = [];
  const { tools, disallowedTools } = definition;
  const granted = tools === undefined ? undefined : createToolNameMatcher(translateEntries(tools, "tools", warnings));
  const denied =
    disallowedTools === undefined ? undefined : createToolNameMatcher(translateEntries(disallowedTools, "disallowedTools", warnings));
  return {
    allows: (name) => (granted?.(name) ?? true) && !denied?.(name),
    restricted: tools !== undefined || disallowedTools !== undefined,
    warnings,
  };
}

type RegisteredTool = { name: string; exposure?: string };

/**
 * The tools to declare to the model. An allowlist declares every registered tool it grants; an
 * agent with only a denylist keeps Pi's selection minus the denied tools.
 */
export function activeTools(
  definition: AgentDefinition,
  policy: ToolPolicy,
  registered: readonly RegisteredTool[],
  active: readonly string[],
): string[] {
  if (definition.tools === undefined) return active.filter(policy.allows);
  return registered.filter((tool) => tool.exposure !== "hidden" && policy.allows(tool.name)).map((tool) => tool.name);
}

/** Allowlist entries that match no registered tool, worth a warning when the session starts. */
export function unmatchedTools(definition: AgentDefinition, registered: readonly RegisteredTool[]): string[] {
  const entries = translateEntries(definition.tools ?? [], "tools", []);
  return entries.filter((entry) => {
    const matches = createToolNameMatcher([entry]);
    return !registered.some((tool) => matches(tool.name));
  });
}

function translateEntries(entries: readonly string[], field: string, warnings: string[]): string[] {
  const translated: string[] = [];
  for (const entry of entries) {
    const open = entry.indexOf("(");
    const base = open === -1 ? entry : entry.slice(0, open).trim();
    if (UNAVAILABLE_TOOLS.has(base)) {
      if (field === "tools") warnings.push(`${field}: "${entry}" is not available in Pi yet`);
      continue;
    }
    if (open !== -1) {
      // A denylist rule such as Bash(rm:*) denies part of a tool; denying the whole tool is the
      // closest safe reading. An allowlist rule grants part of one; granting nothing is.
      warnings.push(
        field === "disallowedTools"
          ? `${field}: permission rule "${entry}" is not supported, so all of ${base} is denied`
          : `${field}: permission rule "${entry}" is not supported and grants nothing`,
      );
      if (field === "disallowedTools") translated.push(CLAUDE_TOOL_NAMES[base] ?? base);
      continue;
    }
    // Claude Code names all of an MCP server's tools as mcp__<server>.
    if (entry.startsWith("mcp__") && !entry.includes("*") && !entry.slice(5).includes("__")) {
      translated.push(`${entry}__*`);
      continue;
    }
    translated.push(CLAUDE_TOOL_NAMES[entry] ?? entry);
  }
  return [...new Set(translated)];
}

/** Mirrors Pi's matcher for `--tools`: exact names, or patterns where `*` matches any characters. */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
  const names = new Set(entries.filter((entry) => !entry.includes("*")));
  const patterns = entries
    .filter((entry) => entry.includes("*"))
    .map((entry) => new RegExp(`^${entry.split("*").map(escapeRegExp).join(".*")}$`));
  return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
