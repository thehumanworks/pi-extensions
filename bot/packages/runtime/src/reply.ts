import type { BotEvent } from "./types.js";

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
  const data = (event.data ?? {}) as Record<string, any>;
  const message = event.type === "message_start" ? data.message
    : event.type === "message_end" ? (Array.isArray(data.entry?.model) ? data.entry.model.find((item: { role?: string }) => item?.role === "assistant") : undefined)
    : event.type === "snapshot" ? data.generation?.message : undefined;
  return message?.role === "assistant" && Array.isArray(message.content) ? copy(message.content) : undefined;
}

const answer = (content: Array<ReplyBlock | undefined>) => content.filter(block => block?.type === "text").map(block => block!.text ?? "").join("\n");

export interface ReplyPreview {
  /** Apply a run event. Returns true when the preview text changed. */
  apply(event: BotEvent): boolean;
  /** Assistant text so far: completed messages, then the in-flight one, separated by blank lines. */
  readonly text: string;
}
/**
 * Live text of a run's replies, rebuilt from its events. Durable partials are coalesced per commit, so a block's tail
 * may only arrive in message_end and a fast reply may have no message_update at all; final messages always win.
 */
export function createReplyPreview(): ReplyPreview {
  const done: string[] = [];
  let current: Array<ReplyBlock | undefined> | undefined;
  const settle = (content: Array<ReplyBlock | undefined>) => { const text = answer(content).trim(); if (text) done.push(text); };
  const render = () => [...done, current ? answer(current).trim() : ""].filter(Boolean).join("\n\n");
  return {
    apply(event) {
      const before = render();
      const whole = assistantContent(event);
      if (event.type === "message_end") { if (whole) { settle(whole); current = undefined; } }
      else if (event.type === "message_start" && whole) { if (current) settle(current); current = whole; }
      else if (event.type === "snapshot") current = whole;
      else if (event.type === "message_update") current = applyChanges(current ?? [], (event.data as { changes?: unknown } | undefined)?.changes);
      return render() !== before;
    },
    get text() { return render(); },
  };
}
