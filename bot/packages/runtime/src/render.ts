import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { styleText } from "node:util";
import { applyChanges, assistantContent, type ReplyBlock } from "./reply.js";
import type { BotEvent, BotEventData, BotRunRecord } from "./types.js";

/** A writable stream; TTY fields enable live previews and width-aware rendering. */
export interface TerminalOutput { write(chunk: string): unknown; isTTY?: boolean; columns?: number; rows?: number }
export interface MarkdownRenderer {
  /** Styled terminal lines, none wider than width. */
  render(markdown: string, width: number): string[];
  /** Length of the leading complete top-level blocks; the remainder may still grow. */
  complete(markdown: string): number;
}
export interface ChatRendererOptions {
  stdout: TerminalOutput;
  stderr: TerminalOutput;
  /** ANSI styling per stream. Answers are formatted only when stdout is styled and markdown is supplied. */
  color: { stdout: boolean; stderr: boolean };
  markdown?: MarkdownRenderer;
}
export interface ChatRenderer {
  /** Start a turn. echoed: the terminal already moved past the prompt line. */
  begin(echoed: boolean): void;
  onEvent(event: BotEvent): void;
  /** Complete the answer from the authoritative record (also for unstreamed runs), then print usage. */
  finish(record: BotRunRecord): void;
  /** End an interrupted turn without a record: clear any live preview and end partial lines. */
  stop(): void;
}

/** --no-color and NO_COLOR win, FORCE_COLOR forces styling, otherwise style only terminals. */
export function colorEnabled(stream: TerminalOutput, env: NodeJS.ProcessEnv, disabled = false): boolean {
  if (disabled || env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return !["0", "false"].includes(env.FORCE_COLOR);
  return stream.isTTY === true && env.TERM !== "dumb";
}

/** Pi's terminal markdown renderer with the user's Pi theme and code highlighting. */
export async function loadMarkdown(): Promise<MarkdownRenderer> {
  const [{ Markdown, Marked }, pi] = await Promise.all([import("@earendil-works/pi-tui"), import("@earendil-works/pi-coding-agent")]);
  let theme: string | undefined;
  try {
    const settings = JSON.parse(await readFile(join(pi.getAgentDir(), "settings.json"), "utf8")) as { theme?: unknown };
    if (typeof settings.theme === "string") theme = settings.theme;
  } catch { /* the default theme is fine for display */ }
  pi.initTheme(theme);
  const style = pi.getMarkdownTheme();
  const lexer = new Marked();
  return {
    render(markdown, width) {
      const lines = new Markdown(markdown, 0, 0, style).render(width).map(line => line.replace(/\s+$/, ""));
      // Blocks carry their own blank separators; callers space chunks themselves.
      while (lines.length && !lines[0]) lines.shift();
      while (lines.length && !lines.at(-1)) lines.pop();
      return lines;
    },
    complete(markdown) {
      const tokens = lexer.lexer(markdown);
      let last = tokens.length - 1;
      while (last >= 0 && tokens[last].type === "space") last--;
      const prefix = tokens.slice(0, Math.max(0, last)).map(token => token.raw).join("");
      return markdown.startsWith(prefix) ? prefix.length : 0;
    },
  };
}

type Style = Parameters<typeof styleText>[0];
type Block = ReplyBlock;
interface Stream { out: TerminalOutput; color: boolean; atLineStart: boolean; used: boolean }
interface BlockState { started: boolean; shown: string; committed: number; chunks: number }

const isText = (block: Block | undefined): block is Block => block?.type === "text";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
function tokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  return count < 1_000_000 ? `${Math.round(count / 1000)}k` : `${(count / 1_000_000).toFixed(1)}M`;
}
function duration(record: BotRunRecord): string | undefined {
  const ms = Date.parse(record.updatedAt) - Date.parse(record.createdAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
function truncate(text: string, room: number): string {
  const chars = [...text];
  return chars.length <= room ? text : `${chars.slice(0, Math.max(0, room - 1)).join("")}…`;
}
function summarize(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const key = ["command", "path", "file_path", "pattern", "query", "url"].find(name => typeof record[name] === "string");
  const strings = Object.values(record).filter(value => typeof value === "string");
  const text = key ? record[key] as string : strings.length === 1 && Object.keys(record).length === 1 ? strings[0] as string : JSON.stringify(args);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Renders one chat's runs: answers to stdout; thinking, tools, notices and usage to stderr. Events are reconciled
 * against the latest full message, because durable partials are throttled and a block's tail may only arrive at
 * message_end. Formatted answers commit complete markdown blocks; on a TTY the growing block is a live preview.
 */
export function createChatRenderer(options: ChatRendererOptions): ChatRenderer {
  const out: Stream = { out: options.stdout, color: options.color.stdout, atLineStart: true, used: false };
  const err: Stream = { out: options.stderr, color: options.color.stderr, atLineStart: true, used: false };
  const shared = options.stdout.isTTY === true && options.stderr.isTTY === true;
  const markdown = out.color ? options.markdown : undefined;
  const live = !!markdown && options.stdout.isTTY === true;
  const states = new Map<number, BlockState>();
  const tools = new Map<string, string>();
  const seen = new Set<string>();
  const toolSummaries = new Map<string, string>();
  let message: { content: Array<Block | undefined> } | undefined;
  let cursor = 0;
  let previewRows = 0;
  let sectioned = false;
  let lastTool: string | undefined;
  let lastAnswer = "";
  const finishedRuns = new Set<string>();

  const paint = (stream: Stream, style: Style, text: string) => stream.color && text ? styleText(style, text, { validateStream: false }) : text;
  const width = (stream: Stream) => Math.max(20, (stream.out.columns ?? 80) - 1);
  function clearPreview() {
    if (!previewRows) return;
    options.stdout.write(`\r${previewRows > 1 ? `\x1b[${previewRows - 1}A` : ""}\x1b[J`);
    previewRows = 0;
  }
  function write(stream: Stream, text: string, style?: Style) {
    if (!text) return;
    if (previewRows && (stream === out || shared)) clearPreview();
    // Style each line separately so no escape sequence spans a newline.
    stream.out.write(style ? text.split("\n").map(line => paint(stream, style, line)).join("\n") : text);
    stream.atLineStart = text.endsWith("\n");
  }
  function endLine(stream: Stream) { if (!stream.atLineStart) write(stream, "\n"); }
  /** Separate sections by one blank line; on a shared terminal, across both streams and written to stderr. */
  function section(stream: Stream) {
    clearPreview();
    if (shared) endLine(stream === out ? err : out);
    endLine(stream);
    if (shared ? sectioned : stream.used) write(shared ? err : stream, "\n");
    sectioned = true; stream.used = true;
  }
  const state = (index: number) => {
    let value = states.get(index);
    if (!value) states.set(index, value = { started: false, shown: "", committed: 0, chunks: 0 });
    return value;
  };

  /** Append-only text: write what is new, holding back trailing whitespace until more text follows. */
  function append(stream: Stream, index: number, text: string, done: boolean, look: { style?: Style; marker?: string; indent?: string } = {}) {
    const { style, marker = "", indent = "" } = look;
    const current = state(index);
    const target = text.replace(/^\s+/, "").replace(/\s+$/, "");
    if (!current.started) {
      if (!target) return;
      section(stream); current.started = true;
      write(stream, marker, style);
    }
    if (current.shown && !target.startsWith(current.shown)) {
      // Already-written pipe output cannot be erased. Show the corrected authoritative text in a new section.
      section(stream); current.shown = "";
    }
    if (target.startsWith(current.shown) && target.length > current.shown.length) {
      write(stream, target.slice(current.shown.length).replace(/\n/g, `\n${indent}`), style);
      current.shown = target;
    }
    if (done) endLine(stream);
  }
  function formatted(index: number, text: string, done: boolean) {
    const current = state(index);
    const commit = (source: string) => {
      const lines = markdown!.render(source, width(out));
      if (!lines.length) return;
      if (!current.started) { section(out); current.started = true; }
      write(out, `${current.chunks ? "\n" : ""}${lines.join("\n")}\n`);
      current.chunks++;
    };
    if (current.committed && text.slice(0, current.committed) !== current.shown.slice(0, current.committed)) {
      clearPreview(); current.committed = 0; current.chunks = 0; current.started = false;
    }
    current.shown = text;
    let tail = text.slice(current.committed);
    const complete = done ? tail.length : markdown!.complete(tail);
    if (complete > 0) { commit(tail.slice(0, complete)); current.committed += complete; tail = tail.slice(complete); }
    if (done) clearPreview();
    if (done || !live) return;
    const lines = tail.trim() ? markdown!.render(tail, width(out)) : [];
    if (!lines.length) { clearPreview(); return; }
    if (!current.started) { section(out); current.started = true; } else clearPreview();
    const shown = [...(current.chunks ? [""] : []), ...lines].slice(-Math.max(1, (options.stdout.rows ?? 24) - 2));
    options.stdout.write(shown.join("\n"));
    previewRows = shown.length;
  }
  function renderBlock(index: number, block: Block, done: boolean) {
    if (block.type === "thinking") {
      if (block.redacted) { if (!state(index).started) { section(err); state(index).started = true; write(err, "✻ (thinking redacted)\n", ["dim", "italic"]); } return; }
      append(err, index, block.thinking ?? "", done, { style: ["dim", "italic"], marker: "✻ ", indent: "  " });
    } else if (block.type === "text") {
      if (markdown) formatted(index, block.text ?? "", done); else append(out, index, block.text ?? "", done);
    }
  }
  function sync(final: boolean) {
    if (!message) return;
    const content = message.content;
    for (let index = cursor; index < content.length; index++) {
      const done = final || index < content.length - 1;
      const block = content[index];
      if (block) renderBlock(index, block, done);
      if (!done) return;
      cursor = index + 1;
    }
  }
  function open(content: Block[] = []) { close(); message = { content }; }
  function close() {
    if (!message) return;
    sync(true);
    lastAnswer = message.content.filter(isText).map(block => block.text ?? "").join("\n");
    message = undefined; cursor = 0; states.clear();
  }
  function replaceContent(content: Array<Block | undefined>) {
    if (!message) { open(); message!.content = content; return; }
    const changed = content.findIndex((block, index) => JSON.stringify(block) !== JSON.stringify(message!.content[index]));
    if (changed >= 0) cursor = Math.min(cursor, changed);
    message.content = content;
  }
  function apply(changes: unknown) {
    if (!Array.isArray(changes)) return;
    if (!message) open();
    const before = message!.content.map(block => JSON.stringify(block));
    message!.content = applyChanges(message!.content, changes);
    const changed = message!.content.findIndex((block, index) => JSON.stringify(block) !== before[index]);
    if (changed >= 0) cursor = Math.min(cursor, changed);
  }

  function toolStart(id: string, name: string, args: unknown, nested: boolean, restore = false) {
    if (!restore) close();
    tools.set(id, name);
    const indent = nested ? "  " : "";
    if (nested) endLine(err); else section(err);
    const head = `${indent}⏺ ${name}`;
    const summary = truncate(summarize(args), width(err) - [...head].length - 1);
    write(err, head, "bold"); write(err, summary ? ` ${summary}\n` : "\n", "dim");
    lastTool = id;
  }
  function toolEnd(data: BotEventData["tool_execution_end"] | BotEventData["tool_execution_update"]) {
    const id = data.toolCallId; const nested = !!data.parentToolCallId;
    if (!tools.has(id)) toolStart(id, data.toolName, data.args, nested);
    const isError = "isError" in data && data.isError;
    const text = data.summary || ("isError" in data ? (isError ? "(failed)" : "(no output)") : "(running)");
    const fingerprint = `${isError}:${"isError" in data}:${text}`;
    if (toolSummaries.get(id) === fingerprint) return;
    toolSummaries.set(id, fingerprint);
    const lines = text.split("\n").filter(line => line.trim());
    const prefix = `${nested ? "  " : ""}  ⎿ ${lastTool === id ? "" : `${tools.get(id)}: `}`;
    const extra = lines.length > 1 ? ` · (+${plural(lines.length - 1, "line")})` : "";
    const first = truncate((lines[0] ?? "(no output)").trim(), width(err) - [...prefix].length - extra.length);
    endLine(err);
    write(err, `${prefix}${isError ? "✗ " : ""}${first}${extra}\n`, isError ? "red" : "dim");
    lastTool = id;
  }
  function notice(text: string, style: Style) { section(err); write(err, `${text}\n`, style); }

  function handle(event: BotEvent) {
    const id = event.runId ?? (event.type === "snapshot" ? event.data.run?.runId : event.type === "run_settled" ? event.data.runId : undefined);
    if (id && finishedRuns.has(id)) return;
    switch (event.type) {
      case "snapshot": {
        // Recent entries may predate this run; only restore the live generation and activity.
        for (const entry of event.data.entries) seen.add(`${event.sessionId ?? ""}:${entry.id}`);
        for (const tool of event.data.tools) {
          if (!tools.has(tool.toolCallId)) toolStart(tool.toolCallId, tool.toolName, tool.args, !!tool.parentToolCallId, true);
          if (tool.summary || tool.status !== "running") toolEnd({ ...tool, ...(tool.status !== "running" ? { isError: tool.status === "failed" } : {}) });
        }
        if (event.data.notice) notice(event.data.notice, "yellow");
        const run = event.data.run;
        if (run && ["completed", "failed", "cancelled"].includes(run.status)) { finish(run); break; }
        const content = assistantContent(event);
        if (content) { replaceContent(content); sync(false); }
        break;
      }
      case "run_settled": finish(event.data); break;
      case "message_start": { const content = assistantContent(event); if (content) open(content); sync(false); break; }
      case "message_update": apply(event.data.changes); sync(false); break;
      case "message_end": {
        const key = `${event.sessionId ?? ""}:${event.data.entry.id}`;
        if (seen.has(key)) break;
        seen.add(key);
        const final = assistantContent(event);
        if (!final) break;
        replaceContent(final);
        close(); break;
      }
      case "tool_execution_start": toolStart(event.data.toolCallId, event.data.toolName, event.data.args, !!event.data.parentToolCallId); break;
      case "tool_execution_update": toolEnd(event.data); break;
      case "tool_execution_end": close(); toolEnd(event.data); break;
      case "auto_retry_start": notice(`↻ Retrying (attempt ${event.data.attempt}): ${event.data.errorMessage}`, "yellow"); break;
      case "auto_retry_end": if (!event.data.success) notice(`✗ Retry failed: ${event.data.errorMessage ?? "Provider error"}`, "red"); break;
      case "compaction_start": notice("… Compacting context", "dim"); break;
      case "compaction_end": if (event.data.error) notice(`✗ Compaction failed: ${event.data.error}`, "red"); break;
      case "error": case "task_failed": notice(`✗ ${event.data.message}`, "red"); break;
    }
  }
  function footer(record: BotRunRecord) {
    const { usage } = record;
    const [glyph, color]: [string, Style] = record.status === "completed" ? ["✓", "green"] : record.status === "cancelled" ? ["⊘", "yellow"] : ["✗", "red"];
    const cache = usage.cacheRead || usage.cacheWrite ? `cache R${tokens(usage.cacheRead)} W${tokens(usage.cacheWrite)}` : "";
    const details = [duration(record), plural(usage.turns, "turn"), plural(record.toolCalls, "tool call"),
      `↑${tokens(usage.input)} ↓${tokens(usage.output)}`, cache, usage.cost > 0 ? `$${usage.cost.toFixed(4)}` : "", record.model ?? ""].filter(Boolean);
    section(err);
    write(err, `${glyph} ${record.status}`, color); write(err, ` · ${details.join(" · ")}\n`, "dim");
    if (record.error && record.status !== "completed") write(err, `${record.error}\n`, "red");
    write(err, `Session: ${record.sessionId} · Run: ${record.runId}\n`, "dim");
  }

  function finish(record: BotRunRecord) {
    if (finishedRuns.has(record.runId)) return;
    finishedRuns.add(record.runId);
    if (message && record.output) {
      // Complete a lost streamed tail from the authoritative terminal record.
      const texts = message.content.filter(isText);
      const shown = texts.map(block => block.text ?? "").join("\n");
      const last = texts.at(-1);
      if (last && record.output.length > shown.length && record.output.startsWith(shown)) last.text = (last.text ?? "") + record.output.slice(shown.length);
    }
    close();
    if (record.output && record.output !== lastAnswer) { open([{ type: "text", text: record.output }]); close(); }
    footer(record); endLine(out);
  }

  return {
    begin(echoed) {
      message = undefined; cursor = 0; states.clear(); tools.clear(); seen.clear(); toolSummaries.clear(); lastTool = undefined; lastAnswer = ""; sectioned = false; finishedRuns.clear();
      // The prompt starts each turn on stderr; answers stay separated on stdout.
      err.atLineStart = echoed; err.used = false;
    },
    onEvent(event) {
      try { handle(event); } catch { /* rendering never affects the run */ }
    },
    finish,
    stop() { clearPreview(); endLine(out); endLine(err); },
  };
}
