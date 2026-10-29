import type { BotEvent, BotToolActivity } from "./types.js";

/** An assistant content block as carried by bot events: text, thinking or a tool call. */
export type ReplyBlock = { type: string; text?: string; thinking?: string; redacted?: boolean };
type Change = { type?: string; contentIndex?: number; block?: ReplyBlock; delta?: string; message?: { content?: ReplyBlock[] } };
const STARTS = new Set(["text_start", "thinking_start", "toolcall_start", "block"]);
const copy = (content: ReplyBlock[]) => content.map(block => ({ ...block }));

/** Apply one message_update's ordered changes to in-flight assistant content. Returns the (possibly replaced) content. */
export function applyChanges(content: Array<ReplyBlock | undefined>, changes: unknown): Array<ReplyBlock | undefined> {
  if (!Array.isArray(changes)) return content;
  for (const change of changes as Change[]) {
    if (change?.type === "message") { if (Array.isArray(change.message?.content)) content = copy(change.message.content); continue; }
    const index = change?.contentIndex;
    if (!Number.isSafeInteger(index) || index! < 0) continue;
    const block = content[index!];
    if (STARTS.has(change.type ?? "") && change.block) content[index!] = { ...change.block };
    else if (change.type === "text_delta" && block?.type === "text") block.text = (block.text ?? "") + (change.delta ?? "");
    else if (change.type === "thinking_delta" && block?.type === "thinking") block.thinking = (block.thinking ?? "") + (change.delta ?? "");
  }
  return content;
}

/** Whole assistant content carried by an event: a starting partial, the final message, or a snapshot's in-flight generation. */
export function assistantContent(event: BotEvent): ReplyBlock[] | undefined {
  const message = event.type === "message_start" ? event.data.message
    : event.type === "message_end" ? event.data.entry.model.find(item => item.role === "assistant")
    : event.type === "snapshot" ? event.data.generation?.message : undefined;
  return message?.role === "assistant" && Array.isArray(message.content) ? copy(message.content) : undefined;
}

const answer = (content: Array<ReplyBlock | undefined>) => content.filter(block => block?.type === "text").map(block => block!.text ?? "").join("\n");

export interface ReplyPreview {
  /** Apply a run event. Returns true when text or activity changed. */
  apply(event: BotEvent): boolean;
  /** Assistant text so far: completed messages, then the in-flight one, separated by blank lines. */
  readonly text: string;
  /** Bounded tool activity and retry/compaction/error notices, separate from answer text. */
  readonly activity: string;
}
/**
 * Live text of a run's replies, rebuilt from its events. Durable partials are coalesced per commit, so a block's tail
 * may only arrive in message_end and a fast reply may have no message_update at all; final messages always win.
 */
/** Brief tool arguments, shared by live UI consumers. */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const values = args as Record<string, unknown>;
  const key = ["command", "path", "file_path", "pattern", "query", "url"].find(key => typeof values[key] === "string");
  return brief(key ? String(values[key]) : JSON.stringify(args));
}
const brief = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 240);
export function toolActivityText(tool: BotToolActivity): string {
  const glyph = tool.status === "failed" ? "✗" : tool.status === "completed" ? "✓" : "⏺";
  return `${glyph} ${tool.toolName}${tool.args ? ` ${summarizeArgs(tool.args)}` : ""}${tool.summary ? ` — ${brief(tool.summary)}` : ""}`;
}
export function createReplyPreview(): ReplyPreview {
  const done: string[] = [];
  const seen = new Set<string>();
  const tools = new Map<string, BotToolActivity>();
  let notice = "";
  let settledRun: string | undefined;
  let current: Array<ReplyBlock | undefined> | undefined;
  const settle = (content: Array<ReplyBlock | undefined>) => { const text = answer(content).trim(); if (text) done.push(text); };
  const render = () => [...done, current ? answer(current).trim() : ""].filter(Boolean).join("\n\n");
  const activity = () => [...[...tools.values()].slice(-4).map(toolActivityText), notice].filter(Boolean).join("\n");
  return {
    apply(event) {
      const id = event.runId ?? (event.type === "snapshot" ? event.data.run?.runId : event.type === "run_settled" ? event.data.runId : undefined);
      if (id && id === settledRun) return false; // A terminal record wins over buffered partials or repeated snapshots.
      const before = render() + "\0" + activity();
      const whole = assistantContent(event);
      if (event.type === "message_end") {
        const key = `${event.sessionId ?? ""}:${event.data.entry.id}`;
        if (!seen.has(key)) { seen.add(key); if (whole) { settle(whole); current = undefined; } }
      }
      else if (event.type === "message_start" && whole) { if (current) settle(current); current = whole; }
      else if (event.type === "snapshot") {
        current = whole;
        tools.clear(); for (const tool of event.data.tools) tools.set(tool.toolCallId, tool);
        notice = event.data.notice ?? "";
        // History is not attributed to this run. Remember IDs only, never display its answers.
        for (const entry of event.data.entries) seen.add(`${event.sessionId ?? ""}:${entry.id}`);
        const run = event.data.run;
        if (run && ["completed", "failed", "cancelled"].includes(run.status)) {
          done.length = 0; if (run.output) done.push(run.output); current = undefined; settledRun = run.runId;
          if (run.error) notice = `✗ ${brief(run.error)}`;
        }
      }
      else if (event.type === "message_update") current = applyChanges(current ?? [], event.data.changes);
      else if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const data = event.data;
        tools.set(data.toolCallId, { ...tools.get(data.toolCallId), ...data,
          status: event.type === "tool_execution_end" ? (event.data.isError ? "failed" : "completed") : "running" });
        if (tools.size > 20) for (const [id, tool] of tools) if (tools.size > 20 && tool.status !== "running") tools.delete(id);
      }
      else if (event.type === "auto_retry_start") notice = `↻ Retrying (attempt ${event.data.attempt}): ${brief(event.data.errorMessage)}`;
      else if (event.type === "auto_retry_end") notice = event.data.success ? "" : `✗ Retry failed: ${brief(event.data.errorMessage ?? "Provider error")}`;
      else if (event.type === "compaction_start") notice = "… Compacting context";
      else if (event.type === "compaction_end") notice = event.data.error ? `✗ Compaction failed: ${brief(event.data.error)}` : "";
      else if (event.type === "task_failed" || event.type === "error") notice = `✗ ${brief(event.data.message)}`;
      else if (event.type === "run_settled") {
        settledRun = event.data.runId;
        if (event.data.output) { done.length = 0; done.push(event.data.output); current = undefined; }
        if (event.data.error) notice = `✗ ${brief(event.data.error)}`;
      }
      return render() + "\0" + activity() !== before;
    },
    get text() { return render(); },
    get activity() { return activity(); },
  };
}
