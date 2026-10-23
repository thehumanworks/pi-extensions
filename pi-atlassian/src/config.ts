export interface Config {
  baseUrl: string; username: string; token: string; authMode: 'basic' | 'bearer';
  cloudId: string; allowWrites: boolean; timeoutMs: number; maxResponseBytes: number;
  maxRetries: number; maxRetryDelayMs: number; maxConcurrency: number; maxStoreBytes: number;
  allowInsecureLocalhost: boolean;
}
function bound(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return value !== undefined && Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}
/** No validation/network at startup; credentials remain private in the service closure. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    baseUrl: env.ATLASSIAN_BASE_URL ?? '', username: env.ATLASSIAN_API_USERNAME ?? '', token: env.ATLASSIAN_API_TOKEN ?? '',
    authMode: (env.ATLASSIAN_AUTH_MODE ?? 'basic') as Config['authMode'], cloudId: env.ATLASSIAN_CLOUD_ID ?? '',
    allowWrites: env.ATLASSIAN_ALLOW_WRITES === '1', allowInsecureLocalhost: env.ATLASSIAN_ALLOW_INSECURE_LOCALHOST === '1',
    timeoutMs: bound(env.ATLASSIAN_TIMEOUT_MS, 30000, 1, 120000),
    maxResponseBytes: bound(env.ATLASSIAN_MAX_RESPONSE_BYTES, 8388608, 1, 33554432),
    maxRetries: bound(env.ATLASSIAN_MAX_RETRIES, 2, 0, 5),
    maxRetryDelayMs: bound(env.ATLASSIAN_MAX_RETRY_DELAY_MS, 5000, 0, 30000),
    maxConcurrency: bound(env.ATLASSIAN_MAX_CONCURRENCY, 4, 1, 16),
    maxStoreBytes: bound(env.ATLASSIAN_MAX_STORE_BYTES, 67108864, 1, 536870912),
  };
}
