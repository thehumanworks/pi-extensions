import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, type MarkdownTheme, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RecalledEntry } from "../entries.ts";
import { clip, contentText, entryClip } from "../format.ts";
import { entryKind, itemKey, type RecallItem } from "./attach.ts";
import type { MarkControls } from "./marks.ts";

export interface RecallPage {
  /** Oldest first. */
  items: RecallItem[];
  /** Whether older entries remain. */
  more: boolean;
}

export interface RecallScreenOptions {
  tui: { terminal: { rows: number }; requestRender(): void };
  theme: Theme;
  keybindings: KeybindingsManager;
  markdownTheme: MarkdownTheme;
  title: string;
  /** Session names or first messages, by session id. */
  sessionLabels: Map<string, string>;
  /** Project names, by session id, for sessions of another project. */
  sessionProjects?: Map<string, string>;
  /** Selected when the screen opens. */
  selected: readonly RecallItem[];
  /** Each call returns the page before the previous one. Omitted for a single entry. */
  loadOlder?: () => Promise<RecallPage>;
  /** Shows this entry alone, without a list or selection. */
  single?: RecallItem;
  /** Marking critical with p and reviewing the agent's marks with r. */
  marks?: MarkControls;
  /** The selection on enter; undefined on cancel. */
  done(result: RecallItem[] | undefined): void;
}

/** Load older entries when the cursor comes this close to the top. */
const PREFETCH = 5;
/** Rows used by borders, headers and hints around the scrolling area, plus pi's footer below the screen. */
const PI_FOOTER = 4;
const LIST_CHROME = 6 + PI_FOOTER;
const DETAIL_CHROME = 9 + PI_FOOTER;

const shortId = (id: string) => id.slice(0, 8);

function time(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "           ";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A fenced code block whose fence is longer than any backtick run in the text. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${lang}\n${text}\n${marks}`;
}

/** The complete entry as Markdown for reading. */
export function entryMarkdown(entry: RecalledEntry): string {
  switch (entry.type) {
    case "compaction":
      return `**Compaction summary** (${entry.tokensBefore} tokens before)\n\n${entry.summary}`;
    case "branch_summary":
      return `**Branch summary**\n\n${entry.summary}`;
    case "custom_message":
      return `**${entry.customType}**\n\n${contentText(entry.content)}`;
  }
  const { message } = entry;
  switch (message.role) {
    case "assistant":
      return message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "thinking") return block.thinking.split("\n").map((line) => `> ${line}`).join("\n");
          if (block.type === "toolCall") {
            return `**${block.name}**\n${fence(JSON.stringify(block.arguments ?? {}, null, 2), "json")}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
    case "toolResult":
      return `**${message.toolName}**${message.isError ? " (error)" : ""}\n${fence(contentText(message.content))}`;
    case "bashExecution":
      return fence(`$ ${message.command}\n${message.output}`);
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default:
      return contentText((message as { content?: unknown }).content);
  }
}

/** The /recall screen: a list of entries and a full view of one, with selection. */
export class RecallScreen implements Component {
  private items: RecallItem[] = [];
  private more: boolean;
  private loading = false;
  private error: string | undefined;
  private cursor = 0;
  private scrollTop = 0;
  private view: "list" | "detail";
  private detailScroll = 0;
  private selected: Map<string, RecallItem>;
  private markdown: { key: string; width: number; lines: string[] } | undefined;
  /** A message shown in place of the key hints until the next key. */
  private notice: string | undefined;

  constructor(private readonly o: RecallScreenOptions) {
    this.selected = new Map(o.selected.map((item) => [itemKey(item), item]));
    if (o.single) {
      this.items = [o.single];
      this.view = "detail";
      this.more = false;
    } else {
      this.view = "list";
      this.more = o.loadOlder !== undefined;
      void this.loadOlder();
    }
  }

  private get viewport(): number {
    return Math.max(3, this.o.tui.terminal.rows - (this.view === "list" ? LIST_CHROME : DETAIL_CHROME));
  }

  /** Loads the page before the oldest entry, keeping the cursor on the same entry. */
  private async loadOlder(): Promise<void> {
    if (this.loading || !this.more || !this.o.loadOlder) return;
    this.loading = true;
    const first = this.items.length === 0;
    try {
      const page = await this.o.loadOlder();
      const before = this.rows().length;
      this.items = [...page.items, ...this.items];
      this.more = page.more;
      if (first) this.cursor = this.items.length - 1;
      else this.cursor += page.items.length;
      this.scrollTop += this.rows().length - before;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.more = false;
    } finally {
      this.loading = false;
      this.o.tui.requestRender();
    }
  }

  private toggle(item: RecallItem | undefined) {
    if (!item) return;
    const key = itemKey(item);
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.set(key, item);
  }

  private moveCursor(delta: number) {
    if (this.items.length === 0) return;
    this.cursor = Math.min(this.items.length - 1, Math.max(0, this.cursor + delta));
    if (this.cursor < PREFETCH) void this.loadOlder();
  }

  private scrollDetail(delta: number) {
    this.detailScroll = Math.max(0, this.detailScroll + delta);
  }

  /** Runs a mark action, then redraws to show the new mark or why it failed. */
  private markAction(action: () => Promise<void>) {
    action()
      .catch((error) => {
        this.notice = error instanceof Error ? error.message : String(error);
      })
      .finally(() => this.o.tui.requestRender());
  }

  handleInput(data: string): void {
    const kb = this.o.keybindings;
    const current = this.items[this.cursor];
    this.notice = undefined;
    const { marks } = this.o;
    if (marks && current && (data === "p" || data === "r")) {
      this.markAction(() => (data === "p" ? marks.toggle(current) : marks.review(current)));
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.o.done(undefined);
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.o.done(this.o.single ? undefined : [...this.selected.values()]);
      return;
    }
    const page = Math.max(1, this.viewport - 1);
    if (this.view === "list") {
      if (kb.matches(data, "tui.select.up")) this.moveCursor(-1);
      else if (kb.matches(data, "tui.select.down")) this.moveCursor(1);
      else if (kb.matches(data, "tui.select.pageUp")) this.moveCursor(-page);
      else if (kb.matches(data, "tui.select.pageDown")) this.moveCursor(page);
      else if (matchesKey(data, "space")) this.toggle(current);
      else if (matchesKey(data, "right") && current) {
        this.view = "detail";
        this.detailScroll = 0;
      } else return;
    } else {
      if (kb.matches(data, "tui.select.up")) this.scrollDetail(-1);
      else if (kb.matches(data, "tui.select.down")) this.scrollDetail(1);
      else if (kb.matches(data, "tui.select.pageUp")) this.scrollDetail(-page);
      else if (kb.matches(data, "tui.select.pageDown")) this.scrollDetail(page);
      else if (matchesKey(data, "space") && !this.o.single) this.toggle(current);
      else if (matchesKey(data, "left") && !this.o.single) this.view = "list";
      else return;
    }
    this.o.tui.requestRender();
  }

  invalidate(): void {
    this.markdown = undefined;
  }

  render(width: number): string[] {
    const lines = this.view === "list" ? this.renderList(width) : this.renderDetail(width);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private keys(id: Parameters<KeybindingsManager["getKeys"]>[0]): string {
    return this.o.keybindings.getKeys(id)[0] ?? "";
  }

  private border(width: number, label = ""): string {
    const { theme } = this.o;
    const tail = label ? ` ${label} ─` : "";
    return theme.fg("border", "─".repeat(Math.max(0, width - visibleWidth(tail)))) + theme.fg("dim", tail);
  }

  private titleLine(width: number, title: string): string {
    const { theme } = this.o;
    const count = this.selected.size > 0 ? `${this.selected.size} selected ` : "";
    const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(count) - 1);
    return ` ${theme.fg("accent", theme.bold(title))}${" ".repeat(gap)}${theme.fg("success", count)}`;
  }

  /** Session header rows and entry rows; entry rows carry the item index. */
  private rows(): { item?: number; session?: string }[] {
    const rows: { item?: number; session?: string }[] = [];
    this.items.forEach((item, i) => {
      if (i === 0 || this.items[i - 1]!.sessionId !== item.sessionId) rows.push({ session: item.sessionId });
      rows.push({ item: i });
    });
    return rows;
  }

  private renderList(width: number): string[] {
    const { theme } = this.o;
    const rows = this.rows();
    const height = this.viewport;
    const cursorRow = rows.findIndex((row) => row.item === this.cursor);
    if (cursorRow !== -1) {
      // Show the session header above the cursor's first entry when there is room.
      const top = rows[cursorRow - 1]?.session !== undefined ? cursorRow - 1 : cursorRow;
      if (top < this.scrollTop) this.scrollTop = top;
      if (cursorRow >= this.scrollTop + height) this.scrollTop = cursorRow - height + 1;
    }
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - height)));

    const body: string[] = [];
    if (this.error) body.push(theme.fg("error", ` ${this.error}`));
    else if (this.loading) body.push(theme.fg("dim", " Loading…"));
    else if (this.items.length === 0) body.push(theme.fg("muted", " No earlier entries in this project."));
    else if (this.more && this.scrollTop === 0) body.push(theme.fg("dim", " ↑ older entries load as you move up"));
    const space = height - body.length;
    for (const row of rows.slice(this.scrollTop, this.scrollTop + space)) {
      if (row.session !== undefined) {
        const first = this.items.find((item) => item.sessionId === row.session)!;
        const label = this.o.sessionLabels.get(row.session);
        const project = this.o.sessionProjects?.get(row.session);
        body.push(theme.fg("muted", ` ── ${shortId(row.session)}${project ? ` · ${project}` : ""}${label ? ` · "${clip(label, 60)}"` : ""} · ${time(first.entry.timestamp)}`));
        continue;
      }
      const item = this.items[row.item!]!;
      const isCursor = row.item === this.cursor;
      const mark = this.selected.has(itemKey(item)) ? theme.fg("success", "●") : " ";
      const text = `${time(item.entry.timestamp)}  ${shortId(item.sessionId)}  ${item.entry.id}  ${entryKind(item.entry).padEnd(10)}  ${entryClip(item.entry)}`;
      body.push(`${isCursor ? theme.fg("accent", "›") : " "}${mark}${this.badge(item)} ${isCursor ? theme.fg("accent", text) : text}`);
    }

    return [
      this.border(width),
      this.titleLine(width, this.o.title),
      this.border(width),
      ...body,
      this.border(width),
      this.hints(` ↑↓ move · space select · → view${this.markHints()} · ${this.keys("tui.select.confirm")} attach selected · ${this.keys("tui.select.cancel")} cancel`),
    ];
  }

  /** ◆ marked critical, ◇ unmarked by the agent and not yet reviewed; warning colour until reviewed. */
  private badge(item: RecallItem): string {
    if (!this.o.marks) return "";
    const state = this.o.marks.get(item);
    if (!state || (!state.marked && state.reviewed)) return " ";
    return this.o.theme.fg(state.reviewed ? "accent" : "warning", state.marked ? "◆" : "◇");
  }

  private markHints(): string {
    return this.o.marks ? " · p critical · r reviewed" : "";
  }

  /** The key hints, or the latest notice in their place. */
  private hints(text: string): string {
    return this.notice ? this.o.theme.fg("warning", ` ${this.notice}`) : this.o.theme.fg("dim", text);
  }

  private renderDetail(width: number): string[] {
    const { theme } = this.o;
    const item = this.items[this.cursor]!;
    const { entry, notes, sessionId } = item;
    const key = itemKey(item);
    if (this.markdown?.key !== key || this.markdown.width !== width) {
      const md = new Markdown(entryMarkdown(entry), 1, 0, this.o.markdownTheme);
      this.markdown = { key, width, lines: md.render(width) };
    }
    const lines = this.markdown.lines;
    const height = this.viewport;
    this.detailScroll = Math.min(this.detailScroll, Math.max(0, lines.length - height));
    const pages = Math.max(1, Math.ceil(lines.length / height));
    const page = Math.min(pages, Math.floor(this.detailScroll / height) + 1);

    const mark = this.o.single ? "" : this.selected.has(key) ? "● " : "  ";
    const label = this.o.sessionLabels.get(sessionId);
    const state = this.o.marks?.get(item);
    const markNote = !state || (!state.marked && state.reviewed)
      ? ""
      : `${state.marked ? "◆ critical" : "◇ unmarked"} by ${state.by}${state.reviewed ? "" : ", unreviewed"}${state.reason ? `: ${clip(state.reason, 80)}` : ""}`;
    const extras = [
      notes.label ? `label "${notes.label}"` : "",
      notes.contextEdit ? `${notes.contextEdit} from context` : "",
      markNote,
    ].filter(Boolean).join(" · ");
    const hints = this.o.single
      ? ` ↑↓ scroll${this.markHints()} · ${this.keys("tui.select.cancel")} close`
      : ` ← back · ↑↓ scroll · space select${this.markHints()} · ${this.keys("tui.select.confirm")} attach selected · ${this.keys("tui.select.cancel")} cancel`;

    return [
      this.border(width),
      this.titleLine(width, `${mark}${entryKind(entry)} · ${new Date(entry.timestamp).toLocaleString()}`),
      theme.fg("muted", `   session ${sessionId}${label ? `  "${clip(label, 60)}"` : ""}`),
      theme.fg("muted", `   message ${entry.id}${extras ? ` · ${extras}` : ""}`),
      this.border(width),
      ...lines.slice(this.detailScroll, this.detailScroll + height),
      this.border(width, `${page}/${pages}`),
      this.hints(hints),
    ];
  }
}
