import type { LogglyClient } from "../sdk/client.ts";
import { formatDuration, parseDuration } from "../sdk/time.ts";
import type { FacetResult } from "../sdk/types.ts";
import { formatCount, formatPercent, formatRatio } from "./format.ts";
import { clusterMessages, type MessagePattern } from "./patterns.ts";

/** How systems are identified and when they count as unhealthy. */
export interface HealthRules {
  /** Query restricting every health check, such as production only. "*" checks everything. */
  scope: string;
  /** Field whose values are the monitored systems. */
  groupBy: string;
  /** Query matching error events. */
  errorQuery: string;
  /** Fields tried, in order, for the message text of sampled errors. */
  messageFields: string[];
  /** Length of the current window and of each baseline window. */
  window: string;
  /** Number of preceding windows forming the baseline (their median is "usual"). */
  baselineWindows: number;
  /** Recent time skipped to allow for Loggly's indexing delay. */
  lag: string;
  /** Errors at least this many times the baseline are a warning. */
  spikeRatio: number;
  /** Errors at least this many times the baseline are critical. */
  criticalRatio: number;
  /** Minimum errors in a window (and above the baseline) before a spike or chronic issue is raised. */
  minErrors: number;
  /** Systems usually logging at least this many events per window are checked for silence. */
  silentMinBaseline: number;
  /** A system logging at most this fraction of its usual volume has stopped logging. */
  silentRatio: number;
  /** A system whose events are at least this fraction errors is a chronic notice. */
  chronicErrorRate: number;
  /** Error events sampled per issue to name its messages. */
  sampleSize: number;
  /** Issues sampled per refresh. */
  sampleIssues: number;
  /** Systems tracked per window, at most 300 (Loggly's facet limit). */
  maxSystems: number;
  /** Systems shown but never raised as issues. */
  muted: string[];
}

export const DEFAULT_HEALTH_RULES: HealthRules = {
  scope: "*",
  groupBy: "syslog.appName",
  errorQuery: "syslog.severity:(Error OR Critical OR Alert OR Emergency) OR json.level:(error OR fatal OR critical) OR json.logLevel:(ERROR OR FATAL)",
  messageFields: ["json.message", "json.msg"],
  window: "10m",
  baselineWindows: 12,
  lag: "2m",
  spikeRatio: 3,
  criticalRatio: 10,
  minErrors: 50,
  silentMinBaseline: 200,
  silentRatio: 0.1,
  chronicErrorRate: 0.25,
  sampleSize: 200,
  sampleIssues: 3,
  maxSystems: 300,
  muted: [],
};

export type Severity = "critical" | "warning" | "notice";
export type IssueKind = "spike" | "new-errors" | "recurring" | "silent" | "ingestion" | "chronic";
export type SystemStatus = Severity | "ok" | "muted";
export type OverallStatus = "healthy" | "degraded" | "critical";

export interface TimeRange {
  from: number;
  until: number;
}

export interface WindowCounts extends TimeRange {
  errors: FacetResult;
  volume: FacetResult;
}

/** Volume by system after the current window (the indexing lag), used to tell lulls from outages. */
export interface RecentVolume extends TimeRange {
  volume: FacetResult;
}

export interface HealthData {
  windows: WindowCounts[];
  recent?: RecentVolume;
}

export interface SystemHealth {
  name: string;
  status: SystemStatus;
  /** The kind of this system's issue, when it has one. */
  issue?: IssueKind;
  /** Errors per window, oldest first; the last is the current window. */
  errors: number[];
  /** Events per window, oldest first. */
  volume: number[];
  errorsNow: number;
  errorsBaseline: number;
  volumeNow: number;
  volumeBaseline: number;
  /** errorsNow relative to the baseline (a zero baseline counts as one). */
  ratio: number;
  /** Fraction of current events that are errors. */
  errorRate: number;
}

export interface HealthIssue extends TimeRange {
  id: string;
  kind: IssueKind;
  severity: Severity;
  /** The affected system; absent for account-wide issues. */
  system?: string;
  summary: string;
  /** Loggly query reproducing the issue's events. */
  query: string;
  errorsNow: number;
  errorsBaseline: number;
  volumeNow: number;
  volumeBaseline: number;
  ratio: number;
  errorRate: number;
  score: number;
  /** Message patterns from a sample of the issue's newest error events. */
  patterns?: MessagePattern[];
  sampled?: number;
}

export interface HealthTotals {
  errors: number[];
  volume: number[];
  errorsNow: number;
  errorsBaseline: number;
  volumeNow: number;
  volumeBaseline: number;
}

export interface HealthSnapshot {
  status: OverallStatus;
  generatedAt: number;
  windowMs: number;
  windows: TimeRange[];
  current: TimeRange;
  rules: HealthRules;
  systems: SystemHealth[];
  issues: HealthIssue[];
  totals: HealthTotals;
  /** Some windows had more systems than maxSystems; small systems may be missing. */
  truncated: boolean;
  warnings: string[];
}

const SEVERITY_RANK: Record<SystemStatus, number> = { critical: 4, warning: 3, notice: 2, ok: 1, muted: 0 };

/** Quote a value for an exact field match in a Loggly query. */
export function fieldMatch(field: string, value: string): string {
  return `${field}:"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** Combine query clauses with AND, dropping match-all clauses. */
export function allOf(...clauses: Array<string | undefined>): string {
  const parts = clauses.map((clause) => clause?.trim()).filter((clause): clause is string => !!clause && clause !== "*");
  if (!parts.length) return "*";
  if (parts.length === 1) return parts[0]!;
  return parts.map((part) => (/\s/.test(part) && !/^\(.*\)$/.test(part) ? `(${part})` : part)).join(" AND ");
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The aligned windows a check at `now` compares: baseline windows, then the current window. */
export function healthWindows(rules: HealthRules, now: number): TimeRange[] {
  const windowMs = parseDuration(rules.window);
  const lagMs = parseDuration(rules.lag, { allowZero: true });
  // Align to whole minutes so consecutive refreshes and windows line up.
  const end = Math.floor((now - lagMs) / 60_000) * 60_000;
  const count = rules.baselineWindows + 1;
  return Array.from({ length: count }, (_, index) => ({
    from: end - (count - index) * windowMs,
    until: end - (count - 1 - index) * windowMs,
  }));
}

/**
 * Classify systems from per-window error and volume facets (oldest first,
 * current last). `recent` volume, when given, clears systems that went quiet
 * in the current window but have since resumed.
 */
export function evaluateHealth(windows: readonly WindowCounts[], rules: HealthRules, generatedAt: number, recent?: RecentVolume): HealthSnapshot {
  if (windows.length < 2) throw new RangeError("Health needs a current window and at least one baseline window");
  const last = windows.length - 1;
  const current = windows[last]!;
  const windowMs = current.until - current.from;
  const label = formatDuration(windowMs);
  const muted = new Set(rules.muted);

  const totals = summarize(windows.map((w) => w.errors.totalEvents), windows.map((w) => w.volume.totalEvents));
  const ingestionDrop = totals.volumeBaseline >= rules.silentMinBaseline && totals.volumeNow <= totals.volumeBaseline * 0.5;
  // When the current volume facet was truncated, an absent system logged fewer
  // events than the smallest listed one: an upper bound, not zero.
  const volumeComplete = !current.volume.truncated;
  const smallestListed = current.volume.terms.length ? Math.min(...current.volume.terms.map((t) => t.count)) : 0;
  const truncated = windows.some((w) => w.errors.truncated || w.volume.truncated);

  const names = new Set<string>();
  for (const window of windows) for (const facet of [window.errors, window.volume]) for (const term of facet.terms) names.add(term.term);
  const lookups = windows.map((w) => ({ errors: termCounts(w.errors), volume: termCounts(w.volume) }));
  // Too short a period says nothing about the rate.
  const recentMs = recent ? recent.until - recent.from : 0;
  const recentCounts = recent && recentMs >= 30_000 ? termCounts(recent.volume) : undefined;

  const systems: SystemHealth[] = [];
  const issues: HealthIssue[] = [];
  for (const name of names) {
    const errors = lookups.map((l) => l.errors.get(name) ?? 0);
    const volume = lookups.map((l) => l.volume.get(name) ?? 0);
    const stats = summarize(errors, volume);
    const ratio = stats.errorsNow / Math.max(stats.errorsBaseline, 1);
    const errorRate = stats.volumeNow > 0 ? Math.min(1, stats.errorsNow / stats.volumeNow) : 0;
    const system: SystemHealth = { name, status: "ok", errors, volume, ...pick(stats), ratio, errorRate };
    systems.push(system);
    if (muted.has(name)) {
      system.status = "muted";
      continue;
    }
    const base = { system: name, from: current.from, until: current.until, ...pick(stats), ratio, errorRate };
    const errorQuery = allOf(rules.scope, rules.errorQuery, fieldMatch(rules.groupBy, name));
    const volumeKnown = lookups[last]!.volume.has(name) || volumeComplete;
    const volumeUpperBound = volumeKnown ? stats.volumeNow : smallestListed;
    const baselineErrors = errors.slice(0, last);
    const silentLimit = stats.volumeBaseline * rules.silentRatio;
    const resumed = recentCounts !== undefined && ((recentCounts.get(name) ?? 0) * windowMs) / recentMs > silentLimit;
    let issue: HealthIssue | undefined;
    if (
      !ingestionDrop &&
      !resumed &&
      stats.volumeBaseline >= rules.silentMinBaseline &&
      volumeUpperBound <= silentLimit &&
      // A job that is regularly quiet between runs has not stopped logging.
      recurrences(volume.slice(0, last), (count) => count <= silentLimit) === 0
    ) {
      // One quiet window can be a lull; no events at all, or two quiet windows, is an outage.
      const stopped = volumeKnown && stats.volumeNow === 0;
      const persisted = volume[last - 1]! <= silentLimit;
      const usual = `usually ${formatCount(stats.volumeBaseline)}`;
      issue = {
        ...base, id: `silent:${name}`, kind: "silent", severity: stopped || persisted ? "critical" : "warning", score: stats.volumeBaseline,
        summary: stopped
          ? `stopped logging: no events in ${label}, ${usual}`
          : `log volume down ${volumeKnown ? formatPercent(1 - stats.volumeNow / stats.volumeBaseline) : `over ${formatPercent(1 - rules.silentRatio)}`}: ${volumeKnown ? formatCount(stats.volumeNow) : `<${formatCount(smallestListed)}`} events in ${label}, ${usual}${persisted ? "; also low in the previous window" : ""}`,
        query: allOf(rules.scope, fieldMatch(rules.groupBy, name)),
      };
    } else if (stats.errorsNow >= rules.minErrors && stats.errorsNow - stats.errorsBaseline >= rules.minErrors && ratio >= rules.spikeRatio) {
      const fresh = stats.errorsBaseline === 0;
      // Bursts like this one earlier in the baseline, apart from an ongoing
      // episode, are periodic (such as a failing scheduled job), not new.
      const repeats = recurrences(baselineErrors, (count) => count >= Math.max(rules.minErrors, stats.errorsNow * 0.5));
      if (repeats > 0) {
        issue = {
          ...base, id: `recurring:${name}`, kind: "recurring", severity: "notice", score: stats.errorsNow,
          summary: `recurring error bursts: ${formatCount(stats.errorsNow)} in ${label}, usually ${formatCount(stats.errorsBaseline)}; ${repeats} similar in the previous ${baselineErrors.length} windows`,
          query: errorQuery,
        };
      } else {
        // Errors from a system that had none (such as a job that just ran) are
        // a warning unless the burst is large.
        const critical = fresh ? stats.errorsNow >= rules.minErrors * 5 : ratio >= rules.criticalRatio;
        issue = {
          ...base, id: `${fresh ? "new-errors" : "spike"}:${name}`, kind: fresh ? "new-errors" : "spike",
          severity: critical ? "critical" : "warning", score: stats.errorsNow - stats.errorsBaseline,
          summary: fresh
            ? `new errors: ${formatCount(stats.errorsNow)} in ${label}, usually none`
            : `errors ${formatRatio(ratio)}: ${formatCount(stats.errorsNow)} in ${label}, usually ${formatCount(stats.errorsBaseline)}`,
          query: errorQuery,
        };
      }
    } else if (stats.errorsNow >= rules.minErrors && errorRate >= rules.chronicErrorRate) {
      issue = {
        ...base, id: `chronic:${name}`, kind: "chronic", severity: "notice", score: stats.errorsNow,
        summary: `${formatPercent(errorRate)} of events are errors: ${formatCount(stats.errorsNow)} in ${label}`,
        query: errorQuery,
      };
    }
    if (issue) {
      system.status = issue.severity;
      system.issue = issue.kind;
      issues.push(issue);
    }
  }

  if (ingestionDrop) {
    issues.push({
      id: "ingestion", kind: "ingestion", severity: "critical", from: current.from, until: current.until,
      ...pick(totals), ratio: totals.errorsNow / Math.max(totals.errorsBaseline, 1),
      errorRate: totals.volumeNow > 0 ? totals.errorsNow / totals.volumeNow : 0, score: totals.volumeBaseline,
      summary: `log volume down ${formatPercent(1 - totals.volumeNow / totals.volumeBaseline)} across all systems (${formatCount(totals.volumeNow)} in ${label}, usually ${formatCount(totals.volumeBaseline)}): possible ingestion or indexing delay`,
      query: allOf(rules.scope),
    });
  }

  issues.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.score - a.score);
  systems.sort((a, b) => SEVERITY_RANK[b.status] - SEVERITY_RANK[a.status] || b.errorsNow - a.errorsNow || b.volumeNow - a.volumeNow || a.name.localeCompare(b.name));
  const status: OverallStatus = issues.some((i) => i.severity === "critical") ? "critical" : issues.some((i) => i.severity === "warning") ? "degraded" : "healthy";
  return {
    status,
    generatedAt,
    windowMs,
    windows: windows.map(({ from, until }) => ({ from, until })),
    current: { from: current.from, until: current.until },
    rules,
    systems,
    issues,
    totals,
    truncated,
    warnings: truncated ? [`More than ${rules.maxSystems} systems: the smallest are not tracked`] : [],
  };
}

export type HealthClient = Pick<LogglyClient, "facet" | "search">;

/**
 * Run a health check: facet errors and volume by system for each window, then
 * evaluate, then name the most pressing issues by sampling their error messages.
 */
export async function collectHealth(
  client: HealthClient,
  rules: HealthRules,
  options: { signal?: AbortSignal; now?: number; sample?: boolean } = {},
): Promise<HealthSnapshot> {
  const now = options.now ?? Date.now();
  const data = await fetchHealthData(client, rules, { signal: options.signal, now });
  const snapshot = evaluateHealth(data.windows, rules, now, data.recent);
  if (options.sample !== false) await sampleIssues(client, snapshot, rules, options.signal);
  return snapshot;
}

/**
 * Facet errors and volume by system for the baseline windows and the current
 * window, plus volume since the current window ended.
 */
export async function fetchHealthData(
  client: Pick<LogglyClient, "facet">,
  rules: HealthRules,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<HealthData> {
  const now = options.now ?? Date.now();
  const ranges = healthWindows(rules, now);
  const lagRange = { from: ranges.at(-1)!.until, until: now };
  const failFast = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, failFast.signal]) : failFast.signal;
  const errorQuery = allOf(rules.scope, rules.errorQuery);
  const volumeQuery = allOf(rules.scope);
  const facet = (query: string, range: TimeRange) =>
    client.facet(rules.groupBy, { query, from: new Date(range.from), until: new Date(range.until), size: Math.min(300, rules.maxSystems) }, { signal });
  try {
    const [windows, recent] = await Promise.all([
      Promise.all(ranges.map(async (range) => {
        const [errors, volume] = await Promise.all([facet(errorQuery, range), facet(volumeQuery, range)]);
        return { ...range, errors, volume };
      })),
      lagRange.until - lagRange.from >= 30_000 ? facet(volumeQuery, lagRange).then((volume) => ({ ...lagRange, volume })) : undefined,
    ]);
    return recent ? { windows, recent } : { windows };
  } catch (error) {
    failFast.abort(); // Stop the remaining requests; one missing window invalidates the comparison.
    throw error;
  }
}

/** Attach message patterns to the top error issues. Failures are recorded as warnings. */
export async function sampleIssues(client: Pick<LogglyClient, "search">, snapshot: HealthSnapshot, rules: HealthRules, signal?: AbortSignal): Promise<void> {
  // Most pressing first: issues are sorted by severity, so notices are sampled last.
  const targets = snapshot.issues.filter((issue) => issue.kind !== "silent" && issue.kind !== "ingestion").slice(0, rules.sampleIssues);
  await Promise.all(targets.map(async (issue) => {
    try {
      const events = await client.search(
        { query: issue.query, from: new Date(issue.from), until: new Date(issue.until), order: "desc" },
        { limit: rules.sampleSize, signal },
      );
      issue.sampled = events.length;
      issue.patterns = clusterMessages(events, { messageFields: rules.messageFields, limit: 5 });
    } catch (error) {
      if (signal?.aborted) throw error;
      snapshot.warnings.push(`Could not sample messages for ${issue.system ?? issue.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

/**
 * Baseline windows (oldest first) matching a condition, excluding the run that
 * ends at the latest baseline window: that run is the episode still in progress.
 */
export function recurrences(baseline: readonly number[], matches: (count: number) => boolean): number {
  let index = baseline.length - 1;
  while (index >= 0 && matches(baseline[index]!)) index--;
  let count = 0;
  for (; index >= 0; index--) if (matches(baseline[index]!)) count++;
  return count;
}

function termCounts(facet: FacetResult): Map<string, number> {
  return new Map(facet.terms.map((term) => [term.term, term.count]));
}

function summarize(errors: number[], volume: number[]): HealthTotals {
  const last = errors.length - 1;
  return {
    errors,
    volume,
    errorsNow: errors[last] ?? 0,
    errorsBaseline: median(errors.slice(0, last)),
    volumeNow: volume[last] ?? 0,
    volumeBaseline: median(volume.slice(0, last)),
  };
}

function pick(stats: HealthTotals) {
  return { errorsNow: stats.errorsNow, errorsBaseline: stats.errorsBaseline, volumeNow: stats.volumeNow, volumeBaseline: stats.volumeBaseline };
}
