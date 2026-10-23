import assert from "node:assert/strict";
import { test } from "node:test";
import { accountIdFromToken, getVoiceAuth, voiceHeaders, type AuthRegistry } from "../src/auth.ts";

const codexToken = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_example" },
})).toString("base64url")}.signature`;
const provider = { id: "openai-codex" } as NonNullable<ReturnType<AuthRegistry["getProvider"]>>;
function registry(result: unknown, calls: string[] = []): AuthRegistry {
  return {
    getProvider: id => id === "openai-codex" ? provider : undefined,
    getProviderAuth: async id => { calls.push(id); return result as Awaited<ReturnType<AuthRegistry["getProviderAuth"]>>; },
  };
}

test("uses only the Codex OAuth login (openai-codex), the one Codex CLI voice uses", async () => {
  const calls: string[] = [];
  const auth = await getVoiceAuth(registry({ source: "OAuth", auth: { apiKey: codexToken } }, calls));
  assert.deepEqual(calls, ["openai-codex"]);
  assert.equal(auth.accessToken, codexToken);
  assert.equal(auth.accountId, "acct_example");
  const headers = voiceHeaders(auth, "pi-session", "voice-session");
  assert.equal(headers.Authorization, `Bearer ${codexToken}`);
  assert.equal(headers["OpenAI-Alpha"], "quicksilver=v2");
  assert.equal(headers["ChatGPT-Account-ID"], "acct_example");
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers["x-session-id"], "voice-session");
});

test("never falls back to the public-API ChatGPT login, API keys or environment", async () => {
  // Pi's `openai` Sign in with ChatGPT token: no account claim, rejected by the voice backend.
  const publicApiToken = `h.${Buffer.from(JSON.stringify({ scope: "chatgpt.tokens.use.direct" })).toString("base64url")}.s`;
  for (const result of [undefined, { source: "OPENAI_API_KEY", auth: { apiKey: "sk-example" } },
      { source: "OAuth", auth: {} }]) {
    await assert.rejects(getVoiceAuth(registry(result)), /\/login openai-codex/);
  }
  await assert.rejects(getVoiceAuth(registry({ source: "OAuth", auth: { apiKey: publicApiToken } })),
    /no ChatGPT account.*\/login openai-codex/);
  await assert.rejects(getVoiceAuth({ getProvider: () => undefined, getProviderAuth: async () => {
    throw new Error("must not be asked");
  } }), /no openai-codex provider/);
});

test("refresh failures are actionable and never leak provider details", async () => {
  await assert.rejects(getVoiceAuth({ ...registry(undefined), getProviderAuth: async () => { throw new Error("SECRET"); } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /refreshed.*\/login openai-codex/);
    assert.ok(!error.message.includes("SECRET"));
    return true;
  });
  assert.equal(accountIdFromToken("opaque-token"), undefined);
});
