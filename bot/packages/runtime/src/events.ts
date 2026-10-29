import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { BotContent, BotEvent, BotMessage, BotMessageChange, BotSnapshot, BotToolActivity, BotTranscriptEntry } from "./types.js";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Project deliberately: never spread provider messages, private system context or runtime documents onto the wire. */
export function publicContent(value: unknown): BotContent[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): BotContent[] => {
    const part = object(raw);
    switch (part.type) {
      case "text": return [{ type: "text", text: String(part.text ?? "") }];
      case "thinking": return [{ type: "thinking", thinking: part.redacted ? "" : String(part.thinking ?? ""), ...(part.redacted ? { redacted: true } : {}) }];
      case "image": return [{ type: "image", mimeType: String(part.mimeType ?? "application/octet-stream") }];
      case "toolCall": return [{ type: "toolCall", id: String(part.id), name: String(part.name), arguments: copy(object(part.arguments)) }];
      default: return [];
    }
  });
}
export function publicMessage(value: unknown): BotMessage | undefined {
  const message = object(value);
  if (!["user", "assistant", "toolResult"].includes(message.role)) return undefined;
  return { role: message.role, content: publicContent(message.content),
    ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
    ...(message.role === "toolResult" ? { toolCallId: String(message.toolCallId ?? ""), toolName: String(message.toolName ?? ""), isError: message.isError === true } : {}),
  };
}
export function publicEntry(id: number, messages: readonly unknown[]): BotTranscriptEntry {
  return { id, kind: "message", model: messages.flatMap(message => { const projected = publicMessage(message); return projected ? [projected] : []; }) };
}
export function durableEntry(value: unknown): BotTranscriptEntry {
  const entry = object(value);
  return publicEntry(Number(entry.id), Array.isArray(entry.model) ? entry.model : []);
}
/** Positions in the append-only session file are immutable IDs, including gaps for private/non-message entries. */
export function nativeTranscript(entries: readonly FileEntry[]): BotTranscriptEntry[] {
  return entries.map((entry, index) => publicEntry(index + 1, entry.type === "message" ? [entry.message] : []));
}

function changes(value: unknown): BotMessageChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): BotMessageChange[] => {
    const change = object(raw);
    if (change.type === "message") { const message = publicMessage(change.message); return message ? [{ type: "message", message }] : []; }
    if (!Number.isSafeInteger(change.contentIndex) || change.contentIndex < 0) return [];
    if (["text_delta", "thinking_delta"].includes(change.type)) return [{ type: change.type, contentIndex: change.contentIndex, delta: String(change.delta ?? "") }];
    if (["block", "text_start", "thinking_start", "toolcall_start"].includes(change.type)) {
      const block = publicContent([change.block])[0];
      return block ? [{ type: change.type, contentIndex: change.contentIndex, block }] : [];
    }
    return [];
  });
}
function summary(value: unknown): string {
  const result = object(value);
  const content = result.content ?? result.output;
  const text = typeof content === "string" ? content : publicContent(content).filter(part => part.type === "text").map(part => part.text).join("\n");
  return (text || (typeof result.structuredOutput === "string" ? result.structuredOutput : "")).slice(-2000);
}
function toolData(event: Record<string, any>): Omit<BotToolActivity, "status"> {
  return { toolCallId: String(event.toolCallId ?? ""), toolName: String(event.toolName ?? "tool"),
    ...(event.args ? { args: copy(object(event.args)) } : {}),
    ...(event.parentToolCallId ? { parentToolCallId: String(event.parentToolCallId) } : {}),
  };
}

/** Adapter for the current native executor, not a compatibility reader. */
export function nativeEvent(value: unknown, entries: readonly FileEntry[]): BotEvent | undefined {
  const event = object(value);
  if (event.type === "message_start") {
    const message = publicMessage(event.message); return message ? { type: "message_start", data: { message } } : undefined;
  }
  if (event.type === "message_update") {
    const message = publicMessage(event.message ?? event.assistantMessageEvent?.partial);
    return message ? { type: "message_update", data: { changes: [{ type: "message", message }] } } : undefined;
  }
  if (event.type === "message_end") {
    const message = publicMessage(event.message); if (!message) return undefined;
    // Pi notifies subscribers immediately BEFORE synchronously appending this regular message.
    // The next append-only file position is therefore its stable history ID (not its timestamp).
    return { type: "message_end", data: { entry: publicEntry(entries.length + 1, [event.message]) } };
  }
  if (event.type === "tool_execution_end") {
    return { type: "tool_execution_end", data: { ...toolData(event), isError: event.isError === true || event.result?.isError === true, summary: summary(event.result) } };
  }
  if (event.type === "tool_execution_update") return { type: "tool_execution_update", data: { ...toolData(event), summary: summary(event.partialResult) } };
  if (event.type === "agent_start") return { type: "run_start", data: {} };
  if (event.type === "agent_end") return { type: "run_end", data: {} };
  if (event.type === "compaction_end") return { type: "compaction_end", data: { ...(event.errorMessage ? { error: String(event.errorMessage) } : {}) } };
  if (event.type === "auto_retry_end") return { type: "auto_retry_end", data: { success: event.success === true, ...(event.finalError ? { errorMessage: String(event.finalError) } : {}) } };
  return commonEvent(event);
}
function commonEvent(event: Record<string, any>): BotEvent | undefined {
  switch (event.type) {
    case "tool_execution_start": return { type: "tool_execution_start", data: toolData(event) };
    case "run_start": case "run_end": case "turn_start": case "turn_end": case "compaction_start": return { type: event.type, data: {} };
    case "auto_retry_start": return { type: "auto_retry_start", data: { attempt: Number(event.attempt ?? 1), errorMessage: String(event.errorMessage ?? "Provider error") } };
    case "auto_retry_end": return { type: "auto_retry_end", data: { success: event.success !== false, ...(event.errorMessage ? { errorMessage: String(event.errorMessage) } : {}) } };
    case "compaction_end": return { type: "compaction_end", data: { ...(event.error ? { error: String(event.error) } : {}) } };
    case "task_failed": return { type: "task_failed", data: { message: String(event.message ?? "Task failed") } };
    default: return undefined;
  }
}
/** Adapter for the active isolated/durable executor. Internal scheduler events are not public bot events. */
export function durableEvent(value: unknown): BotEvent | undefined {
  const event = object(value);
  switch (event.type) {
    case "snapshot": {
      const message = publicMessage(event.generation?.message);
      const entries = (event.entries ?? []).map(durableEntry) as BotTranscriptEntry[];
      const calls = entries.flatMap(entry => entry.model).flatMap(message => message.content).filter(part => part.type === "toolCall");
      const tools: BotToolActivity[] = [...(event.tools ?? []), ...(event.nestedTools ?? [])].filter(slot => slot.status !== "pending").map(slot => {
        const tool = object(slot), call = calls.findLast(call => call.id === tool.callId);
        const result = entries.find(entry => entry.id === tool.entry)?.model.find(message => message.role === "toolResult");
        const status = tool.status !== "done" ? "running" : (result?.isError ?? tool.summary?.isError ?? !tool.entry) ? "failed" : "completed";
        return { ...toolData({ toolCallId: tool.callId, toolName: tool.name, args: tool.arguments ?? call?.arguments, parentToolCallId: tool.parentCallId }),
          status, summary: (tool.output ?? tool.summary?.error ?? summary(result)).slice(-2000) };
      });
      const notice = event.generation?.retry ? `Retrying: ${event.generation.retry.error}` : event.compactions?.length ? "Compacting context" : undefined;
      return { type: "snapshot", data: { entries: boundedEntries(entries), tools, ...(message ? { generation: { message } } : {}), ...(notice ? { notice } : {}) } };
    }
    case "message_start": { const message = publicMessage(event.message); return message ? { type: "message_start", data: { message } } : undefined; }
    case "message_update": return { type: "message_update", data: { changes: changes(event.changes) } };
    case "message_end": { const entry = durableEntry(event.entry); return entry.model.length ? { type: "message_end", data: { entry } } : undefined; }
    case "tool_execution_end": {
      const entry = event.entry ? durableEntry(event.entry) : undefined;
      const result = entry?.model.find(message => message.role === "toolResult");
      return { type: "tool_execution_end", data: { ...toolData(event), isError: result?.isError ?? event.result?.isError ?? (!event.entry && !event.result),
        summary: summary(result ?? event.result), ...(entry ? { entry } : {}) } };
    }
    case "tool_execution_update": return { type: "tool_execution_update", data: { ...toolData(event), summary: String(event.output?.set ?? event.output?.append ?? "").slice(-2000) } };
    default: return commonEvent(event);
  }
}
/** Bounded display window. Full original messages remain available through paginated history. */
export function boundedEntries(entries: BotTranscriptEntry[]): BotTranscriptEntry[] {
  const result: BotTranscriptEntry[] = []; let size = 0;
  for (const entry of entries.filter(entry => entry.model.length).slice(-50).reverse()) {
    const length = JSON.stringify(entry).length;
    if (length + size > 100_000) break;
    result.unshift(entry); size += length;
  }
  return result;
}
/** Kept even with no observers, so reconnects see real in-flight text and tool activity. */
export function createLiveState() {
  let generation: BotMessage | undefined;
  let notice: string | undefined;
  const tools = new Map<string, BotToolActivity>();
  return {
    apply(event: BotEvent) {
      switch (event.type) {
        case "run_start": generation = undefined; tools.clear(); notice = undefined; break;
        case "message_start": if (event.data.message.role === "assistant") generation = copy(event.data.message); break;
        case "message_update": for (const change of event.data.changes) if (change.type === "message") generation = copy(change.message); break;
        case "message_end": if (event.data.entry.model.some(message => message.role === "assistant")) generation = undefined; break;
        case "tool_execution_start": tools.set(event.data.toolCallId, { ...copy(event.data), status: "running" }); break;
        case "tool_execution_update": {
          const tool = tools.get(event.data.toolCallId); if (tool) Object.assign(tool, copy(event.data)); break;
        }
        case "tool_execution_end": tools.set(event.data.toolCallId, { ...toolData(event.data), summary: event.data.summary, status: event.data.isError ? "failed" : "completed" }); break;
        case "auto_retry_start": notice = `Retrying (attempt ${event.data.attempt}): ${event.data.errorMessage}`; break;
        case "auto_retry_end": notice = event.data.success ? undefined : event.data.errorMessage; break;
        case "compaction_start": notice = "Compacting context"; break;
        case "compaction_end": notice = event.data.error ? `Compaction failed: ${event.data.error}` : undefined; break;
        case "error": case "task_failed": notice = event.data.message; break;
        case "run_end": generation = undefined; break;
        case "run_settled":
          generation = undefined;
          if (event.data.error) notice = event.data.error;
          for (const tool of tools.values()) if (tool.status === "running") { tool.status = "failed"; tool.summary = event.data.status === "cancelled" ? "Cancelled" : "Run ended without a tool result"; }
          break;
      }
      // Bound completed activity, retaining active calls.
      if (tools.size > 50) for (const [id, tool] of tools) if (tools.size > 50 && tool.status !== "running") tools.delete(id);
    },
    snapshot(entries: BotTranscriptEntry[]): BotSnapshot {
      return copy({ entries: boundedEntries(entries), tools: [...tools.values()], ...(generation ? { generation: { message: generation } } : {}), ...(notice ? { notice } : {}) });
    },
  };
}
