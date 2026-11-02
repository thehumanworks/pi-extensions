import { isRecalled, type RecalledEntry, sessionView } from "../entries.ts";
import type { ProjectIndex } from "../projects.ts";
import { listSessions, type ReadonlySession, type SessionSource } from "../sessions.ts";
import { isMessage } from "../trace.ts";

/** Targets for messages the agent cannot name by id, since they are still in its context. */
export const RELATIVE_TARGETS = ["last_user", "previous_reply"] as const;

export interface Target {
  sessionId: string;
  entry: RecalledEntry;
  /** The sessions of the target's project, which marks on forked sessions are looked up in. */
  sources: SessionSource[];
}

const hasText = (entry: RecalledEntry) =>
  entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((b) => b.type === "text" && b.text.trim() !== "");

/**
 * The message a target names: the user's latest message on the current branch, the reply before it, or a
 * ref or id from the recall tools, in any project. A bare id is looked up in the current session. A tool
 * call or output resolves to the message it belongs to, so marks are always on messages.
 */
export async function resolveTarget(sm: ReadonlySession, index: ProjectIndex, target: string, signal?: AbortSignal): Promise<Target> {
  const current = sm.getSessionId();
  if (target === "last_user" || target === "previous_reply") {
    const sources = await listSessions(sm, [index.current], signal);
    const branch = sm.getBranch().filter(isRecalled);
    const user = branch.findLastIndex((e) => e.type === "message" && e.message.role === "user");
    if (user === -1) throw new Error("No user message in this session yet");
    if (target === "last_user") return { sessionId: current, entry: branch[user]!, sources };
    const reply = branch.slice(0, user).findLast(hasText);
    if (!reply) throw new Error("No reply before the user's latest message");
    return { sessionId: current, entry: reply, sources };
  }

  const slash = target.indexOf("/");
  const sessionId = slash === -1 ? current : target.slice(0, slash);
  const entryId = slash === -1 ? target : target.slice(slash + 1);
  const project = index.sessions.get(sessionId);
  if (!project) throw new Error(`Session ${sessionId} not found`);
  const sources = await listSessions(sm, [project], signal);
  const source = sources.find((s) => s.summary.sessionId === sessionId);
  if (!source) throw new Error(`Session ${sessionId} not found`);
  const view = sessionView(await source.load(), false);
  const at = view.entries.findIndex((e) => e.id === entryId);
  if (at === -1) throw new Error(view.excluded(entryId) ?? `Entry ${entryId} not found on the active branch of session ${sessionId}`);
  const owner = view.entries.slice(0, at + 1).findLast(isMessage);
  if (!owner) throw new Error(`Entry ${entryId} belongs to no message`);
  return { sessionId, entry: owner, sources };
}
