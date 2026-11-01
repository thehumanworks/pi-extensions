import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import ignore, { type Ignore } from "ignore";
import { AgentDefinitionError, parseAgentDefinition, type AgentFile } from "./agent.ts";

// Discovery follows Pi's conventions for its own resources. Like skills, project definitions
// come first, the first definition of a name wins and later ones are reported as collisions,
// and project definitions load only when the project is trusted. Like prompt templates, each
// agent is a `.md` file directly inside an agents directory; ignore files, dot entries and
// node_modules are skipped.

export type AgentScope = "project" | "user";

export type DiscoveredAgent = AgentFile & {
  filePath: string;
  scope: AgentScope;
  /** The agents directory the file was found under. */
  baseDir: string;
};

export type AgentDiagnostic = {
  type: "warning" | "collision";
  message: string;
  path: string;
  collision?: { name: string; winnerPath: string; loserPath: string };
};

export type DiscoverAgentsOptions = {
  /** Working directory whose `.pi/agents` holds project definitions. */
  cwd: string;
  /** Project definitions can configure tools, hooks and MCP servers, so load them only once trusted. */
  projectTrusted: boolean;
  /** Pi's agent directory. Defaults to `getAgentDir()`, which honours PI_CODING_AGENT_DIR. */
  agentDir?: string;
};

export type DiscoverAgentsResult = {
  agents: DiscoveredAgent[];
  diagnostics: AgentDiagnostic[];
};

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** The directories searched, highest precedence first. */
export function agentDirectories(options: DiscoverAgentsOptions): { scope: AgentScope; dir: string }[] {
  const dirs: { scope: AgentScope; dir: string }[] = [];
  if (options.projectTrusted) dirs.push({ scope: "project", dir: resolve(options.cwd, CONFIG_DIR_NAME, "agents") });
  dirs.push({ scope: "user", dir: join(resolve(options.agentDir ?? getAgentDir()), "agents") });
  return dirs;
}

export function discoverAgents(options: DiscoverAgentsOptions): DiscoverAgentsResult {
  const byName = new Map<string, DiscoveredAgent>();
  const seenFiles = new Set<string>();
  const diagnostics: AgentDiagnostic[] = [];
  const collisions: AgentDiagnostic[] = [];

  for (const { scope, dir } of agentDirectories(options)) {
    for (const filePath of collectMarkdownFiles(dir)) {
      // The same file reached twice, for example through a symlink, is not a collision.
      const realPath = canonicalPath(filePath);
      if (seenFiles.has(realPath)) continue;

      const file = readAgentFile(filePath, diagnostics);
      if (!file) continue;

      const name = file.definition.name;
      const winner = byName.get(name);
      if (winner) {
        collisions.push({
          type: "collision",
          message: `agent name "${name}" collision`,
          path: filePath,
          collision: { name, winnerPath: winner.filePath, loserPath: filePath },
        });
        continue;
      }
      byName.set(name, { ...file, filePath, scope, baseDir: dir });
      seenFiles.add(realPath);
    }
  }

  return { agents: [...byName.values()], diagnostics: [...diagnostics, ...collisions] };
}

function readAgentFile(filePath: string, diagnostics: AgentDiagnostic[]): AgentFile | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    diagnostics.push({ type: "warning", message: errorMessage(error, "failed to read agent file"), path: filePath });
    return undefined;
  }
  try {
    // Files without frontmatter or a name are documentation kept beside the agents.
    return parseAgentDefinition(content);
  } catch (error) {
    if (!(error instanceof AgentDefinitionError)) throw error;
    diagnostics.push({ type: "warning", message: error.message, path: filePath });
    return undefined;
  }
}

/** The `.md` files directly inside dir, as Pi collects prompt templates. */
function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  const ig = ignore();
  addIgnoreRules(ig, dir);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = statSync(fullPath).isFile();
      } catch {
        continue; // Broken symlink.
      }
    }
    if (isFile && entry.name.endsWith(".md") && !ig.ignores(entry.name)) files.push(fullPath);
  }
  return files;
}

function addIgnoreRules(ig: Ignore, dir: string): void {
  for (const filename of IGNORE_FILE_NAMES) {
    let content: string;
    try {
      content = readFileSync(join(dir, filename), "utf8");
    } catch {
      continue;
    }
    const patterns = content
      .split(/\r?\n/)
      .map(normalizeIgnorePattern)
      .filter((line): line is string => line !== undefined);
    if (patterns.length > 0) ig.add(patterns);
  }
}

function normalizeIgnorePattern(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return undefined;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  return negated ? `!${pattern}` : pattern;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
