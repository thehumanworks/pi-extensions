import { randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { LogglyClient } from "../sdk/client.ts";
import { LogglyRateLimitError } from "../sdk/errors.ts";
import type { LogEvent } from "../sdk/types.ts";
import { extractMessage, fieldText, getField, singleLine, templateOf } from "./patterns.ts";

/**
 * Estimates of how a period's errors split by pattern (or any other key),
 * from short windows at random times.
 *
 * The period is cut into equal slices and each slice gets one window of the
 * same length at a uniformly random offset; the last window wraps round to
 * the start. Every error then has the same chance, window / slice, of being
 * in a window, so the errors found, scaled up by slice / window, estimate the
 * period's without bias (the Horvitz–Thompson estimator). A window holding
 * more than a page of errors is counted, and a random stretch of it sized for
 * half a page is sampled the same way. Standard errors come from the spread
 * between windows, as for a simple random sample, which overstates them a
 * little.
 *
 * Bursts are the weakness of any time sample: a pattern that comes in a few
 * dense minutes is missed, or seen in a few windows. So an estimate is only
 * used when its key appeared in at least MIN_WINDOWS windows and its
 * relative standard error is at most MAX_RSE, and every sample is checked
 * against counts Loggly knows exactly.
 */

/** Windows a key must appear in before its estimate is used. */
export const MIN_WINDOWS = 10;
/** Largest relative standard error used, a common cut-off for publishing estimates. */
export const MAX_RSE = 0.3;
/** Two-sided 95% normal quantile. */
const Z95 = 1.96;
/** Errors a window holds at the period's average rate. */
const TARGET_PER_WINDOW = 60;
/** Errors fetched per request. */
const PAGE_SIZE = 200;
/** Stretches within stretches before a span's newest page stands for all of it. */
const MAX_DEPTH = 4;
/** Waits before retrying a rate-limited request, on top of the client's own retries. */
const RATE_LIMIT_WAITS_MS = [30_000, 60_000, 120_000];

export type SampleClient = Pick<LogglyClient, "search" | "count">;

export interface Span {
  from: number;
  until: number;
}

export interface SampleDesign {
  windows: number;
  windowMs: number;
  /** Seed of the window offsets, so the same windows can be drawn again. */
  seed: number;
}

export interface SampledWindow extends Span {
  /** Errors in the window, exactly. */
  count: number;
  /** All of them, or those of random stretches when there were more than a page. */
  events: LogEvent[];
  /** Errors each sampled one stands for, when not 1 each. */
  weights?: number[];
}

export interface ErrorSample extends Span {
  design: SampleDesign;
  /** The period's exact error count. */
  total: number;
  windows: SampledWindow[];
}

export interface SampleOptions {
  windows: number;
  seed?: number;
  /** Requests at a time. Loggly limits API requests per account, so stay gentle. */
  concurrency?: number;
  signal?: AbortSignal;
  onWindow?: () => void;
  /** Overrides the waits after rate limiting; for tests. */
  rateLimitWaitsMs?: readonly number[];
}

/**
 * One window per equal slice at a random offset, sized for about 60 errors
 * at the period's average rate. A window may run past the end of the period;
 * that part wraps round to its start.
 */
export function planWindows(from: number, until: number, total: number, windows: number, seed: number): { windowMs: number; spans: Span[] } {
  const span = until - from;
  if (windows < 2 || total <= 0 || span <= 0) return { windowMs: 0, spans: [] };
  const slice = span / windows;
  const windowMs = Math.min(Math.max(1, Math.floor(slice)), Math.max(1, Math.round((TARGET_PER_WINDOW * span) / total)));
  const random = seededRandom(seed);
  const spans = Array.from({ length: windows }, (_, i) => {
    const start = Math.min(until - 1, Math.floor(from + i * slice + random() * slice));
    return { from: start, until: start + windowMs };
  });
  return { windowMs, spans };
}

/** The parts of a window inside the period: itself, or itself up to the end and the rest from the start. */
export function windowParts(window: Span, period: Span): Span[] {
  if (window.until <= period.until) return [window];
  return [{ from: window.from, until: period.until }, { from: period.from, until: period.from + (window.until - period.until) }];
}

/** Sample errors matching `query` in [from, until), whose exact count is `total`. About one request per window. */
export async function sampleErrors(client: SampleClient, query: string, from: number, until: number, total: number, options: SampleOptions): Promise<ErrorSample> {
  const seed = options.seed ?? randomInt(2 ** 31);
  const period = { from, until };
  const { windowMs, spans } = planWindows(from, until, total, options.windows, seed);
  const { signal } = options;
  const waits = options.rateLimitWaitsMs ?? RATE_LIMIT_WAITS_MS;
  const retrying = async <T>(request: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request();
      } catch (error) {
        if (!(error instanceof LogglyRateLimitError) || attempt >= waits.length) throw error;
        await wait(waits[attempt]!, undefined, { signal });
      }
    }
  };
  const range = (span: Span) => ({ query, from: new Date(span.from), until: new Date(span.until) });
  const newest = (span: Span) => retrying(() => client.search({ ...range(span), order: "desc", size: PAGE_SIZE }, { limit: PAGE_SIZE, signal }));
  const countOf = async (span: Span) => (await retrying(() => client.count(range(span), { signal }))).count;

  /** A span's errors: all of them, or a random stretch's, scaled up. */
  const sampleSpan = async (span: Span, random: () => number, depth: number): Promise<{ count: number; events: LogEvent[]; weights: number[] }> => {
    const events = await newest(span);
    if (events.length < PAGE_SIZE) return { count: events.length, events, weights: events.map(() => 1) };
    const count = Math.max(events.length, await countOf(span));
    const length = span.until - span.from;
    // Too dense to cut further: the newest page stands for the span.
    if (depth >= MAX_DEPTH || length <= 1) return { count, events, weights: events.map(() => count / events.length) };
    const stretch = Math.max(1, Math.min(length, Math.floor((length * PAGE_SIZE) / 2 / count)));
    const start = span.from + Math.floor(random() * length);
    const scale = length / stretch;
    const sampled: LogEvent[] = [];
    const weights: number[] = [];
    for (const part of windowParts({ from: start, until: start + stretch }, span)) {
      const inner = await sampleSpan(part, random, depth + 1);
      sampled.push(...inner.events);
      weights.push(...inner.weights.map((weight) => weight * scale));
    }
    return { count, events: sampled, weights };
  };

  const results: SampledWindow[] = new Array(spans.length);
  let next = 0;
  const worker = async () => {
    while (next < spans.length) {
      const index = next++;
      signal?.throwIfAborted();
      // Each window has its own random stream, so stretches do not depend on request timing.
      const random = seededRandom((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
      const window: SampledWindow = { ...spans[index]!, count: 0, events: [] };
      const weights: number[] = [];
      for (const part of windowParts(spans[index]!, period)) {
        const sampled = await sampleSpan(part, random, 0);
        window.count += sampled.count;
        window.events.push(...sampled.events);
        weights.push(...sampled.weights);
      }
      if (weights.some((weight) => weight !== 1)) window.weights = weights;
      results[index] = window;
      options.onWindow?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 2, spans.length) }, worker));
  return { from, until, design: { windows: spans.length, windowMs, seed }, total, windows: results };
}

export interface Estimate {
  /** Estimated errors with this key. */
  estimate: number;
  /** Its standard error. */
  se: number;
  /** Windows the key appeared in. */
  windows: number;
  /** Sampled errors with the key. */
  sampled: number;
}

/** Errors a sampled error stands for within its window. */
export function weightOf(window: SampledWindow, index: number): number {
  return window.weights?.[index] ?? 1;
}

/** Errors the sample stands for: slice / window. */
function expansion(sample: Pick<ErrorSample, "from" | "until" | "design">): number {
  return (sample.until - sample.from) / (sample.design.windows * sample.design.windowMs);
}

/** Expansion estimate and standard error from per-window values, given their sum and sum of squares. */
function expand(sample: Pick<ErrorSample, "from" | "until" | "design">, sum: number, sumSquares: number): { estimate: number; se: number } {
  const m = sample.design.windows;
  const f = expansion(sample);
  const variance = Math.max(0, (sumSquares - (sum * sum) / m) / (m - 1));
  return { estimate: f * sum, se: f * Math.sqrt(m * variance) };
}

/** Estimated errors per key, for every key seen in the sample. Events whose key is undefined are left out. */
export function estimateTotals(sample: Pick<ErrorSample, "from" | "until" | "design" | "windows">, key: (event: LogEvent) => string | undefined): Map<string, Estimate> {
  const estimates = new Map<string, Estimate>();
  if (sample.design.windows < 2 || !sample.design.windowMs) return estimates;
  const acc = new Map<string, { y: number; y2: number; windows: number; sampled: number }>();
  for (const window of sample.windows) {
    const inWindow = new Map<string, { y: number; n: number }>();
    window.events.forEach((event, i) => {
      const k = key(event);
      if (k === undefined) return;
      const cell = inWindow.get(k) ?? { y: 0, n: 0 };
      cell.y += weightOf(window, i);
      cell.n++;
      inWindow.set(k, cell);
    });
    for (const [k, { y, n }] of inWindow) {
      const a = acc.get(k) ?? { y: 0, y2: 0, windows: 0, sampled: 0 };
      a.y += y;
      a.y2 += y * y;
      a.windows++;
      a.sampled += n;
      acc.set(k, a);
    }
  }
  for (const [k, a] of acc) estimates.set(k, { ...expand(sample, a.y, a.y2), windows: a.windows, sampled: a.sampled });
  return estimates;
}

/** The period's errors estimated from the windows' exact counts, to compare with the exact total. */
export function estimateCount(sample: Pick<ErrorSample, "from" | "until" | "design" | "windows">): { estimate: number; se: number } {
  if (sample.design.windows < 2 || !sample.design.windowMs) return { estimate: 0, se: 0 };
  return expand(sample, sample.windows.reduce((sum, w) => sum + w.count, 0), sample.windows.reduce((sum, w) => sum + w.count * w.count, 0));
}

/** Seen in enough windows, and precise enough to state. */
export function isReliable(estimate: Estimate): boolean {
  return estimate.estimate > 0 && estimate.windows >= MIN_WINDOWS && estimate.se <= MAX_RSE * estimate.estimate;
}

/** Half-width of the 95% interval. */
export function margin(estimate: Pick<Estimate, "se">): number {
  return Z95 * estimate.se;
}

/** Whether an exact count lies within an estimate's 95% interval. */
export function covers(estimate: Pick<Estimate, "estimate" | "se">, exact: number): boolean {
  return Math.abs(estimate.estimate - exact) <= margin(estimate);
}

export interface EstimateCheck {
  /** Usable estimates whose key has an exact count. */
  checked: number;
  /** Of those, how many intervals held the exact count. */
  inside: number;
  /** The others, furthest out first. */
  misses: Array<{ key: string; estimate: number; se: number; exact: number }>;
}

/** Usable estimates whose key has an exact count, and how many of those counts fall inside the 95% interval. */
export function checkEstimates(estimates: ReadonlyMap<string, Estimate>, exact: ReadonlyMap<string, number>): EstimateCheck {
  const check: EstimateCheck = { checked: 0, inside: 0, misses: [] };
  for (const [key, e] of estimates) {
    const truth = exact.get(key);
    if (truth === undefined || !isReliable(e)) continue;
    check.checked++;
    if (covers(e, truth)) check.inside++;
    else check.misses.push({ key, estimate: e.estimate, se: e.se, exact: truth });
  }
  check.misses.sort((a, b) => Math.abs(b.estimate - b.exact) / b.se - Math.abs(a.estimate - a.exact) / a.se);
  return check;
}

export interface PatternEstimate {
  template: string;
  estimate: number;
  se: number;
  windows: number;
  sampled: number;
  example: string;
  /** Systems in the pattern's sampled errors, largest share first. */
  systems: Array<{ name: string; share: number }>;
  /** Oldest and newest sampled error of the pattern. */
  firstSeen: number;
  lastSeen: number;
}

export interface PatternEstimates {
  /** Usable estimates, largest first. */
  rows: PatternEstimate[];
  /** Estimated errors in the other patterns, each too rare or uneven to estimate. */
  other: number;
  /** Patterns seen in the sample. */
  seen: number;
  /** Sampled errors considered, after skipping. */
  sampled: number;
}

export interface PatternOptions {
  messageFields: readonly string[];
  groupBy: string;
  /** Errors left out, such as those counted exactly elsewhere. */
  skip?: (event: LogEvent) => boolean;
}

/** Errors grouped by message pattern, estimated from the sample. */
export function estimatePatterns(sample: ErrorSample, options: PatternOptions): PatternEstimates {
  const templates = new Map<LogEvent, string>();
  const details = new Map<string, { example: string; systems: Map<string, number>; firstSeen: number; lastSeen: number }>();
  let sampled = 0;
  for (const window of sample.windows) {
    for (const [i, event] of window.events.entries()) {
      if (options.skip?.(event)) continue;
      sampled++;
      const message = extractMessage(event, options.messageFields);
      const template = templateOf(message);
      templates.set(event, template);
      const detail = details.get(template) ?? { example: singleLine(message, 300), systems: new Map(), firstSeen: event.timestamp, lastSeen: event.timestamp };
      const system = fieldText(getField(event, options.groupBy)) ?? `(no ${options.groupBy})`;
      detail.systems.set(system, (detail.systems.get(system) ?? 0) + weightOf(window, i));
      detail.firstSeen = Math.min(detail.firstSeen, event.timestamp);
      detail.lastSeen = Math.max(detail.lastSeen, event.timestamp);
      details.set(template, detail);
    }
  }
  const estimates = estimateTotals(sample, (event) => templates.get(event));
  const rows: PatternEstimate[] = [];
  let other = 0;
  for (const [template, e] of estimates) {
    if (!isReliable(e)) {
      other += e.estimate;
      continue;
    }
    const detail = details.get(template)!;
    const weight = [...detail.systems.values()].reduce((a, b) => a + b, 0);
    const systems = [...detail.systems].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, w]) => ({ name, share: weight ? w / weight : 0 }));
    rows.push({ template, estimate: e.estimate, se: e.se, windows: e.windows, sampled: e.sampled, example: detail.example, systems, firstSeen: detail.firstSeen, lastSeen: detail.lastSeen });
  }
  rows.sort((a, b) => b.estimate - a.estimate);
  return { rows, other, seen: estimates.size, sampled };
}

/** Deterministic uniform numbers in [0, 1) from a 32-bit seed (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
