import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import type { Options, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { claudeUsageEnvironment, fetchClaudeCodeUsage, type StartUsageSession } from "../src/providers/claude-code.ts";

const method = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const report = (): SDKControlGetUsageResponse => ({
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max", rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 17, resets_at: null }, seven_day: { utilization: 60, resets_at: null }, model_scoped: [{ display_name: "Fable", utilization: 33, resets_at: null }] },
  behaviors: null,
});
const account = { apiProvider: "firstParty" as const, email: "code@example.test", subscriptionType: "max" };

test("SDK gets account + usage with no prompt, tools, persisted session, or transcript scan", async () => {
  let opts!: Options;
  let closed = 0;
  let next!: Promise<IteratorResult<unknown>>;
  const start: StartUsageSession = ({ prompt, options }) => {
    opts = options;
    next = prompt[Symbol.asyncIterator]().next();
    return {
      accountInfo: async () => account,
      [method]: async (args) => { assert.deepEqual(args, { skipBehaviors: true }); return report(); },
      close: () => { closed++; },
    };
  };
  const snapshot = await fetchClaudeCodeUsage(new AbortController().signal, {
    start, env: { HOME: "/test/home", CLAUDE_CONFIG_DIR: "/test/claude-config", ANTHROPIC_API_KEY: "secret", ANTHROPIC_BASE_URL: "https://gateway.test" }, now: () => 1234,
  });
  assert.equal(snapshot.account, "code@example.test");
  assert.equal(snapshot.plan, "max");
  assert.match(snapshot.source, /pi-claude-bridge/);
  assert.equal(snapshot.fetchedAt, 1234);
  assert.equal(snapshot.groups[0].windows[2].remainingPercent, 67);
  assert.equal(closed, 1);
  assert.deepEqual(await next, { value: undefined, done: true }, "input stream never yielded a user message");
  assert.equal(opts.persistSession, false);
  assert.deepEqual(opts.settingSources, []);
  assert.deepEqual(opts.tools, []);
  assert.deepEqual(opts.mcpServers, {});
  assert.equal(opts.strictMcpConfig, true);
  assert.equal(opts.permissionMode, "dontAsk");
  assert.deepEqual(opts.settings, { disableAllHooks: true, autoMemoryEnabled: false });
  assert.equal(opts.env?.CLAUDE_CONFIG_DIR, "/test/claude-config");
  assert.equal(opts.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(opts.env?.ANTHROPIC_BASE_URL, undefined);
  assert.equal(opts.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
  await assert.rejects(access(opts.cwd!), { code: "ENOENT" });
});

test("subscription-only environment preserves config directory and explicit OAuth without mutation", () => {
  const env = { CLAUDE_CONFIG_DIR: "/a b", CLAUDE_CODE_OAUTH_TOKEN: "explicit-oauth", ANTHROPIC_AUTH_TOKEN: "api-auth", ANTHROPIC_PROFILE: "profile", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/bin" };
  const result = claudeUsageEnvironment(env);
  assert.equal(result.CLAUDE_CONFIG_DIR, "/a b");
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, "explicit-oauth");
  assert.equal(result.PATH, "/bin");
  assert.equal(result.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(result.ANTHROPIC_PROFILE, undefined);
  assert.equal(result.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "api-auth");
});

test("SDK failures close the child, remove its isolated cwd and redact errors", async () => {
  let closed = 0;
  let cwd!: string;
  const start: StartUsageSession = (params) => {
    cwd = params.options.cwd!;
    return { accountInfo: async () => account, [method]: async () => { throw new Error("secret bearer token"); }, close() { closed++; } };
  };
  await assert.rejects(fetchClaudeCodeUsage(new AbortController().signal, { start }), (error: Error) => {
    assert.match(error.message, /Claude Agent SDK/);
    assert.doesNotMatch(error.message, /secret bearer/);
    return true;
  });
  assert.equal(closed, 1);
  await assert.rejects(access(cwd), { code: "ENOENT" });
});

test("SDK unavailable or null limits are not displayed as zero usage", async () => {
  for (const data of [{ ...report(), rate_limits_available: false, rate_limits: null }, { ...report(), rate_limits: null }]) {
    let closed = false;
    const start: StartUsageSession = () => ({ accountInfo: async () => account, [method]: async () => data, close() { closed = true; } });
    await assert.rejects(fetchClaudeCodeUsage(new AbortController().signal, { start }), /subscription|limits/);
    assert.equal(closed, true);
  }
});

test("third-party backend never claims Claude subscription usage", async () => {
  const start: StartUsageSession = () => ({
    accountInfo: async () => ({ apiProvider: "bedrock" }),
    [method]: async () => { assert.fail("must not query plan"); }, close() {},
  });
  await assert.rejects(fetchClaudeCodeUsage(new AbortController().signal, { start }), /not using a Claude subscription/);
});

test("cancellation terminates the SDK process and never returns late quota data", async () => {
  const controller = new AbortController();
  let closed = 0;
  let reject!: (reason: unknown) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const start: StartUsageSession = () => ({
    accountInfo: async () => account,
    [method]: () => { ready(); return new Promise((_, no) => { reject = no; }); },
    close() { closed++; reject(new Error("secret interrupted response")); },
  });
  const task = fetchClaudeCodeUsage(controller.signal, { start });
  await started;
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
  assert.equal(closed, 1);
});

test("already cancelled SDK usage does not spawn", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchClaudeCodeUsage(controller.signal, { start: () => { assert.fail("no spawn"); } }), { name: "AbortError" });
});
