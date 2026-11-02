import { type SessionMessageEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { excerpt, sectionExcerpt } from "./clip.ts";
import type { EntryNotes, RecalledEntry } from "./entries.ts";

export const OUTPUT_MODES = ["messages", "full"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

/** Longest message text and summary kept whole in the messages view. */
export const TEXT_MAX = 3000;
const SYSTEM_MAX = 500;
const ERROR_MAX = 300;
const OUTPUT_MAX = 1000;

type Message = SessionMessageEntry["message"];
type Block = { type: string; [key: string]: unknown };

const CLIP_CHARS = 240;

export function clip(text: string, max = CLIP_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The text of string or block content, with images as placeholders. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((block) => {
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "image") return `[image ${String(block.mimeType ?? "")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const LABEL_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "name"];

/** The argument that best identifies a tool call, such as its command or path. */
export function callLabel(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const key = LABEL_KEYS.find((k) => typeof record[k] === "string") ?? Object.keys(record).find((k) => typeof record[k] === "string");
  return key ? clip(String(record[key]), 60) : "";
}

const chars = (n: number) => `${n.toLocaleString("en-US")} chars`;

/** A one-line summary of a message, chosen by role. */
export function summarize(message: Message): string {
  switch (message.role) {
    case "user":
      return clip(contentText(message.content));
    case "assistant": {
      const text = clip(contentText(message.content));
      const calls = message.content.flatMap((block) =>
        block.type === "toolCall" ? [[block.name, callLabel(block.arguments)].filter(Boolean).join(" ")] : []);
      const parts = [text];
      if (calls.length > 0) parts.push(`[tool calls: ${calls.join("; ")}]`);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        parts.push(`[${message.stopReason}${message.errorMessage ? `: ${clip(message.errorMessage, 120)}` : ""}]`);
      }
      return parts.filter(Boolean).join(" ");
    }
    case "toolResult": {
      const text = contentText(message.content);
      const status = `${message.toolName} ${message.isError ? "✗" : "✓"} ${chars(text.length)}`;
      return message.isError ? `${status}: ${clip(text, 120)}` : status;
    }
    case "bashExecution": {
      const status = message.cancelled ? "cancelled" : `exit ${message.exitCode ?? "?"}`;
      return `$ ${clip(message.command, 120)} (${status}): ${clip(message.output)}`;
    }
    case "custom":
      return `${message.customType}: ${clip(contentText(message.content))}`;
    case "branchSummary":
    case "compactionSummary":
      return clip(message.summary);
    case "system": {
      const text = clip(contentText(message.content));
      const added = message.toolsAdded?.map((tool) => tool.name) ?? [];
      return [text, added.length > 0 ? `[tools added: ${added.join(", ")}]` : ""].filter(Boolean).join(" ");
    }
    default:
      // Hosts can add roles through declaration merging.
      return clip(contentText((message as { content?: unknown }).content));
  }
}

/** The value as JSON, with base64 image data replaced by its size. */
export function sanitize(value: unknown): JsonValue {
  return JSON.parse(
    JSON.stringify(value, (key, value) => {
      if (value && typeof value === "object" && value.type === "image" && typeof value.data === "string") {
        const { data, ...rest } = value;
        return { ...rest, omittedBytes: Math.floor((data.length * 3) / 4) };
      }
      return value;
    }),
  ) as JsonValue;
}

/** The message an entry contributes to context: a compaction contributes its summary last. */
function entryMessage(entry: RecalledEntry): Message | undefined {
  return entry.type === "message" ? entry.message : sessionEntryToContextMessages(entry).at(-1);
}

/** A one-line summary of an entry. */
export function entryClip(entry: RecalledEntry): string {
  const message = entryMessage(entry);
  return message ? summarize(message) : "";
}

const textOrNothing = (text: string, max: number): JsonObject => (text.trim() ? { text: excerpt(text, max) } : {});

/** What an entry says: text kept whole up to TEXT_MAX, summaries by section. Tool calls are left to the trace. */
function messageFields(entry: RecalledEntry): JsonObject {
  switch (entry.type) {
    case "compaction":
      return { summary: sectionExcerpt(entry.summary, TEXT_MAX), summaryChars: entry.summary.length, tokensBefore: entry.tokensBefore };
    case "branch_summary":
      return { summary: sectionExcerpt(entry.summary, TEXT_MAX), summaryChars: entry.summary.length };
    case "custom_message":
      return { customType: entry.customType, ...textOrNothing(contentText(entry.content), TEXT_MAX) };
  }
  const { message } = entry;
  switch (message.role) {
    case "user":
      return textOrNothing(contentText(message.content), TEXT_MAX);
    case "assistant": {
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      return {
        ...textOrNothing(text, TEXT_MAX),
        ...(message.stopReason === "error" || message.stopReason === "aborted"
          ? { stopReason: message.stopReason, ...(message.errorMessage ? { errorMessage: excerpt(message.errorMessage, ERROR_MAX) } : {}) }
          : {}),
      };
    }
    case "toolResult": {
      const output = contentText(message.content);
      return {
        toolName: message.toolName,
        status: message.isError ? "error" : "ok",
        resultChars: output.length,
        ...(message.isError ? { errorExcerpt: excerpt(output, ERROR_MAX, 1 / 2) } : {}),
      };
    }
    case "bashExecution":
      return {
        command: excerpt(message.command, ERROR_MAX),
        ...(message.cancelled ? { cancelled: true } : { exitCode: message.exitCode ?? null }),
        outputChars: message.output.length,
        ...(message.output.trim() ? { output: excerpt(message.output, OUTPUT_MAX, 1 / 2) } : {}),
      };
    case "custom":
      return { customType: message.customType, ...textOrNothing(contentText(message.content), TEXT_MAX) };
    case "branchSummary":
    case "compactionSummary":
      return { summary: sectionExcerpt(message.summary, TEXT_MAX), summaryChars: message.summary.length };
    case "system":
      return textOrNothing(contentText(message.content), SYSTEM_MAX);
    default:
      return textOrNothing(contentText((message as { content?: unknown }).content), TEXT_MAX);
  }
}

export function formatEntry(entry: RecalledEntry, outputMode: OutputMode, notes: EntryNotes = {}) {
  const metadata = {
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    type: entry.type,
    ...(entry.type === "message" ? { role: entry.message.role } : {}),
    ...notes,
  };
  switch (outputMode) {
    case "messages":
      return { ...metadata, ...messageFields(entry) };
    case "full": {
      // Extension details and the compaction-time system prompt are not part of the conversation.
      const { id, parentId, timestamp, type, details, systemMessage, ...rest } = entry as RecalledEntry & {
        details?: unknown;
        systemMessage?: unknown;
      };
      return { ...metadata, ...(sanitize(rest) as JsonObject) };
    }
  }
}
