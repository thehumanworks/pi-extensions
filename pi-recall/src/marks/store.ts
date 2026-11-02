import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Project, ProjectIndex } from "../projects.ts";
import type { ReadonlySession, SessionSource } from "../sessions.ts";

export type MarkOp = "mark" | "unmark" | "review";
export type Marker = "user" | "agent";

/** One line of the marks log. The log is append-only: the latest event on a message decides its state. */
export interface MarkEvent {
  v: 1;
  /** ISO 8601 */
  at: string;
  op: MarkOp;
  /** The marked message, as `<sessionId>/<entryId>`. */
  ref: string;
  by: Marker;
  reason?: string;
  /** The session the action was taken in. */
  session: string;
}

export interface MarkState {
  ref: string;
  sessionId: string;
  entryId: string;
  /** Whether the message is marked critical. */
  marked: boolean;
  /** Who made the latest mark or unmark, when, and why. */
  by: Marker;
  at: string;
  reason?: string;
  /** False until the user has seen an agent's mark or unmark: made by the user, or reviewed since. */
  reviewed: boolean;
}

const OPS = new Set<string>(["mark", "unmark", "review"]);
const MARKERS = new Set<string>(["user", "agent"]);

function parse(line: string): MarkEvent | undefined {
  try {
    const event = JSON.parse(line) as MarkEvent;
    const valid = event && OPS.has(event.op) && MARKERS.has(event.by) && typeof event.ref === "string" && event.ref.includes("/") && typeof event.at === "string";
    return valid ? event : undefined;
  } catch {
    return undefined;
  }
}

/** The state of each message the log mentions, by ref. */
export function fold(events: MarkEvent[]): Map<string, MarkState> {
  const states = new Map<string, MarkState>();
  for (const event of events) {
    const previous = states.get(event.ref);
    if (event.op === "review") {
      if (previous) previous.reviewed = true;
      continue;
    }
    const slash = event.ref.indexOf("/");
    states.set(event.ref, {
      ref: event.ref,
      sessionId: event.ref.slice(0, slash),
      entryId: event.ref.slice(slash + 1),
      marked: event.op === "mark",
      by: event.by,
      at: event.at,
      ...(event.reason ? { reason: event.reason } : {}),
      reviewed: event.by === "user",
    });
  }
  return states;
}

/** The project's marks: a log beside its session files, which pi never reads since it is in a subdirectory. */
export class MarkStore {
  constructor(readonly path: string) {}

  static forDir(sessionDir: string): MarkStore {
    return new MarkStore(join(sessionDir, "pi-recall", "marks.jsonl"));
  }

  static forSession(sm: Pick<ReadonlySession, "getSessionDir">): MarkStore {
    return MarkStore.forDir(sm.getSessionDir());
  }

  /** The store kept with a session's project, where marks on its messages go. */
  static forSessionId(index: ProjectIndex, sessionId: string): MarkStore {
    return MarkStore.forDir((index.sessions.get(sessionId) ?? index.current).sessionDir);
  }

  /** Every event in the log, oldest first, skipping lines that do not parse. */
  async events(): Promise<MarkEvent[]> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return content.split("\n").filter(Boolean).flatMap((line) => parse(line) ?? []);
  }

  async states(): Promise<Map<string, MarkState>> {
    return fold(await this.events());
  }

  /** Appends one event as a single line, so writers in other pi processes do not interleave with it. */
  async append(event: Omit<MarkEvent, "v" | "at"> & { at?: string }): Promise<MarkEvent> {
    const line: MarkEvent = { v: 1, at: event.at ?? new Date().toISOString(), op: event.op, ref: event.ref, by: event.by, ...(event.reason ? { reason: event.reason } : {}), session: event.session };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(line)}\n`, "utf8");
    return line;
  }
}

/**
 * The marks on these projects' sessions, by ref. A session directory set in pi's settings holds every
 * project's sessions and so every project's marks, which are left out.
 */
export async function loadMarks(index: ProjectIndex, projects: Project[]): Promise<Map<string, MarkState>> {
  const paths = new Set(projects.map((project) => project.path));
  const dirs = [...new Set(projects.map((project) => project.sessionDir).filter(Boolean))];
  const merged = new Map<string, MarkState>();
  for (const dir of dirs) {
    for (const [ref, state] of await MarkStore.forDir(dir).states()) {
      if (paths.has(index.sessions.get(state.sessionId)?.path ?? "")) merged.set(ref, state);
    }
  }
  return merged;
}

/** Marks waiting for the user to see them: an agent's marks and unmarks not yet reviewed. */
export const unreviewed = (states: Map<string, MarkState>) => [...states.values()].filter((state) => !state.reviewed);

/**
 * The mark on an entry as a session shows it. A fork copies its parent's entries with their ids, so an
 * entry also carries the marks made on it in the sessions it was forked from.
 */
export function markLookup(states: Map<string, MarkState>, sources: SessionSource[]) {
  const parents = new Map(sources.map(({ summary }) => [summary.sessionId, summary.parentSessionId]));
  return (sessionId: string, entryId: string): MarkState | undefined => {
    const seen = new Set<string>();
    for (let sid: string | undefined = sessionId; sid !== undefined && !seen.has(sid); sid = parents.get(sid)) {
      seen.add(sid);
      const state = states.get(`${sid}/${entryId}`);
      if (state) return state;
    }
    return undefined;
  };
}
