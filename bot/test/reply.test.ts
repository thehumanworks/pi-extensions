import assert from "node:assert/strict";
import test from "node:test";
import { applyChanges, createReplyPreview } from "../src/reply.js";
import type { BotContent, BotMessage, BotMessageChange, BotEvent } from "../src/types.js";

const assistant = (content: BotContent[]): BotMessage => ({ role: "assistant", content });
let entryId = 0;
const start = (content: BotContent[]): BotEvent => ({ type: "message_start", data: { message: assistant(content) } });
const update = (...changes: BotMessageChange[]): BotEvent => ({ type: "message_update", data: { changes } });
const end = (message: BotMessage): BotEvent => ({ type: "message_end", data: { entry: { id: ++entryId, kind: "message", model: [message] } } });

test("reply preview follows deltas, coalesced partials and final messages across a run", () => {
  const reply = createReplyPreview(); const seen: string[] = [];
  const apply = (event: BotEvent) => { const before = reply.text; reply.apply(event); if (reply.text !== before) seen.push(reply.text); };
  apply({ type: "snapshot", data: { tools: [], entries: [{ id: ++entryId, kind: "message", model: [assistant([{ type: "text", text: "earlier conversation" }])] }] } });
  apply({ type: "message_start", data: { message: { role: "user", content: [{ type: "text", text: "hello" }] } } });
  apply(start([{ type: "thinking", thinking: "plan" }]));
  apply(update({ type: "thinking_delta", contentIndex: 0, delta: " more" }, { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 1, delta: "Let me" }));
  apply(end(assistant([{ type: "thinking", thinking: "plan more" }, { type: "text", text: "Let me check." }, { type: "toolCall", id: "t", name: "echo", arguments: {} }])));
  apply({ type: "tool_execution_end", data: { toolCallId: "t", toolName: "echo", isError: false, summary: "tool text", entry: { id: ++entryId, kind: "message", model: [{ role: "toolResult", content: [{ type: "text", text: "tool text" }] }] } } });
  apply(end({ role: "toolResult", content: [{ type: "text", text: "tool text" }] }));
  // A fast reply can arrive whole in message_end without any update.
  apply(end(assistant([{ type: "text", text: "Done." }])));
  assert.deepEqual(seen, ["Let me", "Let me check.", "Let me check.\n\nDone."]);
  assert.equal(reply.text, "Let me check.\n\nDone.");
});

test("reply preview starts from a snapshot's in-flight generation and keeps a message whose end was lost", () => {
  const reply = createReplyPreview();
  assert.equal(reply.apply({ type: "snapshot", data: { entries: [], tools: [], generation: { message: assistant([{ type: "text", text: "Already" }]) } } }), true);
  reply.apply(update({ type: "text_delta", contentIndex: 0, delta: " streaming" }));
  assert.equal(reply.text, "Already streaming");
  reply.apply(start([{ type: "text", text: "Next" }]));
  assert.equal(reply.text, "Already streaming\n\nNext");
  assert.equal(reply.apply({ type: "unknown", data: null } as unknown as BotEvent), false);
  assert.equal(reply.apply(({ type: "message_update", data: { changes: [{ type: "text_delta", delta: "no index" }, null] } } as unknown as BotEvent)), false);
});

test("changes replace blocks or the whole message and ignore malformed indexes", () => {
  let content = applyChanges([], [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "a" } }, { type: "text_delta", contentIndex: 0, delta: "b" }]);
  assert.deepEqual(content, [{ type: "text", text: "ab" }]);
  content = applyChanges(content, [{ type: "block", contentIndex: 0, block: { type: "text", text: "replaced" } }, { type: "text_delta", contentIndex: -1, delta: "x" }, { type: "thinking_delta", contentIndex: 0, delta: "wrong kind" }]);
  assert.deepEqual(content, [{ type: "text", text: "replaced" }]);
  content = applyChanges(content, [{ type: "message", message: { content: [{ type: "text", text: "whole" }] } }, { type: "text_delta", contentIndex: 0, delta: "!" }]);
  assert.deepEqual(content, [{ type: "text", text: "whole!" }], "later changes apply to the replacement message");
  assert.equal(applyChanges(content, "not changes"), content);
});

test("tool-only progress, partial results, failures and notices are separate from reply text", () => {
  const reply = createReplyPreview();
  assert(reply.apply({ type: "tool_execution_start", data: { toolCallId: "a", toolName: "read", args: { path: "notes.md" } } }));
  assert.equal(reply.text, ""); assert.match(reply.activity, /⏺ read notes.md/);
  reply.apply({ type: "tool_execution_update", data: { toolCallId: "a", toolName: "read", summary: "Reading header" } });
  assert.match(reply.activity, /Reading header/);
  reply.apply({ type: "tool_execution_end", data: { toolCallId: "a", toolName: "read", isError: true, summary: "Permission denied" } });
  assert.match(reply.activity, /✗ read notes.md — Permission denied/);
  reply.apply({ type: "auto_retry_start", data: { attempt: 2, errorMessage: "Busy" } });
  assert.match(reply.activity, /Retrying \(attempt 2\): Busy/);
  reply.apply({ type: "auto_retry_end", data: { success: true } });
  assert.doesNotMatch(reply.activity, /Retrying/);
  reply.apply({ type: "compaction_start", data: {} }); assert.match(reply.activity, /Compacting/);
  reply.apply({ type: "compaction_end", data: { error: "No space" } }); assert.match(reply.activity, /Compaction failed: No space/);
  reply.apply({ type: "task_failed", data: { message: "Stopped" } }); assert.match(reply.activity, /Stopped/);
});

test("snapshot restores live state, replacement messages win and final entries are deduplicated", () => {
  const reply = createReplyPreview();
  reply.apply({ type: "snapshot", data: {
    entries: [{ id: 800, kind: "message", model: [assistant([{ type: "text", text: "Old answer" }])] }],
    generation: { message: assistant([{ type: "text", text: "Draft" }]) },
    tools: [{ toolCallId: "a", toolName: "search", args: { query: "facts" }, status: "running" }], notice: "Reconnected",
  } });
  assert.equal(reply.text, "Draft"); assert.match(reply.activity, /search facts/); assert.match(reply.activity, /Reconnected/);
  reply.apply(update({ type: "message", message: assistant([{ type: "text", text: "Correct" }]) }, { type: "text_delta", contentIndex: 0, delta: " answer" }));
  assert.equal(reply.text, "Correct answer");
  const final = end(assistant([{ type: "text", text: "Correct answer." }]));
  reply.apply(final); reply.apply(final);
  assert.equal(reply.text, "Correct answer.");
});
