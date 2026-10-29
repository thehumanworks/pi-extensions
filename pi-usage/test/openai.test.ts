import assert from "node:assert/strict";
import { test } from "node:test";
import { accountFromToken, createOpenAIProvider, getCodexAccount, normalizeUsage, USAGE_BASE_URL, windowLabel } from "../src/providers/openai.ts";
import type { AuthRegistry } from "../src/types.ts";

function token(claims: unknown): string {
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}
const accessToken = token({
  "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
  "https://api.openai.com/profile": { email: "user@example.test" },
});
const account = accountFromToken(accessToken)!;
const now = Date.UTC(2026, 9, 29, 12);
const window = (used = 25, seconds = 18000) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: now / 1000 + 3600, reset_after_seconds: 3600 });
const payload = () => ({ plan_type: "plus", account_id: "account-123", rate_limit: {
  allowed: true, limit_reached: false, primary_window: window(), secondary_window: window(60, 604800),
}, credits: { has_credits: true, unlimited: false, balance: "12.5" } });
function registry(resolve: AuthRegistry["getProviderAuth"] = async () => ({ source: "OAuth", auth: { apiKey: accessToken } })): AuthRegistry {
  return { getProvider: () => ({ id: "openai-codex" }) as ReturnType<AuthRegistry["getProvider"]>, getProviderAuth: resolve };
}

test("resolves only Pi's Codex OAuth auth; refresh stays owned by Pi", async () => {
  const calls: string[] = [];
  const result = await getCodexAccount(registry(async (id) => {
    calls.push(id);
    return { source: "OAuth", auth: { apiKey: accessToken } };
  }));
  assert.deepEqual(calls, ["openai-codex"]);
  assert.deepEqual(result, { accountId: "account-123", accessToken, email: "user@example.test" });
});

test("rejects missing provider, API keys, missing OAuth and invalid account claims", async () => {
  await assert.rejects(getCodexAccount({ getProvider: () => undefined, getProviderAuth: async () => { throw new Error("must not resolve"); } }), /no Codex login provider/);
  for (const auth of [undefined, { source: "OPENAI_API_KEY", auth: { apiKey: "sk-test" } }, { source: "OAuth", auth: { apiKey: "not-a-jwt" } }]) {
    await assert.rejects(getCodexAccount(registry(async () => auth)), /Codex|ChatGPT account/);
  }
  for (const value of ["not-a-jwt", token({}), token({ "https://api.openai.com/auth": { chatgpt_account_id: "bad\r\nheader" } })]) {
    assert.equal(accountFromToken(value), undefined);
  }
});

test("auth refresh errors never expose their body or token", async () => {
  await assert.rejects(getCodexAccount(registry(async () => { throw new Error(`secret ${accessToken}`); })), (error: Error) => {
    assert.match(error.message, /Could not refresh/);
    assert.ok(!error.message.includes(accessToken));
    return true;
  });
});

test("normalizes Codex percentages, reset times, plan, account and credits", () => {
  const result = normalizeUsage(payload(), account, now);
  assert.equal(result.plan, "plus");
  assert.equal(result.account, "user@example.test (account-123)");
  assert.equal(result.fetchedAt, now);
  assert.deepEqual(result.groups[0].windows, [
    { label: "5 hour limit", remainingPercent: 75, resetsAt: now + 3600_000 },
    { label: "Weekly limit", remainingPercent: 40, resetsAt: now + 3600_000 },
  ]);
  assert.deepEqual(result.credits, { hasCredits: true, unlimited: false, balance: "12.5" });
  assert.ok(!JSON.stringify(result).includes(accessToken));
});

test("window labels follow the returned duration, not primary/secondary positions", () => {
  const result = normalizeUsage({ plan_type: "pro", rate_limit: { primary_window: window(20, 604800), secondary_window: null } }, account, now);
  assert.equal(result.groups[0].windows[0].label, "Weekly limit");
  assert.equal(result.groups[0].windows.length, 1);
  assert.equal(windowLabel(7200, "x"), "2 hour limit");
  assert.equal(windowLabel(172800, "x"), "2 day limit");
  assert.equal(windowLabel(90, "x"), "90 second limit");
  assert.equal(windowLabel(300, "x"), "5 minute limit");
  assert.equal(windowLabel(undefined, "Primary limit"), "Primary limit");
});

test("handles null/missing windows and percentages without manufacturing allowance", () => {
  assert.deepEqual(normalizeUsage({ plan_type: "pro", rate_limit: null, credits: null }, account, now).groups, []);
  const result = normalizeUsage({ plan_type: "pro", rate_limit: { primary_window: { used_percent: null, reset_after_seconds: 100 } } }, account, now);
  assert.equal(result.groups[0].windows[0].remainingPercent, undefined);
  assert.equal(result.groups[0].windows[0].resetsAt, now + 100000);
  const over = normalizeUsage({ plan_type: "plus", rate_limit: { primary_window: window(120) } }, account, now);
  assert.equal(over.groups[0].windows[0].remainingPercent, 0);
});

test("extra/model and code review limits, restrictions and unlimited credits are preserved", () => {
  const result = normalizeUsage({
    plan_type: "promax", rate_limit: { allowed: false, primary_window: window(100) },
    additional_rate_limits: [{ limit_name: "Spark", metered_feature: "codex-spark", rate_limit: { secondary_window: window(10, 604800) } }],
    code_review_rate_limit: { primary_window: window(5, 604800) },
    credits: { has_credits: true, unlimited: true, overage_limit_reached: true },
    spend_control: { reached: true }, ignored_future_field: { x: 1 },
  }, account, now);
  assert.deepEqual(result.groups.map((g) => g.label), ["Account allowance", "Spark", "Code review"]);
  assert.equal(result.groups[0].limitReached, true);
  assert.equal(result.credits?.unlimited, true);
  assert.equal(result.notes.length, 3);
});

test("rejects malformed payloads and mismatched accounts instead of displaying false totals", () => {
  for (const data of [{}, { error: "secret" }, { ...payload(), rate_limit: { primary_window: { used_percent: "20" } } }, { ...payload(), rate_limit: { primary_window: { used_percent: -1 } } }]) {
    assert.throws(() => normalizeUsage(data, account, now), /unrecognized usage/);
  }
  assert.throws(() => normalizeUsage({ ...payload(), account_id: "other" }, account), /different account/);
});

test("SDK transport sends only Codex auth to the fixed usage endpoint with redirects disabled", async () => {
  let calls = 0;
  const provider = createOpenAIProvider({ now: () => now, fetch: async (input, init) => {
    calls++;
    assert.equal(String(input), `${USAGE_BASE_URL}/wham/usage`);
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${accessToken}`);
    assert.equal(headers.get("ChatGPT-Account-Id"), "account-123");
    assert.equal(headers.get("OpenAI-Organization"), null);
    assert.equal(headers.get("OpenAI-Project"), null);
    assert.equal(init?.redirect, "error");
    return Response.json(payload());
  } });
  const result = await provider.fetch({ registry: registry(), signal: new AbortController().signal });
  assert.equal(calls, 1);
  assert.equal(result.groups[0].windows[0].remainingPercent, 75);
});

for (const [status, expected] of [[401, /login openai-codex/], [403, /denied/], [429, /does not mean.*empty/], [503, /temporarily unavailable/], [404, /Could not retrieve/]] as const) {
  test(`HTTP ${status} is safe, actionable, and not retried`, async () => {
    let calls = 0;
    const provider = createOpenAIProvider({ fetch: async () => {
      calls++;
      return Response.json({ error: { message: `secret ${accessToken}` } }, { status });
    } });
    await assert.rejects(provider.fetch({ registry: registry(), signal: new AbortController().signal }), (error: Error) => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(accessToken));
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("non-JSON and malformed JSON responses fail without body disclosure", async () => {
  for (const response of [new Response("<html>secret</html>", { headers: { "Content-Type": "text/html" } }), new Response("{secret", { headers: { "Content-Type": "application/json" } })]) {
    const provider = createOpenAIProvider({ fetch: async () => response });
    await assert.rejects(provider.fetch({ registry: registry(), signal: new AbortController().signal }), (error: Error) => !error.message.includes("secret"));
  }
});

test("cancellation after auth prevents a usage request", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createOpenAIProvider({ fetch: async () => { assert.fail("must not fetch"); } });
  await assert.rejects(provider.fetch({ registry: registry(), signal: controller.signal }), { name: "AbortError" });
});

test("the SDK cancels an in-flight network request", async () => {
  const controller = new AbortController();
  const provider = createOpenAIProvider({ fetch: async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    controller.abort();
  }) });
  await assert.rejects(provider.fetch({ registry: registry(), signal: controller.signal }), { name: "AbortError" });
});
