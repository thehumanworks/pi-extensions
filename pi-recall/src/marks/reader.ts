import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { excerpt } from "../clip.ts";
import { inContextIds, MARKS_MESSAGE_TYPE, type RecalledEntry, sessionView } from "../entries.ts";
import { contentText } from "../format.ts";
import { entryText } from "../command/attach.ts";
import { resolveScope, type ScopeContext } from "../projects.ts";
import { listSessions, type ReadonlySession } from "../sessions.ts";
import { loadMarks } from "./store.ts";

export { MARKS_MESSAGE_TYPE };
/** Marks brought back at once, newest first. */
export const READ_LIMIT = 5;
const TEXT_CHARS = 600;

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** What a message says, without the tool calls an assistant message makes. */
function messageText(entry: RecalledEntry): string {
  if (entry.type === "message" && entry.message.role === "assistant") {
    return entry.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  }
  return entryText(entry);
}

/**
 * The newest critical marks in this project and the projects its recallConfig setting lists, as a block for the model,
 * or undefined if there are none. Messages still in the current context are left out, including copies of
 * them in a session forked from where they were marked.
 */
export async function marksSection(ctx: ScopeContext, limit = READ_LIMIT): Promise<string | undefined> {
  const sm = ctx.sessionManager;
  const scope = await resolveScope(ctx);
  const marked = [...(await loadMarks(scope.index, scope.projects)).values()]
    .filter((state) => state.marked)
    .sort((a, b) => b.at.localeCompare(a.at));
  if (marked.length === 0) return undefined;

  const sources = await listSessions(sm, scope.projects);
  const parents = new Map(sources.map(({ summary }) => [summary.sessionId, summary.parentSessionId]));
  const lineage = new Set<string>();
  for (let sid: string | undefined = sm.getSessionId(); sid !== undefined && !lineage.has(sid); sid = parents.get(sid)) lineage.add(sid);
  const inContext = inContextIds(sm);

  const blocks: string[] = [];
  for (const state of marked) {
    if (blocks.length === limit) break;
    if (lineage.has(state.sessionId) && inContext.has(state.entryId)) continue;
    const source = sources.find((s) => s.summary.sessionId === state.sessionId);
    if (!source) continue;
    const entry = sessionView(await source.load(), false).entries.find((e) => e.id === state.entryId);
    if (!entry) continue;
    const attrs = [
      `ref="${attr(state.ref)}"`,
      ...(source.summary.project ? [`project="${attr(source.summary.project)}"`] : []),
      entry.type === "message" ? `role="${attr(entry.message.role)}"` : `type="${attr(entry.type)}"`,
      `timestamp="${attr(entry.timestamp)}"`,
      `marked_by="${state.by}"`,
      `reviewed="${state.reviewed}"`,
    ];
    const reason = state.reason ? `Reason: ${state.reason}\n` : "";
    blocks.push(`<mark ${attrs.join(" ")}>\n${reason}${excerpt(messageText(entry), TEXT_CHARS)}\n</mark>`);
  }
  if (blocks.length === 0) return undefined;
  return [
    "<critical_marks>",
    "Messages marked critical in this project, newest first; one with a project attribute is from a project this one recalls with its own. " +
      "Each still holds unless later conversation reverses it; " +
      "unmark it with recall_mark when it no longer holds. recall_messages with a ref as from reads around it.",
    ...blocks,
    "</critical_marks>",
  ].join("\n");
}

/** Whether the latest marks block in the current context says exactly this. */
function alreadyInContext(sm: ReadonlySession, text: string): boolean {
  const inContext = inContextIds(sm);
  const last = sm.getBranch().findLast((e) => e.type === "custom_message" && e.customType === MARKS_MESSAGE_TYPE && inContext.has(e.id));
  return last?.type === "custom_message" && contentText(last.content) === text;
}

/**
 * Brings the newest marks back before the first prompt of a session and the first after a compaction, unless
 * the same block is still in context, as after resuming a session.
 */
export function registerMarksReader(pi: ExtensionAPI) {
  let pending = false;
  pi.on("session_start", () => {
    pending = true;
  });
  pi.on("session_compact", () => {
    pending = true;
  });
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    if (!pending) return;
    pending = false;
    try {
      const text = await marksSection(ctx);
      if (!text || alreadyInContext(ctx.sessionManager, text)) return;
      return { message: { customType: MARKS_MESSAGE_TYPE, content: text, display: true } };
    } catch (error) {
      ctx.ui.notify(`Could not load critical marks: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }
  });
}
