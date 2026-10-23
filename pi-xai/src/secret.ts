export type EnvironmentReader = (name: string) => string | undefined;

/** Host access happens only when credentials are requested, never at import. */
export const readEnvironment: EnvironmentReader = (name) => {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[name];
};

export async function getApiKey(
  env: EnvironmentReader = readEnvironment,
): Promise<string> {
  const key = env("XAI_API_KEY");
  if (key) return key;
  throw new Error("Set XAI_API_KEY or supply an apiKey/client.");
}
