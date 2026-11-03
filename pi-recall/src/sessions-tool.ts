import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clip } from "./format.ts";
import { jsonResult, TRUNCATION_NOTE } from "./result.ts";
import { resolveScope, type ScopeContext } from "./projects.ts";
import { PROJECT_DESCRIPTION } from "./recall.ts";
import { listSessions } from "./sessions.ts";

export const MAX_SESSIONS = 50;
const DEFAULT_SESSIONS = 20;

/** The project's sessions, most recently active first, the current one first of all. */
export async function recallSessions(
  ctx: ScopeContext,
  options: { limit?: number; cursor?: string; project?: string; signal?: AbortSignal } = {},
) {
  const { limit = DEFAULT_SESSIONS, cursor, project, signal } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSIONS) {
    throw new Error(`limit must be an integer between 1 and ${MAX_SESSIONS}`);
  }
  // The cursor is opaque to callers so that ranked results can page differently later.
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(start) || start < 0) throw new Error(`Invalid cursor ${cursor}`);

  const scope = await resolveScope(ctx, project);
  const sources = await listSessions(ctx.sessionManager, scope.projects, signal);
  const end = start + limit;
  return {
    sessions: sources.slice(start, end).map(({ summary }) => ({ ...summary, firstMessage: clip(summary.firstMessage) })),
    next: end < sources.length ? String(end) : null,
  };
}

export const sessionsTool = defineTool({
  name: "recall_sessions",
  label: "Recall Sessions",
  description:
    "List this project's sessions, most recently active first, with name, dates, message count and the first user message. " +
    "Use it to find an earlier conversation on a topic, then read it with recall_messages and its sessionId. " +
    "For the latest history, call recall_messages directly; to find where something was mentioned, use recall_search. " +
    "project lists another project's sessions instead, or every project's. Pass next as cursor, with the same project, for more sessions. " +
    TRUNCATION_NOTE,
  promptSnippet: "Find earlier sessions in this project to read with recall_messages",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_SESSIONS, default: DEFAULT_SESSIONS, description: "Sessions per page" }),
    ),
    cursor: Type.Optional(Type.String({ minLength: 1, description: "next from the previous page" })),
    project: Type.Optional(Type.String({ minLength: 1, description: PROJECT_DESCRIPTION })),
  }),
  outputSchema: Type.Object({
    sessions: Type.Array(Type.Object({
      sessionId: Type.String(),
      name: Type.Optional(Type.String()),
      created: Type.String(),
      modified: Type.String({ description: "Time of the session's last message" }),
      messageCount: Type.Integer(),
      firstMessage: Type.String({ description: "The first user message, clipped" }),
      parentSessionId: Type.Optional(Type.String({ description: "The session this one was forked from" })),
      current: Type.Optional(Type.Boolean({ description: "True for this session" })),
      project: Type.Optional(Type.String({ description: "The project's folder, for sessions of another project" })),
    })),
    next: Type.Union([Type.String(), Type.Null()], { description: "Cursor for the next page" }),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
    const result = await recallSessions(ctx, { ...params, signal });
    return jsonResult(result, { ids: result.sessions.map((s) => s.sessionId), next: result.next });
  },
});
