import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { EntryNotes } from "../entries.ts";
import { contentText } from "../format.ts";
import type { ReadonlySession } from "../sessions.ts";

export const SUMMARY_TOOL = "recall_summary";
/** Makes nested calls visible before their parent tool result has reached the transcript. */
export const SUMMARY_CALL = "pi-recall/summary-call";

interface CallKind { summary: boolean; other: boolean }

/**
 * Structural, not linguistic: a user turn containing only summary tools and narration is bookkeeping.
 * Mixed turns keep the user request and real work, but not summary calls/results or their narration.
 * After a summary call, assistant text is ignored until a user prompt or a non-summary tool call.
 */
export function conversationSource(sm: ReadonlySession) {
  const branch = structuredClone(sm.getBranch());
  const calls = new Map<string, CallKind>();
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const block of entry.message.content) {
        if (block.type === "toolCall") calls.set(block.id, { summary: block.name === SUMMARY_TOOL, other: block.name !== SUMMARY_TOOL });
      }
    }
  }
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === SUMMARY_CALL) {
      const data = entry.data as { rootCallId?: unknown; otherWork?: unknown } | undefined;
      if (typeof data?.rootCallId === "string") {
        const previous = calls.get(data.rootCallId);
        calls.set(data.rootCallId, { summary: true, other: previous?.summary ? previous.other || data.otherWork === true : data.otherWork === true });
      }
    }
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const message = entry.message;
      const nested = message.nestedCalls?.calls;
      if (nested?.some((call) => call.name === SUMMARY_TOOL)) {
        calls.set(message.toolCallId, { summary: true, other: nested.some((call) => call.name !== SUMMARY_TOOL) });
      }
    }
  }

  const groups: SessionEntry[][] = [];
  for (const entry of branch) {
    if (groups.length === 0 || (entry.type === "message" && entry.message.role === "user")) groups.push([]);
    groups.at(-1)!.push(entry);
  }
  const entries: SessionMessageEntry[] = [];
  const messageIds: string[] = [];
  for (const group of groups) {
    const kinds = group.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
      ? entry.message.content.flatMap((block) => block.type === "toolCall" ? [calls.get(block.id)!] : []) : []);
    const command = group.some((entry) => entry.type === "message" && entry.message.role === "user" &&
      /^\/recall\s+summary(?:\s|$)/.test(contentText(entry.message.content).trim()));
    if (command || (kinds.some((kind) => kind.summary) && !kinds.some((kind) => kind.other))) continue;
    let afterSummary = false;
    for (const entry of group) {
      if (entry.type !== "message") continue;
      const { message } = entry;
      if (message.role === "user") {
        if (!contentText(message.content).trim()) continue;
        entries.push(entry);
        messageIds.push(entry.id);
      } else if (message.role === "assistant") {
        const toolCalls = message.content.flatMap((block) => block.type === "toolCall" ? [calls.get(block.id)!] : []);
        if (toolCalls.some((kind) => kind.other)) afterSummary = false;
        if (toolCalls.some((kind) => kind.summary)) {
          afterSummary = true;
          // A mixed parallel batch can still contribute its other tool calls as evidence.
          const content = message.content.filter((block) => block.type === "toolCall" && !calls.get(block.id)?.summary);
          if (content.length > 0) entries.push({ ...entry, message: { ...message, content } });
          continue;
        }
        if (afterSummary) continue;
        entries.push(entry);
        if (contentText(message.content).trim()) messageIds.push(entry.id);
      } else if (message.role === "toolResult") {
        // A wrapper's result can contain the summary itself, even in a mixed batch.
        if (message.toolName !== SUMMARY_TOOL && !calls.get(message.toolCallId)?.summary) entries.push(entry);
      } else if (message.role === "bashExecution") {
        entries.push(entry);
      }
    }
  }
  const notes = new Map<string, EntryNotes>();
  for (const entry of entries) {
    const label = sm.getLabel(entry.id);
    notes.set(entry.id, label ? { label } : {});
  }
  for (const entry of branch) {
    if (entry.type === "context_edit" && notes.has(entry.targetId)) {
      notes.get(entry.targetId)!.contextEdit = entry.replacement === null ? "removed" : "replaced";
    }
  }
  return { entries, messageIds, notes };
}
