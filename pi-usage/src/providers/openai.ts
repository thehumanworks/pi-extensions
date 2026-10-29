import { decodeJwt } from "jose";
import OpenAI from "openai";
import { z } from "zod";
import { UsageError, type AuthRegistry, type UsageGroup, type UsageProvider, type UsageSnapshot, type UsageWindow } from "../types.ts";

export const CODEX_PROVIDER = "openai-codex";
export const USAGE_BASE_URL = "https://chatgpt.com/backend-api";
export const LOGIN_HINT = "Run /login openai-codex and choose the same ChatGPT account as your OpenAI login. Your inference login is unchanged.";

const nonnegative = z.number().finite().nonnegative();
const timestamp = nonnegative.max(8_640_000_000_000);
const windowSchema = z.object({
  used_percent: nonnegative.nullish(),
  limit_window_seconds: nonnegative.nullish(),
  reset_at: timestamp.nullish(),
  reset_after_seconds: nonnegative.nullish(),
});
const limitSchema = z.object({
  allowed: z.boolean().nullish(),
  limit_reached: z.boolean().nullish(),
  primary_window: windowSchema.nullish(),
  secondary_window: windowSchema.nullish(),
});

// Codex's backend-client/OpenAPI models are the wire-contract reference. This is
// an internal endpoint, not the public OpenAI organization/billing usage API.
// Unknown fields are ignored; missing/null quotas stay unknown, never 0% used.
const payloadSchema = z.object({
  plan_type: z.string().min(1),
  account_id: z.string().nullish(),
  email: z.string().nullish(),
  rate_limit: limitSchema.nullish(),
  code_review_rate_limit: limitSchema.nullish(),
  additional_rate_limits: z.array(z.object({
    limit_name: z.string(),
    metered_feature: z.string(),
    rate_limit: limitSchema.nullish(),
  })).nullish(),
  credits: z.object({
    has_credits: z.boolean().nullish(),
    unlimited: z.boolean().nullish(),
    balance: z.string().nullish(),
    overage_limit_reached: z.boolean().nullish(),
  }).nullish(),
  spend_control: z.object({ reached: z.boolean().nullish() }).nullish(),
});

export interface CodexAccount { accessToken: string; accountId: string; email?: string }

/** Decode only for account routing/display; OpenAI validates the token itself. */
export function accountFromToken(accessToken: string): CodexAccount | undefined {
  try {
    const claims = decodeJwt(accessToken);
    const auth = z.object({ chatgpt_account_id: z.string().regex(/^[\w-]+$/) })
      .safeParse(claims["https://api.openai.com/auth"]);
    if (!auth.success) return undefined;
    const profile = z.object({ email: z.string().optional() })
      .safeParse(claims["https://api.openai.com/profile"]);
    return {
      accessToken,
      accountId: auth.data.chatgpt_account_id,
      email: profile.success ? profile.data.email : undefined,
    };
  } catch { return undefined; }
}

export async function getCodexAccount(registry: AuthRegistry): Promise<CodexAccount> {
  if (!registry.getProvider(CODEX_PROVIDER)) {
    throw new UsageError(`This Pi build has no Codex login provider. ${LOGIN_HINT}`, "unavailable");
  }
  let result;
  try { result = await registry.getProviderAuth(CODEX_PROVIDER); }
  catch { throw new UsageError(`Could not refresh the Codex login. ${LOGIN_HINT}`); }
  // Do not use API keys, the new SIWC token, ~/.codex/auth.json, or browser cookies.
  if (result?.source !== "OAuth" || !result.auth.apiKey) {
    throw new UsageError(`A Codex ChatGPT login is needed to read account limits. ${LOGIN_HINT}`, "unavailable");
  }
  const account = accountFromToken(result.auth.apiKey);
  if (!account) throw new UsageError(`The Codex login has no usable ChatGPT account. ${LOGIN_HINT}`);
  return account;
}

export function windowLabel(seconds: number | null | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (seconds === 604800) return "Weekly limit";
  if (seconds % 86400 === 0) return `${seconds / 86400} day limit`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour limit`;
  if (seconds % 60 === 0) return `${seconds / 60} minute limit`;
  return `${seconds} second limit`;
}

function normalizeWindow(window: z.infer<typeof windowSchema>, fallback: string, now: number): UsageWindow {
  const reset = window.reset_at != null ? window.reset_at * 1000
    : window.reset_after_seconds != null ? now + window.reset_after_seconds * 1000 : undefined;
  return {
    label: windowLabel(window.limit_window_seconds, fallback),
    remainingPercent: window.used_percent == null ? undefined : Math.max(0, 100 - window.used_percent),
    resetsAt: reset !== undefined && Number.isFinite(reset) && reset <= 8_640_000_000_000_000 ? reset : undefined,
  };
}

function normalizeGroup(label: string, limit: z.infer<typeof limitSchema>, now: number): UsageGroup {
  const windows: UsageWindow[] = [];
  if (limit.primary_window) windows.push(normalizeWindow(limit.primary_window, "Primary limit", now));
  if (limit.secondary_window) windows.push(normalizeWindow(limit.secondary_window, "Secondary limit", now));
  return { label, windows, limitReached: limit.limit_reached === true || limit.allowed === false };
}

export function normalizeUsage(payload: unknown, account: CodexAccount, now = Date.now()): UsageSnapshot {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new UsageError("OpenAI returned an unrecognized usage response. Check the usage dashboard; the Codex endpoint may have changed.");
  const data = parsed.data;
  if (data.account_id && data.account_id !== account.accountId) {
    throw new UsageError("OpenAI returned usage for a different account. No usage is displayed; check your Codex login.");
  }
  const groups: UsageGroup[] = [];
  if (data.rate_limit) groups.push(normalizeGroup("Account allowance", data.rate_limit, now));
  for (const extra of data.additional_rate_limits ?? []) {
    if (extra.rate_limit) groups.push(normalizeGroup(extra.limit_name || extra.metered_feature, extra.rate_limit, now));
  }
  if (data.code_review_rate_limit) groups.push(normalizeGroup("Code review", data.code_review_rate_limit, now));
  const email = data.email || account.email;
  const notes = ["Account allowance via Codex; Pi-specific app caps are not included."];
  if (data.spend_control?.reached) notes.push("An account/workspace spending limit has been reached.");
  if (data.credits?.overage_limit_reached) notes.push("The credit overage limit has been reached.");
  return {
    account: email ? `${email} (${account.accountId})` : account.accountId,
    plan: data.plan_type,
    source: "Codex login (openai-codex)",
    fetchedAt: now,
    groups,
    credits: data.credits ? {
      unlimited: data.credits.unlimited ?? undefined,
      hasCredits: data.credits.has_credits ?? undefined,
      balance: data.credits.balance ?? undefined,
    } : undefined,
    notes,
  };
}

export function createOpenAIProvider(options: { fetch?: typeof globalThis.fetch; now?: () => number } = {}): UsageProvider {
  return {
    id: "openai",
    label: "OpenAI · ChatGPT",
    dashboardUrl: "https://chatgpt.com/settings/usage",
    async fetch({ registry, signal }) {
      const account = await getCodexAccount(registry);
      signal.throwIfAborted();
      const client = new OpenAI({
        apiKey: account.accessToken,
        baseURL: USAGE_BASE_URL,
        // Never pick up OPENAI_ORG_ID/PROJECT_ID or log credentials/response bodies.
        organization: null,
        project: null,
        logLevel: "off",
        maxRetries: 0,
        timeout: 12_000,
        fetch: options.fetch,
        fetchOptions: { redirect: "error" },
        defaultHeaders: { "ChatGPT-Account-Id": account.accountId },
      });
      let payload: unknown;
      try {
        // The official SDK's generic request API handles transport and cancellation.
        // There is no generated quota method in the JavaScript SDK.
        payload = await client.get<unknown>("/wham/usage", { signal });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof OpenAI.APIError) {
          if (error.status === 401) throw new UsageError(`The Codex login was rejected. ${LOGIN_HINT}`);
          if (error.status === 403) throw new UsageError("OpenAI denied access to Codex usage. Check the account and usage dashboard.");
          if (error.status === 429) throw new UsageError("OpenAI throttled the usage check. Try again later; this does not mean your plan allowance is empty.");
          if (error.status && error.status >= 500) throw new UsageError("OpenAI usage is temporarily unavailable. Try again later.");
        }
        if (error instanceof OpenAI.APIConnectionTimeoutError) throw new UsageError("OpenAI usage request timed out. Try again.");
        throw new UsageError("Could not retrieve OpenAI usage. Check your connection or the usage dashboard.");
      }
      return normalizeUsage(payload, account, options.now?.() ?? Date.now());
    },
  };
}
