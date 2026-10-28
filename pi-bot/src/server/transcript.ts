import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/** A message as the API shows it: text first, provider details second, system messages hidden. */
export interface ApiMessage {
  /** Session entry id when the message came from the session file. */
  id?: string;
  role: "user" | "assistant" | "toolResult";
  /** Milliseconds since the epoch, as Pi records it. */
  timestamp?: number;
  text: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** `provider/model` of the assistant turn. */
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: Usage;
}

export interface ToolCall { id: string; name: string; arguments: unknown }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

type AgentMessage = SessionMessageEntry["message"];
type Part = { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };

/** Tool results can be huge (file dumps); the UI shows a bounded excerpt and Pi keeps the full text. */
export const TOOL_RESULT_LIMIT = 4_000;

function parts(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Part[]) : [];
}

const textOf = (content: unknown) => parts(content).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");

export function truncate(text: string, limit = TOOL_RESULT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more characters]` : text;
}

/** Convert one of Pi's messages; `undefined` for roles the UI must not show (system prompts). */
export function apiMessage(message: AgentMessage, id?: string): ApiMessage | undefined {
  const record = message as unknown as Record<string, unknown>;
  const base = { ...(id ? { id } : {}), ...(typeof record.timestamp === "number" ? { timestamp: record.timestamp } : {}) };
  switch (message.role) {
    case "user":
      return { ...base, role: "user", text: textOf(record.content) };
    case "assistant": {
      const content = parts(record.content);
      const thinking = content.filter(part => part.type === "thinking" && part.thinking).map(part => part.thinking).join("\n");
      const toolCalls = content.filter(part => part.type === "toolCall" && part.id && part.name).map(part => ({ id: part.id!, name: part.name!, arguments: part.arguments }));
      const usage = record.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;
      return {
        ...base, role: "assistant", text: textOf(record.content),
        ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}),
        ...(record.provider && record.model ? { model: `${record.provider}/${record.model}` } : {}),
        ...(typeof record.stopReason === "string" ? { stopReason: record.stopReason } : {}),
        ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
        ...(usage ? { usage: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost?.total ?? 0 } } : {}),
      };
    }
    case "toolResult":
      return {
        ...base, role: "toolResult", text: truncate(textOf(record.content)),
        toolCallId: String(record.toolCallId ?? ""), toolName: String(record.toolName ?? ""), isError: record.isError === true,
      };
    default:
      return undefined;
  }
}

/** The visible transcript of one session branch, oldest first. */
export function messagesFromEntries(entries: SessionEntry[]): ApiMessage[] {
  const messages: ApiMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = apiMessage(entry.message, entry.id);
    if (message) messages.push(message);
  }
  return messages;
}

/** Session ids are file-name fragments; this mirrors Pi's own rule. */
export const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
