import assert from "node:assert/strict";
import test from "node:test";
import { applyChanges, createReplyPreview } from "../src/reply.js";
import type { BotEvent } from "../src/types.js";

const assistant = (content: unknown[]) => ({ role: "assistant", content });
const start = (content: unknown[]): BotEvent => ({ type: "message_start", data: { message: assistant(content) } });
const update = (...changes: unknown[]): BotEvent => ({ type: "message_update", data: { changes } });
const end = (message: unknown): BotEvent => ({ type: "message_end", data: { entry: { model: [message] } } });

test("reply preview follows deltas, coalesced partials and final messages across a run", () => {
  const reply = createReplyPreview(); const seen: string[] = [];
  const apply = (event: BotEvent) => { if (reply.apply(event)) seen.push(reply.text); };
  apply({ type: "snapshot", data: { entries: [{ model: [assistant([{ type: "text", text: "earlier conversation" }])] }] } });
  apply({ type: "message_start", data: { message: { role: "user", content: "hello" } } });
  apply(start([{ type: "thinking", thinking: "plan" }]));
  apply(update({ type: "thinking_delta", contentIndex: 0, delta: " more" }, { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 1, delta: "Let me" }));
  apply(end(assistant([{ type: "thinking", thinking: "plan more" }, { type: "text", text: "Let me check." }, { type: "toolCall", id: "t", name: "echo", arguments: {} }])));
  apply({ type: "tool_execution_end", data: { toolCallId: "t", entry: { model: [{ role: "toolResult", content: [{ type: "text", text: "tool text" }] }] } } });
  apply(end({ role: "toolResult", content: [{ type: "text", text: "tool text" }] }));
  // A fast reply can arrive whole in message_end without any update.
  apply(end(assistant([{ type: "text", text: "Done." }])));
  assert.deepEqual(seen, ["Let me", "Let me check.", "Let me check.\n\nDone."]);
  assert.equal(reply.text, "Let me check.\n\nDone.");
});

test("reply preview starts from a snapshot's in-flight generation and keeps a message whose end was lost", () => {
  const reply = createReplyPreview();
  assert.equal(reply.apply({ type: "snapshot", data: { generation: { attempt: 1, message: assistant([{ type: "text", text: "Already" }]) } } }), true);
  reply.apply(update({ type: "text_delta", contentIndex: 0, delta: " streaming" }));
  assert.equal(reply.text, "Already streaming");
  reply.apply(start([{ type: "text", text: "Next" }]));
  assert.equal(reply.text, "Already streaming\n\nNext");
  assert.equal(reply.apply({ type: "unknown", data: null }), false);
  assert.equal(reply.apply(update({ type: "text_delta", delta: "no index" }, null)), false);
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
