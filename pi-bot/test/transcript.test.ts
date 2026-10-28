import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { apiMessage, messagesFromEntries, SESSION_ID, TOOL_RESULT_LIMIT, truncate } from "../src/server/transcript.ts";

const entry = (id: string, message: unknown): SessionEntry => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message } as SessionEntry);

test("messagesFromEntries keeps user, assistant and tool results, hides system messages", () => {
  const entries = [
    entry("s1", { role: "system", content: "", sections: {} }),
    entry("u1", { role: "user", content: "hello", timestamp: 1 }),
    entry("a1", {
      role: "assistant", provider: "xai", model: "grok-4.7", stopReason: "stop", timestamp: 2,
      content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "Hi." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "pwd" } }],
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: { total: 0.02 } },
    }),
    entry("t1", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "/tmp" }], isError: false }),
    { type: "label", id: "l1", parentId: "t1", timestamp: "2026-01-01T00:00:00.000Z", targetId: "u1", label: "x" } as SessionEntry,
  ];
  const messages = messagesFromEntries(entries);
  assert.deepEqual(messages.map(m => m.role), ["user", "assistant", "toolResult"]);
  assert.deepEqual(messages[0], { id: "u1", timestamp: 1, role: "user", text: "hello" });
  assert.deepEqual(messages[1], {
    id: "a1", timestamp: 2, role: "assistant", text: "Hi.", thinking: "plan", toolCalls: [{ id: "c1", name: "bash", arguments: { command: "pwd" } }],
    model: "xai/grok-4.7", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
  });
  assert.deepEqual(messages[2], { id: "t1", role: "toolResult", text: "/tmp", toolCallId: "c1", toolName: "bash", isError: false });
});

test("tool results are bounded and assistant errors are carried", () => {
  const long = "x".repeat(TOOL_RESULT_LIMIT + 10);
  const result = apiMessage({ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: long }], isError: true } as never);
  assert.equal(result?.isError, true);
  assert.ok(result!.text.startsWith("x".repeat(TOOL_RESULT_LIMIT)));
  assert.match(result!.text, /10 more characters\]$/);
  assert.equal(truncate("short"), "short");
  const failed = apiMessage({ role: "assistant", content: [], provider: "p", model: "m", stopReason: "error", errorMessage: "Rate limited" } as never);
  assert.equal(failed?.errorMessage, "Rate limited");
  assert.equal(failed?.text, "");
});

test("conversation ids follow Pi's session id rule", () => {
  for (const ok of ["a", "team-1", "2026.10.27_x", "A1"]) assert.ok(SESSION_ID.test(ok), ok);
  for (const bad of ["", "-a", "a-", "a/b", "a b", ".hidden", "a..", "ü"]) assert.ok(!SESSION_ID.test(bad), bad);
});
