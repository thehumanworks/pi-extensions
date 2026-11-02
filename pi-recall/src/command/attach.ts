import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { EntryNotes, RecalledEntry } from "../entries.ts";
import { excerpt } from "../clip.ts";
import { contentText } from "../format.ts";

/** An entry chosen in /recall, with the session it came from. */
export interface RecallItem {
  sessionId: string;
  entry: RecalledEntry;
  notes: EntryNotes;
}

export const itemKey = (item: RecallItem) => `${item.sessionId}/${item.entry.id}`;

/** Longest text attached per entry; recall_messages can read the rest. */
export const MAX_ATTACHED_CHARS = 8000;

const WIDGET_KEY = "pi-recall";

/** The entry as plain text for the model: no thinking, tool calls as name and JSON arguments. */
export function entryText(entry: RecalledEntry): string {
  switch (entry.type) {
    case "compaction":
    case "branch_summary":
      return entry.summary;
    case "custom_message":
      return contentText(entry.content);
  }
  const { message } = entry;
  switch (message.role) {
    case "assistant":
      return message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "toolCall") return `[tool call] ${block.name} ${JSON.stringify(block.arguments ?? {})}`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    case "toolResult":
      return `[${message.toolName}${message.isError ? " error" : ""}]\n${contentText(message.content)}`;
    case "bashExecution":
      return `$ ${message.command}\n${message.output}`;
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default:
      return contentText((message as { content?: unknown }).content);
  }
}

/** The entry's role for messages, otherwise its type. */
export function entryKind(entry: RecalledEntry): string {
  return entry.type === "message" ? entry.message.role : entry.type;
}

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function recalledSection(items: RecallItem[]): string {
  const messages = items.map(({ sessionId, entry, notes }) => {
    const full = entryText(entry);
    let text = excerpt(full, MAX_ATTACHED_CHARS);
    if (text !== full) {
      text += `\n[Shortened from ${full.length} characters. For all of it, call recall_messages with from ` +
        `"${sessionId}/${entry.id}", limit 1 and outputMode "full".]`;
    }
    const attrs = [
      `session_id="${attr(sessionId)}"`,
      `message_id="${attr(entry.id)}"`,
      entry.type === "message" ? `role="${attr(entry.message.role)}"` : `type="${attr(entry.type)}"`,
      `timestamp="${attr(entry.timestamp)}"`,
      ...(notes.label ? [`label="${attr(notes.label)}"`] : []),
    ];
    return `<message ${attrs.join(" ")}>\n${text}\n</message>`;
  });
  return `<recalled_messages source="user_selected">\n${messages.join("\n")}\n</recalled_messages>`;
}

/** Entries chosen in /recall, waiting to be sent with the next user message. */
export class Attachments {
  private items: RecallItem[] = [];

  get selected(): readonly RecallItem[] {
    return this.items;
  }

  /** Oldest first, so the section reads in conversation order. */
  set(ui: ExtensionContext["ui"], items: RecallItem[]) {
    this.items = [...items].sort((a, b) => a.entry.timestamp.localeCompare(b.entry.timestamp));
    this.showWidget(ui);
  }

  clear(ui: ExtensionContext["ui"]) {
    this.items = [];
    this.showWidget(ui);
  }

  private showWidget(ui: ExtensionContext["ui"]) {
    const n = this.items.length;
    ui.setWidget(
      WIDGET_KEY,
      n === 0
        ? undefined
        : [ui.theme.fg("muted", `↳ ${n} recalled message${n === 1 ? "" : "s"} will be sent with your next message · /recall to change`)],
    );
  }

  /** The input handler: puts the recalled section before the user's text. */
  handleInput(event: InputEvent, ctx: ExtensionContext): InputEventResult {
    if (this.items.length === 0 || event.source === "extension") return { action: "continue" };
    // Skills and prompt templates expand after this event, so they must stay at the start of the text.
    if (event.text.trimStart().startsWith("/")) {
      ctx.ui.notify("Recalled messages stay attached until you send a message that does not start with /", "info");
      return { action: "continue" };
    }
    const text = `${recalledSection(this.items)}\n\n${event.text}`;
    this.clear(ctx.ui);
    return { action: "transform", text };
  }
}
