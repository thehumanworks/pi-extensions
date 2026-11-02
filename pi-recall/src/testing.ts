import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionToolContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveScope, sessionFolderName } from "./projects.ts";
import { listSessions } from "./sessions.ts";

/** Saved sessions in one project; each message is later than every message before it from the same clock. */
function sessions(cwd: string, sessionDir: string, clock: { now: number }) {
  return {
    cwd,
    sessionDir,
    /** A saved session with one user message per text. */
    session(texts: string[] = [], options?: { parentSession?: string }) {
      const sm = SessionManager.create(cwd, sessionDir, options);
      for (const text of texts) sm.appendMessage({ role: "user", content: text, timestamp: (clock.now += 1000) });
      return sm;
    },
    user(sm: SessionManager, text: string) {
      return sm.appendMessage({ role: "user", content: text, timestamp: (clock.now += 1000) });
    },
  };
}

/** A project with its own session directory, so tests never touch ~/.pi. */
export async function project() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-recall-test-"));
  return sessions(cwd, join(cwd, "sessions"), { now: Date.UTC(2026, 10, 2) });
}

/**
 * Projects side by side in a temporary folder. Their sessions are kept as pi keeps them by default, in a folder
 * per project, or with shared: true in one folder, as when pi's settings set a session directory.
 */
export async function workspace(options: { shared?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-recall-test-"));
  const clock = { now: Date.UTC(2026, 10, 2) };
  return {
    root,
    async project(path: string) {
      const cwd = join(root, path);
      await mkdir(cwd, { recursive: true });
      return sessions(cwd, join(root, ".sessions", options.shared ? "" : sessionFolderName(cwd)), clock);
    },
  };
}

export function context(sm: SessionManager): ExtensionToolContext {
  return { sessionManager: sm } as unknown as ExtensionToolContext;
}

/** The sessions the recall tools read by default: this project's and those its .recallrc lists. */
export async function listProjectSessions(sm: SessionManager) {
  return listSessions(sm, (await resolveScope(sm)).projects);
}
