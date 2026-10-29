import { UsageError, type AuthRegistry, type UsageProvider, type UsageResult } from "./types.ts";

/** Pi owns auth refresh, which has no command AbortSignal in 1.4.0. Stop waiting
 * on dismissal/timeout without interfering with its locked token rotation. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export async function collectUsage(
  providers: readonly UsageProvider[],
  registry: AuthRegistry,
  signal: AbortSignal,
  options: { timeoutMs?: number; activeProvider?: string } = {},
): Promise<UsageResult[]> {
  signal.throwIfAborted();
  const results = await Promise.all(providers.map(async (adapter): Promise<UsageResult> => {
    const provider = { id: adapter.id, label: adapter.label, dashboardUrl: adapter.dashboardUrl };
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const snapshot = await abortable(Promise.resolve().then(() => adapter.fetch({ registry, signal: combined, activeProvider: options.activeProvider })), combined);
      return { provider, status: "ok", snapshot };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) return { provider, status: "error", message: "Usage check timed out. Try refreshing." };
      if (error instanceof UsageError) return { provider, status: error.status, message: error.message };
      // A provider must opt into a safe message. Do not render raw request errors.
      return { provider, status: "error", message: "Could not retrieve usage for this provider. Try refreshing or check its dashboard." };
    }
  }));
  signal.throwIfAborted();
  return results;
}
