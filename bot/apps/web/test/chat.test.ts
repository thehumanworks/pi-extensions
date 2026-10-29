import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchJson, isActive, latestUserId, readableJson, runData, sessionTitle, submissionInHistory, validId } from "../lib/chat";

test("run metadata must contain valid session/run IDs and a known status", () => {
  const data = { runId: "r-1", sessionId: "s-1", status: "running" as const };
  assert.deepEqual(runData(data), data);
  assert.equal(isActive(data), true);
  assert.equal(isActive({ ...data, status: "completed" }), false);
  for (const value of [null, {}, { ...data, status: "maybe" }, { ...data, sessionId: "../other" }]) assert.equal(runData(value), undefined);
  assert.equal(validId(undefined), false);
});
test("session and tool labels have safe readable fallbacks", () => {
  assert.equal(sessionTitle({ sessionId: "abcdefghijk", title: " ", cwd: "", createdAt: "", updatedAt: "" }), "Session abcdefgh");
  assert.equal(readableJson(undefined), "Not available yet");
  assert.equal(readableJson({ ok: true }), '{\n  "ok": true\n}');
  assert.equal(readableJson("<script>"), "<script>");
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  assert.equal(readableJson(cycle), "Unable to display this value");
  assert.equal(latestUserId([{ id: "u1", role: "user", parts: [] }, { id: "a1", role: "assistant", parts: [] }, { id: "u2", role: "user", parts: [] }]), "u2");
});
test("fetch errors do not render arbitrary proxy HTML", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<html>private proxy configuration</html>", { status: 502 });
    await assert.rejects(fetchJson("/api/sessions"), /Request failed \(502\)/);
    globalThis.fetch = async () => Response.json({ error: "The bot is offline." }, { status: 503 });
    await assert.rejects(fetchJson("/api/sessions"), /The bot is offline/);
    globalThis.fetch = async () => Response.json({ error: { code: "NOT_FOUND", message: "Bot session was not found" } }, { status: 404 });
    await assert.rejects(fetchJson("/api/sessions"), /Bot session was not found/);
  } finally { globalThis.fetch = previous; }
});

test("lost admission acknowledgement keeps a retryable original user turn until canonical history confirms it", () => {
  const oldUser = { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "old" }] };
  const optimistic = { id: "u2", role: "user" as const, parts: [{ type: "text" as const, text: "new" }] };
  const pending = { message: optimistic, userCountBefore: 1, runIdBefore: "r1" };
  assert.equal(submissionInHistory(pending, [oldUser], { runId: "r1", sessionId: "s1", status: "completed" }), false);
  assert.equal(submissionInHistory(pending, [oldUser], { runId: "r2", sessionId: "s1", status: "queued" }), true);
  assert.equal(submissionInHistory(pending, [oldUser, { ...optimistic, id: "canonical-user-2" }]), true);
});
