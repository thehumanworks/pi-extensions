import { allOf, type HealthRules } from "../analysis/health.ts";
import type { LogglyClient } from "../sdk/client.ts";
import { formatDuration, parseDuration } from "../sdk/time.ts";
import type { FacetResult, LogEvent } from "../sdk/types.ts";
import { formatClock } from "../analysis/format.ts";
import { formatSpan, previousPeriod } from "./analyze.ts";
import { addDays, startOfDay, TimeframeError, type Timeframe } from "./timeframe.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BUCKET_SIZES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * MINUTE_MS);
/** Enough points for a readable chart, few enough to keep a report to about a minute. */
const MAX_BUCKETS = 30;

export interface Span {
  from: number;
  until: number;
}

export interface ReportPlan extends Span {
  label: string;
  bucketMs: number;
  buckets: Span[];
  /** The period compared with, when Loggly still has it. */
  previous?: Span;
  /** "the previous 2 hours", or "the same hours a day earlier" for part of a day. */
  previousLabel?: string;
  /** How the requested timeframe was adjusted. */
  notes: string[];
}

export type ReportClient = Pick<LogglyClient, "facet" | "search">;

export interface BucketData extends Span {
  errors: FacetResult;
  volume: FacetResult;
  /** Newest errors in the bucket, for message patterns. */
  sample: LogEvent[];
}

export interface PeriodData {
  plan: ReportPlan;
  buckets: BucketData[];
  /** The most frequent exact error messages over the whole timeframe. */
  messages?: FacetResult;
  previous?: { errors: FacetResult; volume: FacetResult; messages?: FacetResult };
}

/** The smallest bucket that keeps the chart to at most 30 points. */
export function bucketSize(spanMs: number): number {
  return BUCKET_SIZES.find((size) => Math.ceil(spanMs / size) <= MAX_BUCKETS) ?? Math.ceil(spanMs / DAY_MS / MAX_BUCKETS) * DAY_MS;
}

/**
 * Turn a timeframe into whole buckets of indexed data: end before the indexing
 * allowance, start within Loggly's retention, and align to bucket boundaries
 * (local midnight for days).
 */
export function planReport(timeframe: Timeframe, rules: HealthRules, now: number, retentionDays?: number): ReportPlan {
  const notes: string[] = [];
  const lag = parseDuration(rules.lag, { allowZero: true });
  // Keep an hour's margin: Loggly deletes old data in batches.
  const earliest = retentionDays === undefined ? -Infinity : now - retentionDays * DAY_MS + 60 * MINUTE_MS;
  const requestedFrom = timeframe.from.getTime();
  const requestedUntil = timeframe.until.getTime();
  const indexed = Math.floor((now - lag) / MINUTE_MS) * MINUTE_MS;
  const tooShort = () => new TimeframeError(`"${timeframe.label}" is too short: Loggly needs ${formatDuration(lag)} to index new logs, so pick a longer timeframe.`);
  let from = Math.max(requestedFrom, earliest);
  if (from > requestedFrom) notes.push(`Loggly keeps ${retentionDays} days of logs, so the report starts at the oldest data it still has.`);
  let until = Math.min(requestedUntil, indexed);
  let bucketMs: number;
  const buckets: Span[] = [];
  if (timeframe.rolling) {
    // "Last 7 days" keeps its length and ends at the newest indexed minute; periods count back from there.
    from = Math.max(until - (requestedUntil - requestedFrom), earliest);
    bucketMs = bucketSize(until - from);
    const count = Math.floor((until - from) / bucketMs);
    if (count < 1) throw tooShort();
    from = until - count * bucketMs;
    for (let i = 0; i < count; i++) buckets.push({ from: from + i * bucketMs, until: from + (i + 1) * bucketMs });
    if (requestedUntil - until >= MINUTE_MS) notes.push(`Ends ${formatDuration(Math.max(1, Math.round((now - until) / MINUTE_MS)) * MINUTE_MS)} ago, at ${formatClock(until)}: Loggly needs about ${formatDuration(lag)} to index new logs.`);
  } else {
    // Calendar timeframes keep round period boundaries: local midnights, whole hours.
    const size = bucketSize(until - from);
    bucketMs = size;
    const align = (time: number) => (size >= DAY_MS ? startOfDay(new Date(time)).getTime() : Math.floor(time / size) * size);
    const next = (time: number) => (size >= DAY_MS ? addDays(new Date(time), size / DAY_MS).getTime() : time + size);
    until = align(until);
    from = align(from);
    if (from < earliest) from = next(from);
    if (until <= from) throw tooShort();
    for (let start = from; start < until; start = next(start)) buckets.push({ from: start, until: Math.min(next(start), until) });
    if (requestedUntil - until >= MINUTE_MS) {
      notes.push(`Ends at ${formatClock(until)}, ${formatDuration(Math.round((now - until) / MINUTE_MS) * MINUTE_MS)} ago: the end of the last complete period of ${formatSpan(bucketMs)} with indexed logs.`);
    }
  }
  const length = until - from;
  // Part of a calendar day ("today", "since 9am") compares with the same hours a day earlier, not the night before.
  const sameHours = !timeframe.rolling && length < DAY_MS;
  const shift = sameHours ? DAY_MS : length;
  const previous = from - shift >= earliest ? { from: from - shift, until: until - shift } : undefined;
  if (!previous) notes.push("No comparison with an earlier period: Loggly no longer has it.");
  const previousLabel = previous ? (sameHours ? "the same hours a day earlier" : previousPeriod(length)) : undefined;
  return { label: timeframe.label, from, until, bucketMs, buckets, previous, previousLabel, notes };
}

export interface CollectOptions {
  signal?: AbortSignal;
  /** Errors sampled across the timeframe for message patterns. Default 1,000. */
  sampleSize?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Fetch everything a report needs: errors and events per system in each
 * bucket, totals for the previous period, the most frequent exact error
 * messages, and a sample of errors spread over the buckets.
 */
export async function collectPeriod(client: ReportClient, rules: HealthRules, plan: ReportPlan, options: CollectOptions = {}): Promise<PeriodData> {
  const { signal } = options;
  const errorQuery = allOf(rules.scope, rules.errorQuery);
  const volumeQuery = allOf(rules.scope);
  const messageField = rules.messageFields[0];
  const size = rules.maxSystems;
  const facetCount = plan.buckets.length * 2 + (messageField ? 1 : 0) + (plan.previous ? (messageField ? 3 : 2) : 0);
  let total = facetCount + plan.buckets.length;
  let done = 0;
  const step = <T>(promise: Promise<T>): Promise<T> =>
    promise.then((value) => {
      options.onProgress?.(++done, total);
      return value;
    });
  const facet = (field: string, query: string, span: Span, facetSize = size) =>
    step(client.facet(field, { query, from: new Date(span.from), until: new Date(span.until), size: facetSize }, { signal }));

  const [counts, messages, previous] = await Promise.all([
    Promise.all(plan.buckets.map(async (span) => ({ ...span, errors: await facet(rules.groupBy, errorQuery, span), volume: await facet(rules.groupBy, volumeQuery, span) }))),
    messageField ? facet(messageField, errorQuery, plan, 300) : undefined,
    plan.previous
      ? Promise.all([facet(rules.groupBy, errorQuery, plan.previous), facet(rules.groupBy, volumeQuery, plan.previous), messageField ? facet(messageField, errorQuery, plan.previous, 300) : undefined])
      : undefined,
  ]);

  // Sample the same number of errors from each bucket that has any; analysis weights them by the bucket's errors.
  const withErrors = counts.filter((bucket) => bucket.errors.totalEvents > 0);
  total -= counts.length - withErrors.length;
  const perBucket = withErrors.length ? Math.min(1000, Math.max(10, Math.ceil((options.sampleSize ?? 1000) / withErrors.length))) : 0;
  const samples = new Map(
    await Promise.all(
      withErrors.map(async (bucket) => {
        const limit = Math.min(perBucket, bucket.errors.totalEvents);
        const events = await step(client.search({ query: errorQuery, from: new Date(bucket.from), until: new Date(bucket.until), order: "desc" }, { limit, signal }));
        return [bucket.from, events] as const;
      }),
    ),
  );
  return {
    plan,
    buckets: counts.map((bucket) => ({ ...bucket, sample: samples.get(bucket.from) ?? [] })),
    messages,
    previous: previous ? { errors: previous[0], volume: previous[1], messages: previous[2] } : undefined,
  };
}
