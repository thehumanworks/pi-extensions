import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeClaudeUsage } from "../src/providers/claude-normalize.ts";
import { createClaudeProvider } from "../src/providers/claude.ts";
import { formatUsage } from "../src/format.ts";
import type { AuthRegistry, UsageSnapshot } from "../src/types.ts";

const now = Date.UTC(2026, 9, 29, 19, 18);
const identity = { account: "person@example.test", plan: "max", source: "Claude Code login" };
const session = { utilization: 17, resets_at: "2026-10-29T19:20:00.069312+00:00" };
const weekly = { utilization: 60, resets_at: "2026-10-31T08:00:00.069330+00:00" };
const fable = { utilization: 33, resets_at: "2026-10-31T08:00:00.069476+00:00" };
const sdkPayload = () => ({ five_hour: session, seven_day: weekly, model_scoped: [{ display_name: "Fable", ...fable }] });
const nativePayload = () => ({
  five_hour: session, seven_day: weekly,
  limits: [
    { kind: "session", percent: 17, resets_at: session.resets_at, scope: null },
    { kind: "weekly_all", percent: 60, resets_at: weekly.resets_at, scope: null },
    { kind: "weekly_scoped", percent: 33, resets_at: fable.resets_at, scope: { model: { display_name: "Fable" }, surface: null }, is_active: false },
  ],
});
const noAuth: AuthRegistry = { getProvider: () => undefined, getProviderAuth: async () => undefined };
const oauthRegistry = (resolve: AuthRegistry["getProviderAuth"] = async () => ({ source: "OAuth", auth: { apiKey: "test-oauth-secret" } })): AuthRegistry => ({
  getProvider: () => ({ id: "anthropic" }) as ReturnType<AuthRegistry["getProvider"]>,
  getProviderAuth: resolve,
});
const signal = () => new AbortController().signal;

test("SDK snapshot matches the screenshot: 17% session, 60% all models, 33% Fable used", () => {
  const snapshot = normalizeClaudeUsage(sdkPayload(), identity, now);
  assert.deepEqual(snapshot.groups[0].windows.map((window) => [window.label, window.remainingPercent, window.display]), [
    ["Current session (5h)", 83, "used"], ["Current week (all models)", 40, "used"], ["Current week (Fable)", 67, "used"],
  ]);
  assert.equal(snapshot.groups[0].windows[0].resetsAt, Date.UTC(2026, 9, 29, 19, 20, 0, 69));
  assert.equal(snapshot.groups[0].windows[2].resetsAt, Date.UTC(2026, 9, 31, 8, 0, 0, 69));
  const text = formatUsage([{ provider: { id: "claude", label: "Claude", dashboardUrl: "https://claude.ai/settings/usage" }, status: "ok", snapshot }], now);
  assert.match(text, /Current session \(5h\): \[█{3}░{17}\] 17% used/);
  assert.match(text, /60% used/);
  assert.match(text, /33% used/);
  assert.doesNotMatch(text, /% left/);
});

test("native usage endpoint supports both legacy windows and modern limits-only responses", () => {
  const payload = nativePayload();
  const expected = normalizeClaudeUsage(sdkPayload(), identity, now).groups;
  assert.deepEqual(normalizeClaudeUsage(payload, identity, now).groups, expected);
  assert.deepEqual(normalizeClaudeUsage({ limits: payload.limits }, identity, now).groups, expected);
});

test("per-model deduplication keeps precision and ignores app/surface caps", () => {
  const payload = nativePayload();
  const snapshot = normalizeClaudeUsage({
    ...payload,
    seven_day_sonnet: { utilization: 22.25, resets_at: weekly.resets_at },
    model_scoped: [{ display_name: "Sonnet", utilization: 22, resets_at: weekly.resets_at }],
    seven_day_oauth_apps: { utilization: 100, resets_at: weekly.resets_at },
    limits: [...payload.limits,
      { kind: "weekly_scoped", percent: 100, scope: { surface: { display_name: "Pi" } } },
      { kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Fable" }, surface: { display_name: "Pi" } } },
    ],
  }, identity, now);
  assert.equal(snapshot.groups[0].windows.length, 4);
  assert.equal(snapshot.groups[0].windows[2].remainingPercent, 67);
  assert.equal(snapshot.groups[0].windows[3].remainingPercent, 77.75);
  assert.equal(snapshot.groups[0].limitReached, false);
});

test("missing/null windows remain unknown; malformed timestamps never imply reset", () => {
  const snapshot = normalizeClaudeUsage({ five_hour: null, seven_day: { utilization: null, resets_at: "not-a-date" }, model_scoped: [] }, identity, now);
  assert.equal(snapshot.groups[0].windows.length, 3);
  for (const window of snapshot.groups[0].windows) {
    assert.equal(window.remainingPercent, undefined);
    assert.equal(window.resetsAt, undefined);
  }
  const over = normalizeClaudeUsage({ five_hour: { utilization: 105, resets_at: null } }, identity, now);
  assert.equal(over.groups[0].windows[0].remainingPercent, 0);
  assert.equal(over.groups[0].limitReached, true);
});

test("malformed payloads and negative/non-numeric percentages fail closed", () => {
  for (const payload of [{}, null, { error: "secret" }, { five_hour: { utilization: -1 } }, { limits: [{ kind: "session", percent: "17" }] }]) {
    assert.throws(() => normalizeClaudeUsage(payload, identity, now), /unrecognized usage/);
  }
});

test("native Pi uses refreshed Anthropic OAuth through official SDK; no API key or redirects", async () => {
  const requests: string[] = [];
  const provider = createClaudeProvider({
    now: () => now,
    readCodeUsage: async () => { assert.fail("must not use another account"); },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-oauth-secret");
      assert.equal(headers.get("x-api-key"), null);
      assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
      assert.equal(init?.redirect, "error");
      return Response.json(url.endsWith("/profile") ? { account: { email: "native@example.test" } } : nativePayload());
    },
  });
  const snapshot = await provider.fetch({ registry: oauthRegistry(async (id) => {
    assert.equal(id, "anthropic");
    return { source: "OAuth", auth: { apiKey: "test-oauth-secret" } };
  }), signal: signal() });
  assert.deepEqual(requests, ["https://api.anthropic.com/api/oauth/usage", "https://api.anthropic.com/api/oauth/profile"]);
  assert.equal(snapshot.account, "native@example.test");
  assert.equal(snapshot.source, "Pi Anthropic OAuth login");
  assert.equal(snapshot.groups[0].windows[2].remainingPercent, 67);
  assert.ok(!JSON.stringify(snapshot).includes("test-oauth-secret"));
});

test("profile lookup is optional and cannot hide a successful quota response", async () => {
  const provider = createClaudeProvider({ fetch: async (url) => String(url).endsWith("/profile") ? new Response("secret", { status: 403 }) : Response.json(nativePayload()) });
  const snapshot = await provider.fetch({ registry: oauthRegistry(), signal: signal() });
  assert.match(snapshot.account, /identity not reported/);
  assert.equal(snapshot.groups[0].windows[0].remainingPercent, 83);
});

test("missing Pi auth or API-key auth falls back to Claude Code without using the key", async () => {
  const expected = normalizeClaudeUsage(sdkPayload(), identity, now);
  let sdkCalls = 0;
  const provider = createClaudeProvider({
    readCodeUsage: async () => { sdkCalls++; return expected; },
    fetch: async () => { assert.fail("must not send API key"); },
  });
  for (const registry of [noAuth, oauthRegistry(async () => undefined), oauthRegistry(async () => ({ source: "ANTHROPIC_API_KEY", auth: { apiKey: "sk-test" } }))]) {
    assert.equal(await provider.fetch({ registry, signal: signal() }), expected);
  }
  assert.equal(sdkCalls, 3);
});

test("active bridge takes precedence over a different native Pi account", async () => {
  const expected = normalizeClaudeUsage(sdkPayload(), identity, now);
  const provider = createClaudeProvider({ readCodeUsage: async () => expected });
  const registry = oauthRegistry(async () => { assert.fail("bridge must not read native auth"); });
  assert.equal(await provider.fetch({ registry, signal: signal(), activeProvider: "claude-bridge" }), expected);
});

test("selected native auth failure never silently switches to Claude Code or exposes secrets", async () => {
  const provider = createClaudeProvider({ readCodeUsage: async () => { assert.fail("no account switching"); } });
  await assert.rejects(provider.fetch({ registry: oauthRegistry(async () => { throw new Error("secret refresh token"); }), signal: signal() }), (error: Error) => {
    assert.match(error.message, /Could not refresh/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

for (const [status, expected] of [[401, /login anthropic/], [403, /profile permission/], [429, /does not mean.*empty/], [500, /temporarily unavailable/]] as const) {
  test(`native HTTP ${status} is safe and not retried/fallen back`, async () => {
    let calls = 0;
    const provider = createClaudeProvider({ readCodeUsage: async () => { assert.fail("no account switching"); }, fetch: async () => {
      calls++;
      return Response.json({ error: { message: "secret body" } }, { status });
    } });
    await assert.rejects(provider.fetch({ registry: oauthRegistry(), signal: signal() }), (error: Error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /secret body/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("already cancelled reads do not resolve auth or launch Claude Code", async () => {
  const controller = new AbortController(); controller.abort();
  const provider = createClaudeProvider({ readCodeUsage: async (): Promise<UsageSnapshot> => { assert.fail("must not launch"); } });
  await assert.rejects(provider.fetch({ registry: oauthRegistry(async () => { assert.fail("must not resolve"); }), signal: controller.signal }), { name: "AbortError" });
});
