import assert from "node:assert/strict";
import { test } from "node:test";
import { BotAdapterError } from "@nothumanwork/bot-ai-sdk";
import { assertSameOrigin, canonicalRequest, HttpError, noStoreJson, requireId, route } from "../lib/http";

test("mutations permit same-origin and trusted origin-less clients", () => {
  for (const headers of [{ origin: "http://[::1]:3001" }, {}] as HeadersInit[]) {
    assert.doesNotThrow(() => assertSameOrigin(new Request("http://[::1]:3001/api/chat", { method: "POST", headers })));
  }
});
test("mutations reject foreign/null origins, different ports and cross-site fetches", () => {
  for (const headers of [{ origin: "https://evil.invalid" }, { origin: "null" }, { origin: "http://[::1]:3000" }, { "sec-fetch-site": "cross-site" }] as HeadersInit[]) {
    assert.throws(() => assertSameOrigin(new Request("http://[::1]:3001/api/chat", { method: "POST", headers })), (error: unknown) => error instanceof HttpError && error.status === 403);
  }
});
test("Next-normalized loopback URLs retain the browser authority, body and Origin", async () => {
  const request = new Request("http://localhost:3001/api/chat?sessionId=dconv%3A8", { method: "POST", headers: { host: "[::1]:3001", origin: "http://[::1]:3001", "content-type": "application/json" }, body: JSON.stringify({ message: "hello" }) });
  const canonical = canonicalRequest(request);
  assert.equal(new URL(canonical.url).origin, "http://[::1]:3001");
  assert.equal(canonical.headers.get("origin"), "http://[::1]:3001");
  assert.deepEqual(await canonical.json(), { message: "hello" });
});
test("unknown hosts and DNS rebinding cannot read the local API; external origins require explicit configuration", () => {
  assert.throws(() => assertSameOrigin(new Request("http://localhost:3001/api/info", { headers: { host: "attacker.invalid:3001", origin: "http://attacker.invalid:3001" } })), HttpError);
  assert.throws(() => assertSameOrigin(new Request("http://attacker.invalid/api/info")), HttpError);
  assert.throws(() => assertSameOrigin(new Request("http://localhost:3001/api/info", { headers: { host: "attacker.invalid" } }), "https://bot.example"), HttpError);
  assert.doesNotThrow(() => assertSameOrigin(new Request("http://localhost:3001/api/chat", { headers: { origin: "https://bot.example" } }), "https://bot.example"));
  assert.throws(() => assertSameOrigin(new Request("http://localhost:3001/api/chat", { headers: { origin: "https://attacker.invalid" } }), "https://bot.example"), HttpError);
});

test("IDs cannot select paths, injected URLs or empty sessions", () => {
  for (const id of [null, "", "../etc", "foo/bar", "foo\\bar", "https://evil.invalid", "a b", "a".repeat(201)]) {
    assert.throws(() => requireId(id), HttpError);
  }
  assert.equal(requireId("session_abc-12.3"), "session_abc-12.3");
});
test("route errors never disclose credentials, backend addresses or exception bodies", async () => {
  const result = await route(async () => { throw new Error("Bearer TOP_SECRET http://private.invalid/path"); });
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await result.text(), /TOP_SECRET|private\.invalid/);
  const invalid = await route(async () => { throw new HttpError(400, "Invalid session ID."); });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "Invalid session ID." });
  assert.equal(noStoreJson({ ok: true }).headers.get("cache-control"), "no-store");
});

test("only typed adapter errors retain their safe status and message", async () => {
  const response = await route(async () => { throw new BotAdapterError(404, "NOT_FOUND", "Bot session was not found"); });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Bot session was not found" });
});
