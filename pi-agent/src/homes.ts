import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Each agent is assigned a home when it first starts: a directory named after the agent in one
// global workspaces directory under Pi's agent directory. The home is the cwd of the agent's
// sessions, so Pi loads the home's AGENTS.md and .pi/ resources and lists the agent's sessions
// under it, as for any project. Agent names are unique, so an agent keeps its home for good.

export const AGENT_WORKSPACES_DIR = "agent-workspaces";

export function agentWorkspacesDir(agentDir: string = getAgentDir()): string {
  return join(resolve(agentDir), AGENT_WORKSPACES_DIR);
}

export function agentHome(name: string, agentDir?: string): string {
  // Names come from frontmatter; keep them from reaching outside the workspaces directory.
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new Error(`agent name "${name}" cannot be used as a home directory name`);
  }
  return join(agentWorkspacesDir(agentDir), name);
}

/** Creates the agent's home on first use and returns it. */
export function ensureAgentHome(name: string, agentDir?: string): string {
  const home = agentHome(name, agentDir);
  mkdirSync(home, { recursive: true });
  return home;
}

/** The agent whose home `cwd` is, if it is one. */
export function homeOwner(cwd: string, agentDir?: string): string | undefined {
  const name = relative(agentWorkspacesDir(agentDir), resolve(cwd));
  return name && name !== ".." && !isAbsolute(name) && !/[/\\]/.test(name) ? name : undefined;
}
