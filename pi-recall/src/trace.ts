import type { JsonObject } from "@earendil-works/pi-ai";
import { excerpt } from "./clip.ts";
import type { RecalledEntry, SessionView } from "./entries.ts";
import { callLabel, clip, contentText } from "./format.ts";

const CHANGED_MAX = 8;
const ERRORS_MAX = 3;
const ERROR_CHARS = 300;

/**
 * Entries the messages view shows: what was said, summarized or run by the user. Tool calls and their
 * outputs are the trace of the message before them.
 */
export function isMessage(entry: RecalledEntry): boolean {
  if (entry.type !== "message") return true;
  const { message } = entry;
  switch (message.role) {
    case "toolResult":
      return false;
    case "assistant":
      return message.content.some((block) => block.type === "text" && block.text.trim() !== "")
        || message.stopReason === "error"
        || message.stopReason === "aborted";
    default:
      return true;
  }
}

/** The file a call writes, for tools whose name says they edit or write. */
function changedPath(name: string, args: unknown): string | undefined {
  if (!/edit|write/i.test(name) || !args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const path = record.path ?? record.file_path;
  return typeof path === "string" ? clip(path, 120) : undefined;
}

/**
 * The tool activity a message led to: its own tool calls and the entries after it, up to the next message.
 * Counts calls by tool, and keeps the files changed and the calls that failed, which often explain what
 * happened next. Undefined if the message made no calls.
 */
export function traceOf(entry: RecalledEntry, view: SessionView, sessionId: string): JsonObject | undefined {
  const start = view.entries.indexOf(entry);
  let end = start + 1;
  while (end < view.entries.length && !isMessage(view.entries[end]!)) end++;

  const tools = new Map<string, number>();
  const changed = new Set<string>();
  const errors: JsonObject[] = [];
  let calls = 0;
  let failed = 0;
  const record = (name: string, call: string, result: RecalledEntry | undefined) => {
    calls++;
    tools.set(name, (tools.get(name) ?? 0) + 1);
    if (result?.type !== "message" || result.message.role !== "toolResult" || !result.message.isError) return;
    failed++;
    if (errors.length < ERRORS_MAX) {
      errors.push({
        tool: name,
        ...(call ? { call } : {}),
        error: excerpt(contentText(result.message.content), ERROR_CHARS, 1 / 2),
        result: `${sessionId}/${result.id}`,
      });
    }
  };

  for (const e of view.entries.slice(start, end)) {
    if (e.type !== "message") continue;
    const { message } = e;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const result = view.toolResult(block.id);
        record(block.name, callLabel(block.arguments), result);
        const path = changedPath(block.name, block.arguments);
        if (path && !(result?.message.role === "toolResult" && result.message.isError)) changed.add(path);
      }
    } else if (message.role === "toolResult" && !view.hasCall(message.toolCallId)) {
      record(message.toolName, "", e);
    }
  }
  if (calls === 0) return undefined;

  const paths = [...changed];
  return {
    entries: end - start - 1,
    calls,
    tools: Object.fromEntries([...tools].sort((a, b) => b[1] - a[1])),
    ...(paths.length > 0 ? { changed: paths.slice(0, CHANGED_MAX) } : {}),
    ...(paths.length > CHANGED_MAX ? { moreChanged: paths.length - CHANGED_MAX } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    ...(failed > errors.length ? { moreErrors: failed - errors.length } : {}),
  };
}
