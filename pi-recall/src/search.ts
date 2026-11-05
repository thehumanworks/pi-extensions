import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type RecalledEntry, type SessionView, sessionView } from "./entries.ts";
import { createMatcher, MATCH_MODES, type Matcher, type MatchMode, QUERY_MAX, snippets } from "./match.ts";
import { jsonResult, TRUNCATION_NOTE } from "./result.ts";
import { resolveScope, type ScopeContext } from "./projects.ts";
import { PROJECT_DESCRIPTION } from "./recall.ts";
import { listSessions, type SessionSource, sourcesWith } from "./sessions.ts";

/** What a search looks at: conversation text, tool calls, and tool output. */
export const SCOPES = ["text", "tools", "outputs"] as const;
export type Scope = (typeof SCOPES)[number];
const DEFAULT_SCOPES: Scope[] = ["text", "tools"];

export const SEARCH_MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
/** Snippets per hit, across all of its matching parts. */
const SNIPPETS = 3;

/** The part of an entry that matched. */
export type Where = "text" | "summary" | "label" | "args" | "output";

interface Field {
  where: Where;
  tool?: string;
  text: string;
}

export interface SearchHit {
  /** Pass to recall_messages as from or before. */
  ref: string;
  sessionId: string;
  /** The project's folder, for sessions of another project. */
  project?: string;
  timestamp: string;
  type: RecalledEntry["type"];
  role?: string;
  /** Matches in the entry, including those without a snippet. */
  matches: number;
  snippets: { where: Where; tool?: string; text: string }[];
}

export interface SearchOptions {
  query: string;
  match?: MatchMode;
  in?: Scope[];
  sessionId?: string;
  /** A project to search instead: a path, the last folders of one, or "all". */
  project?: string;
  includeContext?: boolean;
  limit?: number;
  /** next from the previous page. */
  cursor?: string;
  signal?: AbortSignal;
}

/** Text blocks only: image placeholders are not worth matching. */
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

/** The values in tool arguments, one per line, so commands and paths match as written rather than as JSON. */
function argText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  return Object.values(value).map(argText).filter(Boolean).join("\n");
}

/** The parts of an entry a search in these scopes looks at, in the order they appear. */
function fields(entry: RecalledEntry, view: Pick<SessionView, "notes">, scopes: Set<Scope>): Field[] {
  const out: Field[] = [];
  const add = (scope: Scope, field: Field) => {
    if (scopes.has(scope) && field.text) out.push(field);
  };
  const label = view.notes(entry.id).label;
  if (label) add("text", { where: "label", text: label });

  switch (entry.type) {
    case "compaction":
    case "branch_summary":
      add("text", { where: "summary", text: entry.summary });
      return out;
    case "custom_message":
      add("text", { where: "text", text: plainText(entry.content) });
      return out;
  }
  const { message } = entry;
  switch (message.role) {
    case "assistant":
      // Thinking is left out, as in recall_messages and /recall.
      add("text", { where: "text", text: plainText(message.content) });
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        add("tools", { where: "args", tool: block.name, text: `${block.name}\n${argText(block.arguments)}` });
      }
      break;
    case "toolResult":
      add("outputs", { where: "output", tool: message.toolName, text: plainText(message.content) });
      break;
    case "bashExecution":
      // A command the user ran with !.
      add("tools", { where: "args", tool: "bash", text: message.command });
      add("outputs", { where: "output", tool: "bash", text: message.output });
      break;
    case "branchSummary":
    case "compactionSummary":
      add("text", { where: "summary", text: message.summary });
      break;
    default:
      add("text", { where: "text", text: plainText((message as { content?: unknown }).content) });
  }
  return out;
}

function hitFor(entry: RecalledEntry, parts: Field[], matcher: Matcher, source: SessionSource): SearchHit | undefined {
  const { sessionId, project } = source.summary;
  let matches = 0;
  const found: SearchHit["snippets"] = [];
  for (const { where, tool, text } of parts) {
    const ranges = matcher.ranges(text);
    matches += ranges.length;
    if (ranges.length === 0 || found.length === SNIPPETS) continue;
    for (const snippet of snippets(text, ranges, SNIPPETS - found.length)) {
      found.push({ where, ...(tool ? { tool } : {}), text: snippet });
    }
  }
  if (matches === 0) return undefined;
  return {
    ref: `${sessionId}/${entry.id}`,
    sessionId,
    ...(project ? { project } : {}),
    timestamp: entry.timestamp,
    type: entry.type,
    ...(entry.type === "message" ? { role: entry.message.role } : {}),
    matches,
    snippets: found,
  };
}

/**
 * Entries in the project's history that match the query, newest first: sessions by last activity, then
 * entries from the end of each branch.
 */
export async function search(ctx: ScopeContext, options: SearchOptions) {
  const { query, match = "literal", sessionId, includeContext = false, limit = DEFAULT_LIMIT, cursor, signal } = options;
  const scopes = new Set(options.in ?? DEFAULT_SCOPES);
  if (scopes.size === 0 || [...scopes].some((scope) => !SCOPES.includes(scope))) {
    throw new Error(`in must list one or more of ${SCOPES.join(", ")}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${SEARCH_MAX_LIMIT}`);
  }
  const matcher = createMatcher(query, match);

  const scope = await resolveScope(ctx, options.project);
  let sources = await listSessions(ctx.sessionManager, scope.projects, signal);
  if (sessionId !== undefined) {
    sources = (await sourcesWith(ctx.sessionManager, scope, sources, sessionId, signal))
      .filter((source) => source.summary.sessionId === sessionId);
  }

  // The cursor is the last hit returned; the search goes on from the entry before it.
  const invalid = () => new Error(`Invalid cursor ${cursor}: pass next from the previous page, with the same arguments`);
  let first = 0;
  let resume: string | undefined;
  if (cursor !== undefined) {
    const slash = cursor.indexOf("/");
    first = sources.findIndex((source) => source.summary.sessionId === cursor.slice(0, slash));
    if (slash === -1 || first === -1) throw invalid();
    resume = cursor.slice(slash + 1);
  }

  const hits: SearchHit[] = [];
  let more = false;
  sessions: for (let s = first; s < sources.length; s++) {
    signal?.throwIfAborted();
    const source = sources[s]!;
    const view = sessionView(await source.load(), source.current && !includeContext);
    const { entries } = view;
    let i = entries.length - 1;
    if (s === first && resume !== undefined) {
      i = entries.findIndex((entry) => entry.id === resume) - 1;
      if (i === -2) throw invalid();
    }
    for (; i >= 0; i--) {
      signal?.throwIfAborted();
      const entry = entries[i]!;
      const hit = hitFor(entry, fields(entry, view, scopes), matcher, source);
      if (!hit) continue;
      if (hits.length === limit) {
        more = true;
        break sessions;
      }
      hits.push(hit);
    }
  }

  return {
    match,
    // Pattern matches come newest first; semantic search will rank by relevance.
    order: "recent" as const,
    caseSensitive: matcher.caseSensitive,
    hits,
    next: more ? hits.at(-1)!.ref : null,
  };
}

export const searchTool = defineTool({
  name: "recall_search",
  label: "Recall Search",
  description:
    "Search earlier conversation in this project for something you can name: a file, error, function, command or decision. " +
    "Returns hits newest first, each with snippets and a ref. Pass ref to recall_messages as from to read on from the message it belongs to, " +
    'or as before to see what led up to it; with limit 1 and outputMode "full" it reads the matching entry itself. ' +
    "Matches the query as written, ignoring case unless it has a capital letter; " +
    'match "regex" takes a JavaScript regular expression. Searches messages, summaries and tool calls; ' +
    'add "outputs" to in to search tool output too, such as error messages. Skips entries in your context unless includeContext is true. ' +
    "project searches another project instead, or all of them. Pass next as cursor, with the same other arguments, for more hits. " +
    TRUNCATION_NOTE,
  promptSnippet: "Search earlier conversation in this project for a file, error, command or decision",
  parameters: Type.Object({
    query: Type.String({
      minLength: 1,
      maxLength: QUERY_MAX,
      description: 'What to find, such as "fence balancing", "ENOENT" or "src/recall.ts"',
    }),
    match: Type.Optional(StringEnum(MATCH_MODES, {
      default: "literal",
      description: "literal: the query as written, any whitespace matching any whitespace. regex: JavaScript syntax, ^ and $ at line breaks",
    })),
    in: Type.Optional(Type.Array(StringEnum(SCOPES), {
      minItems: 1,
      default: DEFAULT_SCOPES,
      description: "text: messages, summaries and labels. tools: tool names and arguments. outputs: tool output",
    })),
    sessionId: Type.Optional(Type.String({ minLength: 1, description: "Search only this session; omit for the whole project" })),
    project: Type.Optional(Type.String({ minLength: 1, description: PROJECT_DESCRIPTION })),
    includeContext: Type.Optional(Type.Boolean({ default: false, description: "Include entries still in your context" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: SEARCH_MAX_LIMIT, default: DEFAULT_LIMIT, description: "Hits per page" }),
    ),
    cursor: Type.Optional(Type.String({ minLength: 1, description: "next from the previous page" })),
  }),
  outputSchema: Type.Object({
    match: Type.String(),
    order: Type.String({ description: "recent: newest first" }),
    caseSensitive: Type.Boolean(),
    hits: Type.Array(Type.Object({
      ref: Type.String({ description: "Pass to recall_messages as from or before" }),
      sessionId: Type.String(),
      project: Type.Optional(Type.String({ description: "The project's folder, for sessions of another project" })),
      timestamp: Type.String(),
      type: Type.String(),
      role: Type.Optional(Type.String()),
      matches: Type.Integer({ description: "Matches in the entry, including those without a snippet" }),
      snippets: Type.Array(Type.Object({
        where: Type.String({ description: "text, summary, label, args or output" }),
        tool: Type.Optional(Type.String({ description: "The tool whose arguments or output matched" })),
        text: Type.String(),
      })),
    })),
    next: Type.Union([Type.String(), Type.Null()], { description: "Pass as cursor for more hits; null when there are no more" }),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
    const result = await search(ctx, { ...params, signal });
    return jsonResult(result, { match: result.match, hits: result.hits.map((hit) => hit.ref), next: result.next });
  },
});
