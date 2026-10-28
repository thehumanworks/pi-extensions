import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { colorEnabled, createChatRenderer, loadMarkdown, type MarkdownRenderer } from "../src/render.js";
import type { BotContent, BotMessage, BotMessageChange, BotEvent, BotRunRecord } from "../src/types.js";

function sink(isTTY = false) {
  let text = "";
  return { isTTY, columns: 80, rows: 24, write(chunk: string) { text += chunk; return true; }, get text() { return text; } };
}
function record(overrides: Partial<BotRunRecord> = {}): BotRunRecord {
  return {
    runId: "r1", sessionId: "s1", bot: "bot", cwd: "/w", status: "completed", output: "", model: "faux/model", toolCalls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.500Z", ...overrides,
  };
}
const assistant = (content: BotContent[]): BotMessage => ({ role: "assistant", content });
let entryId = 0;
const start = (content: BotContent[]): BotEvent => ({ type: "message_start", data: { message: assistant(content) } });
const update = (...changes: BotMessageChange[]): BotEvent => ({ type: "message_update", data: { changes } });
const end = (content: BotContent[]): BotEvent => ({ type: "message_end", data: { entry: { id: ++entryId, kind: "message", model: [assistant(content)] } } });
/** Visible screen after cursor-up/clear-below, carriage returns and SGR styling. */
function screen(output: string): string {
  const lines = [""]; let row = 0;
  for (const token of output.replace(/\x1b\[[0-9;]*m/g, "").match(/\x1b\[\d*[AJ]|\r|\n|[^\x1b\r\n]+/g) ?? []) {
    if (token === "\n") { row++; lines[row] ??= ""; }
    else if (token === "\r") { /* column 0: the renderer always follows it with a clear */ }
    else if (token.endsWith("A")) row -= Number(token.slice(2, -1) || 1);
    else if (token.endsWith("J")) { lines.length = row + 1; lines[row] = ""; }
    else lines[row] += token;
  }
  return lines.join("\n");
}

test("streams answers to stdout and thinking, tools and usage to stderr, reconciling throttled partials", () => {
  const stdout = sink(); const stderr = sink();
  const renderer = createChatRenderer({ stdout, stderr, color: { stdout: false, stderr: false } });
  renderer.begin(false);
  for (const event of [
    start([{ type: "thinking", thinking: "Plan" }]),
    update({ type: "thinking_delta", contentIndex: 0, delta: " the call\nthen answer" }, { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 1, delta: "Let me" }),
    // The last block's tail can arrive only in message_end.
    end([{ type: "thinking", thinking: "Plan the call\nthen answer" }, { type: "text", text: "Let me check." }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }]),
    { type: "tool_execution_start", data: { toolCallId: "t1", toolName: "bash", args: { command: "ls  -la\n/tmp" } } },
    { type: "tool_execution_end", data: { toolCallId: "t1", toolName: "bash", isError: false, summary: "a\nb\nc", entry: { id: ++entryId, kind: "message", model: [{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a\nb\nc" }], isError: false }] } } },
    { type: "tool_execution_start", data: { toolCallId: "t2", toolName: "read", args: { path: "missing" } } },
    { type: "tool_execution_end", data: { toolCallId: "t2", toolName: "read", isError: true, summary: "ENOENT", entry: { id: ++entryId, kind: "message", model: [{ role: "toolResult", toolCallId: "t2", toolName: "read", content: [{ type: "text", text: "ENOENT" }], isError: true }] } } },
    // No deltas at all: a fast provider can commit a whole message at once.
    end([{ type: "thinking", thinking: "", redacted: true }, { type: "text", text: "All **done**." }]),
    { type: "message_start", data: { message: { role: "user", content: [{ type: "text", text: "ignored" }] } } },
    { type: "unknown_future_event", data: null } as unknown as BotEvent,
  ] satisfies BotEvent[]) renderer.onEvent(event);
  renderer.finish(record({ output: "All **done**.", toolCalls: 2, usage: { input: 1234, output: 34, cacheRead: 5000, cacheWrite: 0, cost: 0.01234, turns: 2 } }));
  assert.equal(stdout.text, "Let me check.\n\nAll **done**.\n");
  assert.equal(stderr.text, [
    "\n✻ Plan the call", "  then answer", "",
    "⏺ bash ls -la /tmp", "  ⎿ a · (+2 lines)", "",
    "⏺ read missing", "  ⎿ ✗ ENOENT", "",
    "✻ (thinking redacted)", "",
    "✓ completed · 1.5s · 2 turns · 2 tool calls · ↑1.2k ↓34 · cache R5.0k W0 · $0.0123 · faux/model",
    "Session: s1 · Run: r1", "",
  ].join("\n"));
  assert.ok(!stdout.text.includes("\x1b[") && !stderr.text.includes("\x1b["));
});

test("final records complete lost tails, unstreamed runs and failures without duplicating answers", () => {
  const stdout = sink(); const stderr = sink();
  const renderer = createChatRenderer({ stdout, stderr, color: { stdout: false, stderr: false } });
  renderer.begin(true);
  renderer.onEvent(start([{ type: "text", text: "Partial" }]));
  renderer.finish(record({ output: "Partial answer." }));
  renderer.begin(true);
  renderer.finish(record({ runId: "r2", output: "Unstreamed." }));
  renderer.begin(true);
  renderer.onEvent(end([{ type: "text", text: "Same" }]));
  renderer.finish(record({ runId: "r3", output: "Same", status: "failed", error: "provider exploded" }));
  assert.equal(stdout.text, "Partial answer.\n\nUnstreamed.\n\nSame\n");
  assert.match(stderr.text, /^✓ completed .*\nSession: s1 · Run: r1\n✓ completed[^]*Run: r2\n✗ failed[^]*\nprovider exploded\nSession: s1 · Run: r3\n$/);
  renderer.begin(true); renderer.onEvent(start([{ type: "text", text: "cut" }])); renderer.stop();
  assert.ok(stdout.text.endsWith("cut\n"), "an interrupted turn ends its line");
});

test("formatted answers commit complete markdown blocks and erase live previews on a terminal", () => {
  const markdown: MarkdownRenderer = {
    render: text => text.trim() ? text.trim().split("\n").map(line => `<${line}>`) : [],
    complete(text) { const index = text.lastIndexOf("\n\n"); return index < 0 ? 0 : index + 2; },
  };
  const stdout = sink(true); const stderr = sink(true);
  const renderer = createChatRenderer({ stdout, stderr, markdown, color: { stdout: true, stderr: true } });
  renderer.begin(true);
  renderer.onEvent(start([{ type: "text", text: "First" }]));
  renderer.onEvent(update({ type: "text_delta", contentIndex: 0, delta: " para\n\nSec" }));
  renderer.onEvent(update({ type: "text_delta", contentIndex: 0, delta: "ond" }));
  renderer.onEvent(end([{ type: "text", text: "First para\n\nSecond para" }]));
  renderer.finish(record({ output: "First para\n\nSecond para" }));
  assert.match(stdout.text, /\x1b\[J/, "previews were drawn and erased");
  const visible = screen(stdout.text + stderr.text);
  assert.ok(visible.startsWith("<First para>\n\n<Second para>\n\n✓ completed"), JSON.stringify(visible));
  assert.ok(!visible.includes("<Sec>") && !visible.includes("<Second>"));
  // Piped stdout gets committed blocks only, never cursor movement.
  const piped = sink(); const renderer2 = createChatRenderer({ stdout: piped, stderr: sink(), markdown, color: { stdout: true, stderr: false } });
  renderer2.begin(false);
  renderer2.onEvent(start([{ type: "text", text: "One\n\nTw" }]));
  renderer2.onEvent(end([{ type: "text", text: "One\n\nTwo" }]));
  renderer2.finish(record({ output: "One\n\nTwo" }));
  assert.equal(piped.text, "<One>\n\n<Two>\n");
});

test("color follows --no-color, NO_COLOR, FORCE_COLOR and terminal detection", () => {
  const tty = { isTTY: true, write() {} }; const pipe = { write() {} };
  assert.equal(colorEnabled(tty, {}), true);
  assert.equal(colorEnabled(tty, { TERM: "dumb" }), false);
  assert.equal(colorEnabled(pipe, {}), false);
  assert.equal(colorEnabled(tty, {}, true), false);
  assert.equal(colorEnabled(tty, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled(tty, { FORCE_COLOR: "0" }), false);
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: "1" }, true), false, "--no-color always wins");
});

test("Pi markdown renderer styles terminal markdown and detects complete blocks", async t => {
  const agentDir = await mkdtemp(join(tmpdir(), "bot-render-")); const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  });
  const markdown = await loadMarkdown();
  const lines = markdown.render("# Title\n\nSome `code` here.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n", 40);
  assert.ok(lines.some(line => line.includes("\x1b[")), "styled");
  const plain = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(plain[0], "Title"); assert.ok(plain.includes("Some code here.")); assert.ok(plain.some(line => line.startsWith("┌")));
  assert.equal(plain.at(-1), "└───┴───┘", "no trailing blank lines");
  assert.equal(markdown.complete("Para one\n\nPara tw"), "Para one\n\n".length);
  assert.equal(markdown.complete("```ts\nconst x = 1;\n\nstill code"), 0, "an open fence is not complete");
  assert.equal(markdown.complete("Only one"), 0);
});

test("reconnect restores partial text and tools without replaying history or duplicating final answers", () => {
  const stdout = sink(); const stderr = sink();
  const renderer = createChatRenderer({ stdout, stderr, color: { stdout: false, stderr: false } });
  renderer.begin(true);
  const snapshot: BotEvent = { type: "snapshot", data: {
    entries: [{ id: 900, kind: "message", model: [assistant([{ type: "text", text: "Old answer" }])] }],
    generation: { message: assistant([{ type: "text", text: "Live" }]) },
    tools: [{ toolCallId: "a", toolName: "search", args: { query: "facts" }, status: "running" }],
  } };
  renderer.onEvent(snapshot); renderer.onEvent(snapshot);
  renderer.onEvent(update({ type: "message", message: assistant([{ type: "text", text: "Live answer" }]) }));
  const final = end([{ type: "text", text: "Live answer." }]);
  renderer.onEvent(final); renderer.onEvent(final);
  renderer.onEvent({ type: "tool_execution_update", data: { toolCallId: "a", toolName: "search", summary: "One match" } });
  renderer.onEvent({ type: "tool_execution_end", data: { toolCallId: "a", toolName: "search", summary: "Search unavailable", isError: true } });
  renderer.onEvent({ type: "auto_retry_start", data: { attempt: 2, errorMessage: "Busy" } });
  renderer.onEvent({ type: "auto_retry_end", data: { success: false, errorMessage: "Still busy" } });
  renderer.finish(record({ output: "Live answer." }));
  assert.equal(stdout.text, "Live answer.\n");
  assert.equal(stderr.text.match(/⏺ search facts/g)?.length, 1);
  assert.match(stderr.text, /One match/); assert.match(stderr.text, /✗ Search unavailable/);
  assert.match(stderr.text, /Retrying \(attempt 2\): Busy/); assert.match(stderr.text, /Retry failed: Still busy/);
});

test("authoritative whole-message replacements retain corrected text, including completed blocks", () => {
  const stdout = sink(); const stderr = sink();
  const renderer = createChatRenderer({ stdout, stderr, color: { stdout: false, stderr: false } });
  renderer.begin(true);
  renderer.onEvent(start([{ type: "text", text: "Draft" }]));
  renderer.onEvent(update({ type: "message", message: assistant([{ type: "text", text: "Correct" }]) }));
  renderer.onEvent(end([{ type: "text", text: "Correct answer" }]));
  renderer.finish(record({ output: "Correct answer" }));
  // Pipe output is append-only: a non-prefix correction is printed once in a fresh section.
  assert.equal(stdout.text, "Draft\n\nCorrect answer\n");
});
