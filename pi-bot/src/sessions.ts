import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager, type ExtensionContext, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { expandHome, isInside } from "./bots.ts";

/** A session file name in Pi's own `<timestamp>_<id>.jsonl` format. */
export function newSessionPath(dir: string, id: string = randomUUID()): string {
  return join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
}

/**
 * Path for a fresh session that will record `cwd`. Pi opens a missing path as an empty session
 * bound to process.cwd() and only writes it once a message exists. When the runtime cwd differs,
 * the header is written now so the session is not attributed to the wrong project.
 */
export async function freshSessionFile(dir: string, cwd: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const id = randomUUID(), path = newSessionPath(dir, id);
  if (resolve(cwd) !== resolve(process.cwd())) {
    const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: new Date().toISOString(), cwd: resolve(cwd) };
    await writeFile(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
  }
  return path;
}

/**
 * Keep the selected conversation in `dir` without changing its identity, history or cwd.
 * Copy rather than move existing history: opening an ordinary session as a bot must not
 * destroy the original. Exclusive creation also prevents overwriting an earlier copy.
 * Explicit in-memory sessions (--no-session) stay ephemeral.
 *
 * Pi currently exposes no storage setter to extensions. Its context holds the actual
 * SessionManager behind a read-only type. Keep that compatibility boundary here: use
 * setSessionFile() to reload a complete snapshot, and scope the public directory getters
 * used by /new, /fork and /resume. No private SessionManager fields are changed.
 */
export async function storeSessionIn(sessions: ExtensionContext["sessionManager"], dir: string): Promise<void> {
  const file = sessions.getSessionFile();
  if (!file) return;
  const sameDir = (a: string, b: string) => isInside(a, b) && isInside(b, a);
  const relocate = !sameDir(dirname(file), dir);
  if (!relocate && sameDir(sessions.getSessionDir(), dir)) return;

  const manager = sessions as SessionManager;
  if (typeof manager.setSessionFile !== "function") throw new Error("This Pi version cannot redirect bot session storage.");
  await mkdir(dir, { recursive: true });
  if (relocate) {
    const header = sessions.getHeader();
    if (!header) throw new Error("Cannot redirect a session without a header.");
    const path = join(dir, basename(file));
    const leaf = sessions.getLeafId();
    const snapshot = [header, ...sessions.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(path, snapshot, { flag: "wx" });
    manager.setSessionFile(path);
    if (leaf === null) manager.resetLeaf(); else manager.branch(leaf);
  }
  manager.getSessionDir = () => dir;
  manager.usesDefaultSessionDir = () => false;
}

/** Sessions stored in a bot's sessions directory, across all projects, newest first. */
export async function listSessions(dir: string): Promise<SessionInfo[]> {
  const sessions = await SessionManager.listAll(dir);
  return [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Exact id or path, else a unique id prefix (ids are time-ordered UUIDv7, so short prefixes collide). */
export function findSession(sessions: SessionInfo[], ref: string): SessionInfo | undefined {
  const exact = sessions.find(s => s.id === ref || s.path === ref);
  if (exact) return exact;
  const matches = sessions.filter(s => s.id.startsWith(ref));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Locate a session file by the id from a JSON-mode session header. */
export async function sessionFileForId(dir: string, id: string): Promise<string | undefined> {
  try {
    const file = (await readdir(dir)).find(name => name.endsWith(`_${id}.jsonl`));
    return file ? join(dir, file) : undefined;
  } catch { return undefined; }
}

/** Where Pi keeps ordinary sessions for `cwd`, honoring the env override and sessionDir setting. */
export function defaultSessionDir(cwd: string, agentDir: string, settingsDir?: string): string {
  const configured = process.env.PI_CODING_AGENT_SESSION_DIR || settingsDir;
  if (configured) return resolve(expandHome(configured));
  const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", encoded);
}

export function describeSession(session: SessionInfo): string {
  const when = session.modified.toISOString().slice(0, 16).replace("T", " ");
  const title = (session.name || session.firstMessage || "(empty)").replace(/\s+/g, " ").slice(0, 70);
  return `${when} · ${session.cwd || "?"} · ${title}`;
}
