import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

// An agent session is an ordinary Pi session whose cwd is the agent's home. A custom entry
// records which agent it belongs to, so resuming or reloading the session restores the agent.

export const AGENT_ENTRY_TYPE = "pi-agent";

export type AgentSessionMarker = {
  name: string;
  /** The definition file the session was started from. */
  file: string;
  home: string;
};

/** The agent recorded on a session branch, if any. The latest marker wins. */
export function readAgentMarker(entries: readonly SessionEntry[]): AgentSessionMarker | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === AGENT_ENTRY_TYPE && isMarker(entry.data)) return entry.data;
  }
  return undefined;
}

/**
 * Writes a new session file rooted in the agent's home and returns its path. Pi only writes a
 * session once it holds a message, but switching to a session needs the file, so it is written
 * here with Pi's own header and the agent marker.
 *
 * `sessionDir` is a custom session directory; omitted, Pi's default directory for the home is used.
 */
export function createAgentSessionFile(marker: AgentSessionMarker, sessionDir?: string): string {
  const manager = SessionManager.create(marker.home, sessionDir);
  manager.appendCustomEntry(AGENT_ENTRY_TYPE, marker);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Pi did not create a session file for the agent");
  const lines = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(file, `${lines.join("\n")}\n`, { flag: "wx" });
  return file;
}

function isMarker(value: unknown): value is AgentSessionMarker {
  if (typeof value !== "object" || value === null) return false;
  const { name, file, home } = value as Record<string, unknown>;
  return typeof name === "string" && typeof file === "string" && typeof home === "string";
}

let scratch: string | undefined;

/**
 * A directory for agent sessions when Pi keeps no sessions (`--no-session`), removed when Pi
 * exits. Switching to the agent's session needs a file, so the session lives here meanwhile.
 */
export function scratchSessionDir(): string {
  if (scratch && existsSync(scratch)) return scratch;
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-sessions-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return (scratch = dir);
}

/** Pi's default session directory for a cwd, which Pi does not export. */
export function defaultSessionDir(cwd: string, agentDir: string = getAgentDir()): string {
  const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", encoded);
}
