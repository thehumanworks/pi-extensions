import { type ExtensionContext, defineTool } from "@earendil-works/pi-coding-agent";
import { type JsonObject, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type EntryNotes, type RecalledEntry, type SessionView, sessionView } from "./entries.ts";
import { formatEntry, OUTPUT_MODES, type OutputMode } from "./format.ts";
import { jsonResult, TRUNCATION_NOTE } from "./result.ts";
import { ALL_PROJECTS, resolveScope, type ScopeContext } from "./projects.ts";
import { listSessions, type SessionSource, sourcesWith } from "./sessions.ts";
import { loadMarks, markLookup } from "./marks/store.ts";
import { isMessage, traceOf } from "./trace.ts";

export const MAX_LIMIT = 20;

/** The project parameter, as the recall tools describe it. */
export const PROJECT_DESCRIPTION =
  `Another project to read: its path, or the last folders of its path such as "pi-memory"; "${ALL_PROJECTS}" for every project. ` +
  "Omit for this project and the projects recallConfig names for it";

export interface HistoryOptions {
  /** Read only this session instead of the whole project. */
  sessionId?: string;
  /** Cursor: return the entries just before this one. */
  before?: string;
  /** Cursor: return entries starting with this one. */
  from?: string;
  limit?: number;
  /** Also return current-session entries that are still in the model's context. */
  includeContext?: boolean;
  /** The sessions to read, newest first; by default this project's and those recallConfig names for it. */
  sources?: SessionSource[];
  /**
   * Entries to leave out of this read. Each belongs to the shown entry before it: a from cursor at one starts
   * there, and a before cursor at one ends after it.
   */
  hidden?: (entry: RecalledEntry, view: SessionView) => boolean;
  /** The size of an entry as returned, and the most a page may hold. A page always has one entry. */
  budget?: { size(entry: RecalledEntry, group: HistoryGroup): number; max: number };
  signal?: AbortSignal;
}

export interface RecallOptions extends Omit<HistoryOptions, "sources" | "hidden" | "budget"> {
  outputMode?: OutputMode;
  /** A project to read instead: a path, the last folders of one, or "all". */
  project?: string;
}

export interface HistoryGroup {
  source: SessionSource;
  view: SessionView;
  entries: RecalledEntry[];
  notes(id: string): EntryNotes;
}

/** An entry in the project's history: index into the sources (newest session first) and into its entries. */
interface Position {
  s: number;
  i: number;
}

/**
 * Entries from the project's sessions, read as one history: sessions ordered by last activity, entries in
 * branch order within each, never interleaved. Without a cursor, returns the newest entries.
 */
export async function readHistory(ctx: ScopeContext, options: HistoryOptions = {}) {
  const { sessionId, before, from, limit = MAX_LIMIT, includeContext = false, signal } = options;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (before !== undefined && from !== undefined) {
    throw new Error("Pass either before or from, not both");
  }

  let sources = options.sources ?? (await listSessions(ctx.sessionManager, (await resolveScope(ctx)).projects, signal));
  if (sessionId !== undefined) {
    sources = sources.filter((source) => source.summary.sessionId === sessionId);
    if (sources.length === 0) throw new Error(`Session ${sessionId} not found`);
  }

  /** Each session's view and the entries this read shows, in branch order. */
  const views = new Map<number, Promise<{ v: SessionView; shown: RecalledEntry[] }>>();
  const view = (s: number) => {
    let loaded = views.get(s);
    if (!loaded) {
      const source = sources[s]!;
      loaded = source.load().then((sm) => {
        const v = sessionView(sm, source.current && !includeContext);
        return { v, shown: options.hidden ? v.entries.filter((entry) => !options.hidden!(entry, v)) : v.entries };
      });
      views.set(s, loaded);
    }
    return loaded;
  };
  const size = async (s: number) => (await view(s)).shown.length;

  async function previous({ s, i }: Position): Promise<Position | null> {
    if (i > 0) return { s, i: i - 1 };
    for (let t = s + 1; t < sources.length; t++) {
      const n = await size(t);
      if (n > 0) return { s: t, i: n - 1 };
    }
    return null;
  }

  async function following({ s, i }: Position): Promise<Position | null> {
    if (i + 1 < (await size(s))) return { s, i: i + 1 };
    for (let t = s - 1; t >= 0; t--) {
      if ((await size(t)) > 0) return { s: t, i: 0 };
    }
    return null;
  }

  /**
   * The position of the cursor's entry. If it is hidden: for from, the shown entry it belongs to, the one
   * before it; for before, the first shown entry after it, so that the page ends with the one it belongs to.
   */
  async function resolve(cursor: string, owner: boolean): Promise<Position> {
    const slash = cursor.indexOf("/");
    const sid = slash === -1 ? (sessionId ?? ctx.sessionManager.getSessionId()) : cursor.slice(0, slash);
    const eid = slash === -1 ? cursor : cursor.slice(slash + 1);
    const s = sources.findIndex((source) => source.summary.sessionId === sid);
    if (s === -1) {
      throw new Error(sessionId === undefined ? `Session ${sid} not found` : `Cursor is outside session ${sessionId}`);
    }
    const { v, shown } = await view(s);
    const all = v.entries.findIndex((entry) => entry.id === eid);
    if (all === -1) throw new Error(v.excluded(eid) ?? `Entry ${eid} not found on the active branch of session ${sid}`);
    if (owner) {
      const upTo = new Set(v.entries.slice(0, all + 1).map((entry) => entry.id));
      const i = shown.findLastIndex((entry) => upTo.has(entry.id));
      if (i !== -1) return { s, i };
    }
    const rest = new Set(v.entries.slice(all).map((entry) => entry.id));
    const i = shown.findIndex((entry) => rest.has(entry.id));
    return { s, i: i === -1 ? shown.length : i };
  }

  const groupOf = async (s: number): Promise<HistoryGroup> => {
    const { v } = await view(s);
    return { source: sources[s]!, view: v, entries: [], notes: (id) => v.notes(id) };
  };
  const entryAt = async ({ s, i }: Position) => (await view(s)).shown[i]!;
  let used = 0;
  /** Whether the page has room for this entry; the first entry always fits. */
  const fits = async (pos: Position, pageSize: number) => {
    if (!options.budget) return true;
    const cost = options.budget.size(await entryAt(pos), await groupOf(pos.s));
    if (pageSize > 0 && used + cost > options.budget.max) return false;
    used += cost;
    return true;
  };

  const page: Position[] = [];
  let end: Position | null = null; // The entry after the page, when reading backwards from a cursor.
  if (from !== undefined) {
    let pos: Position | null = await resolve(from, true);
    if (pos.i >= (await size(pos.s))) pos = await following({ s: pos.s, i: pos.i - 1 });
    for (; pos && page.length < limit && (await fits(pos, page.length)); pos = await following(pos)) page.push(pos);
  } else {
    end = before !== undefined ? await resolve(before, false) : null;
    let pos = end ? await previous(end) : sources.length > 0 ? await previous({ s: 0, i: await size(0) }) : null;
    for (; pos && page.length < limit && (await fits(pos, page.length)); pos = await previous(pos)) page.unshift(pos);
    if (end && end.i >= (await size(end.s))) end = await following({ s: end.s, i: end.i - 1 });
  }

  const first = page[0];
  const last = page.at(-1);
  const cursor = async (pos: Position | null) =>
    pos ? `${sources[pos.s]!.summary.sessionId}/${(await entryAt(pos)).id}` : null;

  const groups: HistoryGroup[] = [];
  let s = -1;
  for (const pos of page) {
    if (pos.s !== s) groups.push(await groupOf(pos.s));
    groups.at(-1)!.entries.push(await entryAt(pos));
    s = pos.s;
  }

  return {
    groups,
    older: first && (await previous(first)) ? await cursor(first) : null,
    newer: last ? await cursor(await following(last)) : await cursor(end),
  };
}

/** The most a page of messages holds, as the indented JSON the tool returns. */
export const PAGE_MAX_CHARS = 16000;

/**
 * readHistory formatted for the model, at most MAX_LIMIT entries per page. The messages view shows messages
 * with the tool calls after each as its trace, and limit counts messages; full shows every entry.
 */
export async function recall(ctx: ScopeContext, options: RecallOptions = {}) {
  const { limit = MAX_LIMIT, outputMode = "messages" } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (!OUTPUT_MODES.includes(outputMode)) throw new Error(`outputMode must be one of ${OUTPUT_MODES.join(", ")}`);
  const sm = ctx.sessionManager;
  const scope = await resolveScope(ctx, options.project);
  let sources = await listSessions(sm, scope.projects, options.signal);
  // A session or cursor from another project reads that project.
  const cursor = options.from ?? options.before;
  const sessionId = options.sessionId ?? (cursor?.includes("/") ? cursor.slice(0, cursor.indexOf("/")) : undefined);
  if (sessionId !== undefined) sources = await sourcesWith(sm, scope, sources, sessionId, options.signal);
  const projects = [...new Set(sources.map((source) => source.project))];
  const markOf = outputMode === "messages" ? markLookup(await loadMarks(scope.index, projects), sources) : undefined;
  type Formatted = ReturnType<typeof formatEntry> & { trace?: JsonObject; mark?: JsonObject };
  const formatted = new Map<RecalledEntry, Formatted>();
  const format = (entry: RecalledEntry, group: HistoryGroup) => {
    let result = formatted.get(entry);
    if (!result) {
      result = formatEntry(entry, outputMode, group.notes(entry.id)) as Formatted;
      if (outputMode === "messages") {
        const mark = markOf?.(group.source.summary.sessionId, entry.id);
        if (mark?.marked) result = { ...result, mark: { by: mark.by, at: mark.at, reviewed: mark.reviewed, ...(mark.reason ? { reason: mark.reason } : {}) } };
        const trace = traceOf(entry, group.view, group.source.summary.sessionId);
        if (trace) result = { ...result, trace };
      }
      formatted.set(entry, result);
    }
    return result;
  };
  const { groups, older, newer } = await readHistory(ctx, {
    ...options,
    sources,
    limit,
    ...(outputMode === "messages"
      ? {
        hidden: (entry) => !isMessage(entry),
        budget: { size: (entry, group) => JSON.stringify(format(entry, group), null, 1).length, max: PAGE_MAX_CHARS },
      }
      : {}),
  });
  return {
    sessions: groups.map((group) => {
      const { sessionId, name, created, modified, current, project } = group.source.summary;
      return { sessionId, name, created, modified, current, project, entries: group.entries.map((entry) => format(entry, group)) };
    }),
    older,
    newer,
  };
}

const EntrySummary = Type.Object({
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String({ description: "ISO 8601 time the entry was saved" }),
  type: Type.String({ description: "message, compaction, branch_summary or custom_message" }),
  role: Type.Optional(Type.String({ description: "Role of a message entry" })),
  label: Type.Optional(Type.String({ description: "The user's bookmark on this entry" })),
  contextEdit: Type.Optional(Type.String({ description: "removed or replaced: the model saw this entry edited" })),
  text: Type.Optional(Type.String({ description: "Message text, whole up to 3,000 chars, otherwise its start and end" })),
  summary: Type.Optional(Type.String({ description: "Summary with every heading, sections shortened if long" })),
  mark: Type.Optional(Type.Object({
    by: Type.String({ description: "user or agent" }),
    at: Type.String(),
    reviewed: Type.Boolean({ description: "False until the user has seen an agent's mark" }),
    reason: Type.Optional(Type.String()),
  }, { description: "Marked critical with recall_mark or in /recall" })),
  trace: Type.Optional(Type.Object({
    entries: Type.Integer({ description: "Entries after the message that the trace covers" }),
    calls: Type.Integer(),
    tools: Type.Record(Type.String(), Type.Integer(), { description: "Calls per tool" }),
    changed: Type.Optional(Type.Array(Type.String(), { description: "Files edited or written" })),
    moreChanged: Type.Optional(Type.Integer()),
    errors: Type.Optional(Type.Array(Type.Object({
      tool: Type.String(),
      call: Type.Optional(Type.String({ description: "The call's main argument, such as its command or path" })),
      error: Type.String({ description: "Start and end of the error output" }),
      result: Type.String({ description: "Pass as from with limit 1 and outputMode full to read the whole output" }),
    }))),
    moreErrors: Type.Optional(Type.Integer()),
  }, { description: "The tool calls this message made and those after it, up to the next message" })),
}, { additionalProperties: true, description: "outputMode full returns the entry's own fields instead of text, summary and trace" });

export const recallTool = defineTool({
  name: "recall_messages",
  label: "Recall Messages",
  description:
    "Recall earlier conversation in this project when you need a refresher beyond what is in your context: what was asked, done or decided, " +
    "in previous sessions or before compaction. Returns messages and summaries, grouped by session, oldest first within a page, " +
    "text whole up to 3,000 chars and without thinking. The tool calls after a message are its trace: calls per tool, files changed and errors. " +
    "Without arguments, returns the newest messages not already in your context; in a new session, that is the end of the previous one. " +
    "Pass older as before to go back in time, or newer as from to read forward. sessionId (from recall_sessions) reads one session. " +
    "project reads another project's history instead; a sessionId or cursor from any project reads that project. " +
    'Pages stop near 16,000 chars. outputMode "full" returns complete entries, tool calls and outputs included, and limit then counts entries: ' +
    "pass a message's id as from with limit trace.entries + 1 to read its tool calls, or an error's result with limit 1 to read that output. " +
    TRUNCATION_NOTE,
  promptSnippet: "Recall earlier conversation in this project, from previous sessions or removed from context by compaction",
  parameters: Type.Object({
    sessionId: Type.Optional(Type.String({ minLength: 1, description: "Read only this session; omit for the whole project" })),
    before: Type.Optional(Type.String({ minLength: 1, description: "Return entries before this cursor, such as older from the previous page" })),
    from: Type.Optional(Type.String({ minLength: 1, description: "Return entries starting at this cursor or entry id, such as newer from the previous page" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_LIMIT, default: MAX_LIMIT, description: "Messages per page; entries with outputMode full" }),
    ),
    outputMode: Type.Optional(StringEnum(OUTPUT_MODES, { default: "messages" })),
    includeContext: Type.Optional(Type.Boolean({ default: false, description: "Include entries still in your context" })),
    project: Type.Optional(Type.String({ minLength: 1, description: PROJECT_DESCRIPTION })),
  }),
  outputSchema: Type.Object({
    sessions: Type.Array(Type.Object({
      sessionId: Type.String(),
      name: Type.Optional(Type.String()),
      created: Type.String(),
      modified: Type.String({ description: "Time of the session's last message" }),
      current: Type.Optional(Type.Boolean()),
      project: Type.Optional(Type.String({ description: "The project's folder, for sessions of another project" })),
      entries: Type.Array(EntrySummary),
    }), { description: "Sessions on this page, oldest first" }),
    older: Type.Union([Type.String(), Type.Null()], { description: "Pass as before for earlier entries; null at the start of history" }),
    newer: Type.Union([Type.String(), Type.Null()], { description: "Pass as from for later entries; null at the end of history" }),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
    const outputMode = params.outputMode ?? "messages";
    const result = await recall(ctx, { ...params, outputMode, signal });
    return jsonResult(result, {
      outputMode,
      sessions: result.sessions.map((session) => ({
        sessionId: session.sessionId,
        ids: session.entries.map((entry) => entry.id),
      })),
      older: result.older,
      newer: result.newer,
    });
  },
});
