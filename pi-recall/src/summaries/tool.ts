import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { jsonResult, TRUNCATION_NOTE } from "../result.ts";
import { SummaryService } from "./service.ts";
import { SUMMARY_CALL, SUMMARY_TOOL } from "./source.ts";
import { summarySchema } from "./store.ts";

export function createSummaryTool(service: SummaryService) {
  return defineTool({
    name: SUMMARY_TOOL,
    label: "Recall Summary",
    description:
      "Create, list or read saved conversation summaries. create defaults to the running session; scope project summarises all sessions " +
      "in the current project, or sessionId chooses one session there. Generation never follows recallConfig or crosses projects. " +
      "A first summary needs conversation messages; another needs new messages in that scope. Summary-only turns, requests and replies " +
      "do not count. One generation per project at a time, also across Pi processes; duplicate requests fail rather than queue. " +
      "list defaults to summaries requested in this session (not necessarily about it); scope project lists requests across the project, " +
      "project selects a named project, and scope all lists every project. read takes a saved id and makes no model call. " +
      "Create and read return the full summary and source IDs; list returns metadata, 20 per page (max 50). Pass next as cursor with the same filters. " +
      TRUNCATION_NOTE,
    promptSnippet: "Create a guarded conversation summary, or list/read saved summaries across sessions and projects",
    promptGuidelines: ["Use recall_summary list/read to reuse saved summaries. Do not retry recall_summary create after a no-new-messages or in-progress error without new conversation or completion."],
    parameters: Type.Object({
      action: StringEnum(["create", "list", "read"] as const),
      scope: Type.Optional(StringEnum(["session", "project", "all"] as const, { description: "Default session. all is list-only." })),
      sessionId: Type.Optional(Type.String({ minLength: 1, description: "create: source session (id or unique prefix); list: exact requesting session id. Session scope only." })),
      project: Type.Optional(Type.String({ minLength: 1, description: "List-only, project scope: project path or unique trailing folders. Omit for current project." })),
      id: Type.Optional(Type.String({ minLength: 1, description: "read: complete saved summary id" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "list: page size, default 20" })),
      cursor: Type.Optional(Type.String({ minLength: 1, description: "list: next from the preceding page" })),
    }, { additionalProperties: false }),
    outputSchema: Type.Union([
      Type.Object({ summary: summarySchema }),
      Type.Object({
        summaries: Type.Array(Type.Intersect([
          Type.Omit(summarySchema, ["v", "text", "sources"]),
          Type.Object({ sessionCount: Type.Integer(), messageCount: Type.Integer(), entryCount: Type.Integer() }),
        ])),
        next: Type.Union([Type.String(), Type.Null()]),
      }),
    ]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (params.action === "create") {
        if (params.scope === "all" || params.project !== undefined || params.id !== undefined || params.limit !== undefined || params.cursor !== undefined) {
          throw new Error("create accepts only scope session/project and an optional sessionId; generation is current-project only");
        }
        const { summary, usage } = await service.create(ctx, { scope: params.scope, sessionId: params.sessionId, requestedBy: "agent", signal });
        return { ...await jsonResult({ summary }, { action: "create", id: summary.id }), usage };
      }
      if (params.action === "read") {
        if (!params.id || params.scope !== undefined || params.sessionId !== undefined || params.project !== undefined || params.limit !== undefined || params.cursor !== undefined) {
          throw new Error("read requires id and accepts no scope, sessionId, project, limit or cursor");
        }
        const summary = await service.store.get(params.id);
        return jsonResult({ summary }, { action: "read", id: summary.id });
      }
      if (params.action !== "list" || params.id !== undefined) throw new Error("Use create, list, or read; id is read-only");
      const result = await service.list(ctx, params);
      return jsonResult(result, { action: "list", ids: result.summaries.map((summary) => summary.id), next: result.next });
    },
  });
}

/** Persist the root call identity even for nested/codemode summary calls and failed requests. */
export function registerSummaryActivity(pi: ExtensionAPI, service: SummaryService) {
  const roots = new Map<string, string>();
  const otherWork = new Set<string>();
  pi.on("tool_call", (event) => {
    const root = event.parentToolCallId ? roots.get(event.parentToolCallId) ?? event.parentToolCallId : event.toolCallId;
    roots.set(event.toolCallId, root);
    if (event.toolName === SUMMARY_TOOL) {
      pi.appendEntry(SUMMARY_CALL, { rootCallId: root, otherWork: otherWork.has(root) });
    } else if (event.parentToolCallId) {
      otherWork.add(root);
    }
  });
  pi.on("agent_settled", () => { roots.clear(); otherWork.clear(); });
  pi.on("session_shutdown", async () => { roots.clear(); otherWork.clear(); await service.shutdown(); });
}
