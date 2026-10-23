import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The voice backend (chatgpt.com/backend-api/codex/realtime) accepts only tokens
 * from the Codex OAuth client, the same login Codex CLI uses. In Pi that is the
 * `openai-codex` provider ("OpenAI (ChatGPT Plus/Pro)"). Pi's newer `openai`
 * Sign in with ChatGPT token targets the public API and is rejected with 401.
 */
export const PROVIDER = "openai-codex";
export const LOGIN_HINT = `Run /login ${PROVIDER} (OpenAI ChatGPT Plus/Pro, the Codex login).`;
export interface VoiceAuth { accessToken: string; accountId: string }
export type AuthRegistry = Pick<ExtensionContext["modelRegistry"], "getProviderAuth" | "getProvider">;

/** Resolve through Pi so refresh/rotating-token locking remain owned by the host. */
export async function getVoiceAuth(registry: AuthRegistry): Promise<VoiceAuth> {
  if (!registry.getProvider(PROVIDER)) {
    throw new Error(`This Pi build has no ${PROVIDER} provider, which voice requires for Codex login.`);
  }
  let result;
  try { result = await registry.getProviderAuth(PROVIDER); }
  catch { throw new Error(`Codex login could not be refreshed. ${LOGIN_HINT}`); }
  // An API key, environment variable, or a different provider's login is NEVER a fallback.
  if (result?.source !== "OAuth" || !result.auth.apiKey) {
    throw new Error(`Voice requires the Codex ChatGPT login. ${LOGIN_HINT}`);
  }
  const accountId = accountIdFromToken(result.auth.apiKey);
  if (!accountId) throw new Error(`Codex login has no ChatGPT account. ${LOGIN_HINT}`);
  return { accessToken: result.auth.apiKey, accountId };
}

export function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    const claims = payload["https://api.openai.com/auth"];
    if (claims && typeof claims === "object") {
      const id = (claims as Record<string, unknown>).chatgpt_account_id;
      if (typeof id === "string" && /^[\w-]+$/.test(id)) return id;
    }
  } catch { /* Not a Codex JWT. */ }
  return;
}

export function voiceHeaders(auth: VoiceAuth, sessionId: string, voiceSessionId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-ID": auth.accountId,
    "OpenAI-Alpha": "quicksilver=v2",
    originator: "codex_cli_rs",
    "User-Agent": "pi-voice/0.1.0",
    "x-session-id": voiceSessionId,
    "session-id": sessionId,
    "thread-id": sessionId,
  };
}
