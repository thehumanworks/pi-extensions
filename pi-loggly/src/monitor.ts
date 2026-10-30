import { evaluateHealth, fetchHealthData, sampleIssues, type HealthClient, type HealthData, type HealthIssue, type HealthRules, type HealthSnapshot } from "./analysis/health.ts";

export interface MonitorState {
  snapshot?: HealthSnapshot;
  /** The last refresh failure, cleared by the next success. */
  error?: string;
  refreshing: boolean;
  lastAttempt?: number;
}

export interface MonitorDeps {
  getClient: () => HealthClient;
  getRules: () => HealthRules;
  now?: () => number;
}

/**
 * Owns the latest health snapshot. The status line, dashboard and health tool
 * share it, so they never issue duplicate checks: concurrent refreshes join.
 */
export class HealthMonitor {
  #state: MonitorState = { refreshing: false };
  readonly #listeners = new Set<(state: MonitorState) => void>();
  readonly #deps: MonitorDeps;
  /** The last fetch: counts, sampled patterns by issue id, and its warnings. */
  #fetched?: { data: HealthData; generatedAt: number; samples: Map<string, Pick<HealthIssue, "patterns" | "basis">>; warnings: string[] };
  #inflight?: Promise<HealthSnapshot | undefined>;
  #controller?: AbortController;
  #timer?: ReturnType<typeof setInterval>;
  #disposed = false;

  constructor(deps: MonitorDeps) {
    this.#deps = deps;
  }

  get state(): MonitorState {
    return this.#state;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  subscribe(listener: (state: MonitorState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Whether the snapshot is missing or older than maxAgeMs. */
  isStale(maxAgeMs: number): boolean {
    const snapshot = this.#state.snapshot;
    return !snapshot || this.#now() - snapshot.generatedAt > maxAgeMs;
  }

  /** Run a health check, or join the one in flight. Failures are reported through state.error. */
  refresh(): Promise<HealthSnapshot | undefined> {
    if (this.#disposed) return Promise.resolve(undefined);
    if (this.#inflight) return this.#inflight;
    const controller = new AbortController();
    this.#controller = controller;
    this.#set({ refreshing: true, lastAttempt: this.#now() });
    const run = async (): Promise<HealthSnapshot | undefined> => {
      try {
        const client = this.#deps.getClient();
        const rules = this.#deps.getRules();
        const now = this.#now();
        const data = await fetchHealthData(client, rules, { signal: controller.signal, now });
        const snapshot = evaluateHealth(data.windows, rules, now, data.recent);
        await sampleIssues(client, snapshot, rules, controller.signal);
        if (controller.signal.aborted) return undefined;
        const samples = new Map(snapshot.issues.filter((issue) => issue.patterns).map((issue) => [issue.id, { patterns: issue.patterns, basis: issue.basis }]));
        this.#fetched = { data, generatedAt: now, samples, warnings: [...snapshot.warnings] };
        this.#set({ snapshot, error: undefined, refreshing: false });
        return snapshot;
      } catch (error) {
        if (!controller.signal.aborted) this.#set({ error: describeError(error), refreshing: false });
        return undefined;
      } finally {
        this.#inflight = undefined;
        if (this.#controller === controller) this.#controller = undefined;
        if (controller.signal.aborted) this.#set({ refreshing: false });
      }
    };
    this.#inflight = run();
    return this.#inflight;
  }

  /**
   * Re-classify the last fetched windows with the current rules (for example
   * after muting a system) without querying Loggly. Patterns are kept by issue.
   */
  reevaluate(): void {
    const fetched = this.#fetched;
    if (!fetched) return;
    const snapshot = evaluateHealth(fetched.data.windows, this.#deps.getRules(), fetched.generatedAt, fetched.data.recent);
    for (const issue of snapshot.issues) Object.assign(issue, fetched.samples.get(issue.id));
    snapshot.warnings.push(...fetched.warnings.filter((warning) => !snapshot.warnings.includes(warning)));
    this.#set({ snapshot });
  }

  /** Refresh now unless the snapshot is fresh, then every intervalMs until stop(). */
  start(intervalMs: number): void {
    this.stop();
    if (this.isStale(intervalMs)) void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Stop polling and abandon the check in flight. The monitor stays usable. */
  cancel(): void {
    this.stop();
    this.#controller?.abort();
  }

  dispose(): void {
    this.#disposed = true;
    this.cancel();
    this.#listeners.clear();
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #set(patch: Partial<MonitorState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#state);
      } catch {
        // A failing view must not break the monitor or other views.
      }
    }
  }
}

/** A short, safe description of a failure. SDK errors never contain response bodies. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0]!.slice(0, 300);
  return String(error).slice(0, 300);
}
