import { createLocalAuth } from "./auth.ts";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  type EnvironmentReader,
  getApiKey,
  readEnvironment,
} from "./src/secret.ts";

export const PI_AUTHENTICATION_DESCRIPTION =
  "Injected client/apiKey, otherwise the managed local xAI login, then the saved Pi xai login (access_token or access), then XAI_API_KEY. Managed local credentials refresh automatically; saved credentials are read lazily and rechecked on each API call.";

interface PiCredentialOptions {
  authPath?: string;
  localAuthPath?: string;
  readLocalToken?: (authPath?: string) => Promise<string | undefined>;
  env?: EnvironmentReader;
  readCredential?: (provider: string, authPath?: string) => unknown;
}

/** Managed local auth precedes read-only Pi auth; errors do not switch accounts. */
export async function getPiApiKey({
  authPath,
  localAuthPath,
  readLocalToken = (authPath) =>
    createLocalAuth({ authPath }).getCachedAccessToken(),
  env = readEnvironment,
  readCredential = readStoredCredential,
}: PiCredentialOptions = {}): Promise<string> {
  const localToken = await readLocalToken(localAuthPath);
  if (localToken !== undefined) return localToken;
  const credential = readCredential("xai", authPath);
  if (typeof credential === "object" && credential !== null) {
    const fields = credential as Record<string, unknown>;
    // Pi OAuth uses access; access_token also supports the provider's raw JSON.
    for (const token of [fields.access_token, fields.access]) {
      if (typeof token === "string" && token.trim()) return token;
    }
  }
  try {
    return await getApiKey(env);
  } catch {
    throw new Error(
      "Run pnpm auth login, log in to xai in Pi, set XAI_API_KEY, or supply an apiKey/client.",
    );
  }
}
