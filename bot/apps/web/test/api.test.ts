import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotChatAdapter } from "@nothumanwork/bot-ai-sdk";
import { createApiHandler } from "../lib/api";

function fixture() {
  const calls: unknown[][] = [];
  const adapter: BotChatAdapter = {
    info: async () => ({ name: "test", description: "offline", revision: "1", tools: [], skills: [] }),
    sessions: async () => [],
    history: async id => { calls.push(["history", id]); return { session: { sessionId: id, cwd: "", createdAt: "", updatedAt: "" }, messages: [] }; },
    cancel: async id => { calls.push(["cancel", id]); },
    chat: async req => { calls.push(["chat", req.url, await req.text()]); return new Response("stream"); },
    resume: async (req, session, run) => { calls.push(["resume", req.url, session, run]); return new Response("stream"); },
  };
  return { calls, handle: createApiHandler(() => adapter) };
}
const request = (path: string, init?: RequestInit) => new Request(`http://[::1]:3001${path}`, init);

test("shared router dispatches read, submit, resume and explicit cancellation", async () => {
  const { calls, handle } = fixture();
  assert.equal((await handle(request("/api/info"))).status, 200);
  assert.deepEqual(await (await handle(request("/api/sessions"))).json(), { sessions: [] });
  assert.equal((await handle(request("/api/sessions/s:1"))).status, 200);
  assert.equal((await handle(request("/api/chat?sessionId=s:1&runId=r-1"))).status, 200);
  assert.equal((await handle(request("/api/chat", { method: "POST", body: "body", headers: { host: "[::1]:3001" } }))).status, 200);
  assert.equal((await handle(request("/api/runs/r-1/cancel", { method: "POST" }))).status, 200);
  assert.deepEqual(calls, [["history", "s:1"], ["resume", "http://[::1]:3001/api/chat?sessionId=s:1&runId=r-1", "s:1", "r-1"], ["chat", "http://[::1]:3001/api/chat", "body"], ["cancel", "r-1"]]);
});

test("router rejects unknown paths, unsupported methods and invalid IDs without backend access", async () => {
  const { calls, handle } = fixture();
  for (const path of ["/api/unknown", "/api/sessions/a%2Fb"]) assert.equal((await handle(request(path))).status, 404);
  const unsupported = await handle(request("/api/info", { method: "POST" }));
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("allow"), "GET");
  for (const path of ["/api/chat", "/api/chat?sessionId=a%20b", "/api/chat?sessionId=s&runId=", "/api/sessions/%00", "/api/runs/a%20b/cancel", "/api/%zz"]) {
    assert.equal((await handle(request(path, path.includes("cancel") ? { method: "POST" } : undefined))).status, 400);
  }
  assert.deepEqual(calls, []);
});

test("guards cover all API paths and sanitize untyped exceptions", async () => {
  const { handle } = fixture();
  for (const path of ["/api/info", "/api/unknown"]) {
    for (const headers of [{ host: "evil.invalid" }, { origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }] as HeadersInit[]) {
      assert.equal((await handle(request(path, { headers }))).status, 403);
    }
  }
  const broken = createApiHandler(() => { throw new Error("TOKEN private.invalid"); });
  const result = await broken(request("/api/info"));
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await result.text(), /TOKEN|private\.invalid/);
});
