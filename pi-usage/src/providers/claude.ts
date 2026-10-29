import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { UsageError, type AuthRegistry, type UsageProvider, type UsageSnapshot } from "../types.ts";
import { fetchClaudeCodeUsage } from "./claude-code.ts";
import { normalizeClaudeUsage } from "./claude-normalize.ts";

const BASE_URL = "https://api.anthropic.com";
const PI_LOGIN_HINT = "Run /login anthropic and choose the Claude subscription login, then retry /usage claude.";

async function piToken(registry: AuthRegistry): Promise<string | undefined> {
  if (!registry.getProvider("anthropic")) return undefined;
  let auth;
  try { auth = await registry.getProviderAuth("anthropic"); }
  catch { throw new UsageError(`Could not refresh Pi's Anthropic login. ${PI_LOGIN_HINT}`); }
  // API keys are not subscription credentials. Never resolve bridge's dummy key.
  if (auth?.source !== "OAuth") return undefined;
  if (!auth.auth.apiKey) throw new UsageError(`Pi's Anthropic OAuth login is incomplete. ${PI_LOGIN_HINT}`);
  return auth.auth.apiKey;
}

async function fetchPiUsage(token: string, signal: AbortSignal, options: { fetch?: typeof globalThis.fetch; now?: () => number }): Promise<UsageSnapshot> {
  const client = new Anthropic({
    apiKey: null,
    authToken: token,
    baseURL: BASE_URL,
    logLevel: "off",
    maxRetries: 0,
    timeout: 12_000,
    fetch: options.fetch,
    fetchOptions: { redirect: "error" },
    defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
  });
  let payload: unknown;
  try {
    // There is no generated subscription-quota method in the API SDK. Pi owns
    // OAuth storage and refresh; the official SDK owns HTTP transport.
    payload = await client.get<unknown>("/api/oauth/usage", { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Anthropic.APIError) {
      if (error.status === 401) throw new UsageError(`Pi's Anthropic login was rejected. ${PI_LOGIN_HINT}`);
      if (error.status === 403) throw new UsageError(`Claude usage needs subscription/profile permission. ${PI_LOGIN_HINT}`);
      if (error.status === 429) throw new UsageError("Claude throttled the usage check. Wait before refreshing; this does not mean your subscription allowance is empty.");
      if (error.status && error.status >= 500) throw new UsageError("Claude usage is temporarily unavailable. Try again later.");
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) throw new UsageError("Claude usage request timed out. Try again.");
    throw new UsageError("Could not retrieve Claude usage. Check your connection or the usage dashboard.");
  }
  // Identity is supplementary: a profile failure must not hide known quotas.
  // This uses the very same token, never account data from another login store.
  const profile = await client.get<unknown>("/api/oauth/profile", { signal, timeout: 2_000 }).catch(() => undefined);
  signal.throwIfAborted();
  const parsed = z.object({ account: z.object({ email: z.string().min(1) }) }).safeParse(profile);
  return normalizeClaudeUsage(payload, {
    account: parsed.success ? parsed.data.account.email : "Pi Anthropic subscription (identity not reported)",
    source: "Pi Anthropic OAuth login",
  }, options.now?.() ?? Date.now());
}

export function createClaudeProvider(options: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  readCodeUsage?: (signal: AbortSignal) => Promise<UsageSnapshot>;
} = {}): UsageProvider {
  return {
    id: "claude",
    aliases: ["anthropic"],
    label: "Anthropic · Claude",
    dashboardUrl: "https://claude.ai/settings/usage",
    async fetch({ registry, signal, activeProvider }) {
      signal.throwIfAborted();
      const readCode = options.readCodeUsage ?? ((signal) => fetchClaudeCodeUsage(signal, { now: options.now }));
      // If both accounts exist, follow the selected bridge rather than silently
      // showing a potentially different native Anthropic account. A chosen
      // source failing is an error, not permission to switch accounts.
      if (activeProvider === "claude-bridge") return readCode(signal);
      const token = await piToken(registry);
      signal.throwIfAborted();
      return token ? fetchPiUsage(token, signal, options) : readCode(signal);
    },
  };
}
