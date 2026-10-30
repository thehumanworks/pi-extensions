import { formatClock, formatCount, formatPercent, formatRatio } from "../analysis/format.ts";
import { allOf, fieldMatch, median, type HealthRules } from "../analysis/health.ts";
import { extractMessage, fieldText, getField, singleLine, templateOf } from "../analysis/patterns.ts";
import type { FacetResult } from "../sdk/types.ts";
import type { PeriodData, Span } from "./collect.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Systems drawn separately in the errors chart; the rest are "other". */
const CHART_SYSTEMS = 5;

export type FindingSeverity = "critical" | "warning" | "notice" | "info";

export interface Finding {
  severity: FindingSeverity;
  kind: "volume" | "errors" | "stopped" | "quiet" | "new-system" | "growth" | "burst" | "recurring" | "improved" | "new-message" | "chronic";
  title: string;
  detail: string;
  system?: string;
  url?: string;
  /** Ranks findings of the same severity: larger first. */
  weight: number;
}

export interface SystemRow {
  name: string;
  errors: number;
  /** Undefined when the system was not among the listed systems in some buckets. */
  events?: number;
  errorRate?: number;
  previousErrors?: number;
  previousEvents?: number;
  errorSeries: number[];
  eventSeries: Array<number | undefined>;
  peak: { from: number; errors: number };
  flags: string[];
  url: string;
}

export interface MessageRow {
  template: string;
  /** The most frequent exact message of the pattern. */
  term: string;
  count: number;
  /** Fraction of all errors in the timeframe. */
  share: number;
  example: string;
  /** Not among the previous period's most frequent messages. Undefined without a comparison. */
  isNew?: boolean;
  systems: Array<{ name: string; share: number }>;
}

export interface PatternRow {
  template: string;
  /** Errors in the timeframe estimated from the sample. */
  estimate: number;
  share: number;
  sampled: number;
  example: string;
  systems: Array<{ name: string; share: number }>;
  firstSeen: number;
  lastSeen: number;
}

export interface TimelinePoint extends Span {
  events: number;
  errors: number;
  /** Errors of each chart system, in topSystems order. */
  bySystem: number[];
  other: number;
}

export interface Totals {
  events: number;
  errors: number;
  errorRate: number;
}

export interface ReportModel {
  subdomain: string;
  generatedAt: number;
  label: string;
  from: number;
  until: number;
  bucketMs: number;
  previous?: Span;
  /** How the previous period is described, such as "the previous 2 hours". */
  previousLabel?: string;
  /** IANA time zone used for times in the report. */
  timeZone: string;
  /** minErrors is scaled to the timeframe. */
  rules: { scope: string; groupBy: string; errorQuery: string; messageField?: string; spikeRatio: number; minErrors: number };
  /** Some periods listed only the largest systems. */
  truncated: boolean;
  totals: Totals & { systems: number; erroringSystems: number; previous?: Totals };
  timeline: TimelinePoint[];
  topSystems: string[];
  peak?: { from: number; until: number; errors: number; usual: number };
  systems: SystemRow[];
  findings: Finding[];
  /** The most frequent exact messages, grouped by pattern. Exact counts. */
  messages?: { field: string; rows: MessageRow[]; covered: number };
  /** Patterns across all errors, estimated from a sample. */
  patterns: { rows: PatternRow[]; sampled: number };
  notes: string[];
  urls: { errors: string; events: string };
}

export interface AnalyzeContext {
  subdomain: string;
  generatedAt: number;
  searchUrl: (params: { query: string; from: Date; until: Date }) => string;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, warning: 1, notice: 2, info: 3 };

export function analyzePeriod(data: PeriodData, rules: HealthRules, context: AnalyzeContext): ReportModel {
  const { plan, buckets } = data;
  const errorQuery = allOf(rules.scope, rules.errorQuery);
  const url = (query: string, span: Span = plan) => context.searchUrl({ query, from: new Date(span.from), until: new Date(span.until) });
  const length = plan.until - plan.from;
  const previousLabel = plan.previousLabel ?? previousPeriod(length);
  // The minimum is for the health check's 10-minute window; longer spans need more, but less than proportionally,
  // so a short spike inside a long period still shows.
  const minErrors = scaledMinimum(rules.minErrors, length);
  const minBurst = scaledMinimum(rules.minErrors, plan.bucketMs);
  const clock = (time: number) => formatTime(time, plan.bucketMs, spansDays(plan));

  const totals: Totals = rate(sum(buckets.map((b) => b.volume.totalEvents)), sum(buckets.map((b) => b.errors.totalEvents)));
  const previousTotals = data.previous ? rate(data.previous.volume.totalEvents, data.previous.errors.totalEvents) : undefined;

  // Per-system series. Absent from a truncated list means "fewer than the smallest listed", not zero.
  const errorMaps = buckets.map((b) => termMap(b.errors));
  const volumeMaps = buckets.map((b) => termMap(b.volume));
  const names = new Set<string>();
  for (const map of [...errorMaps, ...volumeMaps]) for (const name of map.keys()) names.add(name);
  const previousErrors = data.previous && termMap(data.previous.errors);
  const previousVolume = data.previous && termMap(data.previous.volume);
  const known = (map: Map<string, number> | undefined, facet: FacetResult | undefined, name: string) => map?.get(name) ?? (facet && !facet.truncated ? 0 : undefined);

  const systems: SystemRow[] = [...names].map((name) => {
    const errorSeries = errorMaps.map((map) => map.get(name) ?? 0);
    const eventSeries = volumeMaps.map((map, i) => known(map, buckets[i]!.volume, name));
    const errors = sum(errorSeries);
    const events = eventSeries.every((count) => count !== undefined) ? sum(eventSeries as number[]) : undefined;
    const peakIndex = errorSeries.indexOf(Math.max(...errorSeries));
    return {
      name,
      errors,
      events,
      errorRate: events ? errors / events : undefined,
      previousErrors: known(previousErrors, data.previous?.errors, name),
      previousEvents: known(previousVolume, data.previous?.volume, name),
      errorSeries,
      eventSeries,
      peak: { from: buckets[peakIndex]?.from ?? plan.from, errors: errorSeries[peakIndex] ?? 0 },
      flags: [],
      url: url(allOf(errorQuery, fieldMatch(rules.groupBy, name))),
    };
  });
  systems.sort((a, b) => b.errors - a.errors || (b.events ?? 0) - (a.events ?? 0) || a.name.localeCompare(b.name));

  const topSystems = systems.filter((s) => s.errors > 0).slice(0, CHART_SYSTEMS).map((s) => s.name);
  const timeline = buckets.map((bucket, i) => {
    const bySystem = topSystems.map((name) => errorMaps[i]!.get(name) ?? 0);
    return { from: bucket.from, until: bucket.until, events: bucket.volume.totalEvents, errors: bucket.errors.totalEvents, bySystem, other: Math.max(0, bucket.errors.totalEvents - sum(bySystem)) };
  });
  const errorCounts = timeline.map((point) => point.errors);
  const peakPoint = timeline.length ? timeline.reduce((a, b) => (b.errors > a.errors ? b : a)) : undefined;
  const peak = peakPoint && peakPoint.errors > 0 ? { from: peakPoint.from, until: peakPoint.until, errors: peakPoint.errors, usual: median(errorCounts) } : undefined;

  const patterns = samplePatterns(data, rules, totals.errors);
  const messages = data.messages && rules.messageFields[0] ? exactMessages(data, rules.messageFields[0], totals.errors, patterns.rows) : undefined;

  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);

  // Account-wide changes.
  if (previousTotals) {
    if (previousTotals.events >= 1000 && totals.events <= previousTotals.events * 0.5) {
      add({ severity: "critical", kind: "volume", title: `Log volume down ${formatPercent(1 - totals.events / previousTotals.events)}`, detail: `${formatCount(totals.events)} events, against ${formatCount(previousTotals.events)} in ${previousLabel}. Check ingestion before reading anything else.`, weight: previousTotals.events, url: url(allOf(rules.scope)) });
    }
    const errorRatio = previousTotals.errors ? totals.errors / previousTotals.errors : Infinity;
    if (totals.errors - previousTotals.errors >= minErrors && errorRatio >= 1.5) {
      add({ severity: "warning", kind: "errors", title: `Errors up ${previousTotals.errors ? formatPercent(errorRatio - 1) : "from none"}`, detail: `${formatCount(totals.errors)} errors, against ${formatCount(previousTotals.errors)} in ${previousLabel}.`, weight: totals.errors - previousTotals.errors, url: url(errorQuery) });
    } else if (previousTotals.errors >= minErrors && errorRatio <= 2 / 3) {
      add({ severity: "info", kind: "errors", title: `Errors down ${formatPercent(1 - errorRatio)}`, detail: `${formatCount(totals.errors)} errors, against ${formatCount(previousTotals.errors)} in ${previousLabel}.`, weight: previousTotals.errors - totals.errors, url: url(errorQuery) });
    }
  }

  // Volume per bucket that counts as a busy system: the health check's threshold, scaled from its 10-minute window.
  const busyPerBucket = rules.silentMinBaseline * (plan.bucketMs / (10 * MINUTE_MS));
  const chronic: SystemRow[] = [];
  const recurring: Finding[] = [];
  for (const system of systems) {
    const name = system.name;
    const flag = (text: string) => system.flags.push(text);
    // Stopped: busy, then silent at the end for longer than any earlier gap, so bursty systems are not flagged.
    const silence = finalSilence(system.eventSeries);
    const before = system.eventSeries.slice(0, system.eventSeries.length - silence.length).filter((count): count is number => count !== undefined);
    if (buckets.length >= 4 && silence.length >= 2 && silence.length > silence.longestEarlierGap && before.length && median(before) >= busyPerBucket) {
      const since = buckets[buckets.length - silence.length]!.from;
      flag("stopped");
      const what = silence.events ? `Only ${formatCount(silence.events)} events` : "No events";
      add({ severity: "critical", kind: "stopped", system: name, title: `${name} stopped logging`, detail: `${what} since ${clock(since)}; it usually logs about ${formatCount(median(before))} ${per(plan.bucketMs)}.`, weight: median(before), url: url(allOf(rules.scope, fieldMatch(rules.groupBy, name))) });
    } else if (system.previousEvents !== undefined && system.previousEvents >= busyPerBucket * buckets.length && system.events !== undefined && system.events <= system.previousEvents * rules.silentRatio) {
      flag("quiet");
      add({ severity: "warning", kind: "quiet", system: name, title: `${name} went quiet`, detail: `${formatCount(system.events)} events, against ${formatCount(system.previousEvents)} in ${previousLabel} (down ${formatPercent(1 - system.events / system.previousEvents)}).`, weight: system.previousEvents, url: url(allOf(rules.scope, fieldMatch(rules.groupBy, name))) });
    }
    if (system.errors === 0) continue;
    const peakText = `Peak ${formatCount(system.peak.errors)} at ${clock(system.peak.from)}.`;
    let changed = false;
    if (system.previousErrors === 0 && system.errors >= minErrors) {
      changed = true;
      flag("new");
      add({ severity: system.errors >= minErrors * 10 ? "critical" : "warning", kind: "new-system", system: name, title: `${name} started logging errors`, detail: `${formatCount(system.errors)} errors; none in ${previousLabel}. ${peakText}`, weight: system.errors, url: system.url });
    } else if (system.previousErrors && system.errors - system.previousErrors >= minErrors && system.errors / system.previousErrors >= rules.spikeRatio) {
      const ratio = system.errors / system.previousErrors;
      changed = true;
      flag(formatRatio(ratio));
      // Critical needs a large ratio and a large number: ×13 on 6 errors is worth a look, not an alarm.
      const critical = ratio >= rules.criticalRatio && system.errors - system.previousErrors >= minErrors * 10;
      add({ severity: critical ? "critical" : "warning", kind: "growth", system: name, title: `${name} errors ${formatRatio(ratio)}`, detail: `${formatCount(system.errors)} errors, against ${formatCount(system.previousErrors)} in ${previousLabel}. ${peakText}`, weight: system.errors - system.previousErrors, url: system.url });
    } else if (system.previousErrors !== undefined && system.previousErrors >= minErrors * 2 && system.errors <= system.previousErrors / rules.spikeRatio) {
      add({ severity: "info", kind: "improved", system: name, title: `${name} errors down ${formatPercent(1 - system.errors / system.previousErrors)}`, detail: `${formatCount(system.errors)} errors, against ${formatCount(system.previousErrors)} in ${previousLabel}.`, weight: system.previousErrors - system.errors, url: system.url });
    }
    if (!changed && buckets.length >= 6 && system.peak.errors >= minBurst) {
      const usual = median(system.errorSeries);
      const threshold = Math.max(rules.spikeRatio * Math.max(usual, 1), minBurst / 2);
      if (system.peak.errors >= threshold && system.peak.errors - usual >= minBurst) {
        const bursts = system.errorSeries.filter((count) => count >= threshold).length;
        if (bursts >= 3) {
          flag("bursts");
          recurring.push({ severity: "notice", kind: "recurring", system: name, title: `${name} has recurring error bursts`, detail: `${bursts} of ${buckets.length} periods of ${formatSpan(plan.bucketMs)} had ${formatCount(Math.ceil(threshold))} errors or more; usually ${formatCount(usual)}. ${peakText}`, weight: system.peak.errors, url: system.url });
        } else {
          flag("burst");
          add({ severity: "warning", kind: "burst", system: name, title: `${name} error burst at ${clock(system.peak.from)}`, detail: `${formatCount(system.peak.errors)} errors in ${formatSpan(plan.bucketMs)}; usually ${formatCount(usual)} ${per(plan.bucketMs)}.`, weight: system.peak.errors - usual, url: url(allOf(errorQuery, fieldMatch(rules.groupBy, name)), { from: system.peak.from, until: system.peak.from + plan.bucketMs }) });
        }
      }
    }
    if (system.errorRate !== undefined && system.errors >= minErrors && system.errorRate >= rules.chronicErrorRate) {
      flag("chronic");
      chronic.push(system);
    }
  }
  // Ongoing patterns are context, not news: only the largest few.
  for (const finding of recurring.sort((a, b) => b.weight - a.weight).slice(0, 5)) add(finding);
  for (const system of chronic.slice(0, 5)) {
    add({ severity: "notice", kind: "chronic", system: system.name, title: `${system.name}: ${formatPercent(system.errorRate!)} of events are errors`, detail: `${formatCount(system.errors)} errors in ${formatCount(system.events!)} events.`, weight: system.errors, url: system.url });
  }

  if (messages && data.previous?.messages) {
    for (const row of messages.rows.filter((m) => m.isNew && m.count >= minErrors).slice(0, 5)) {
      const where = row.systems[0] ? `, mostly ${row.systems[0].name}` : "";
      add({ severity: "warning", kind: "new-message", title: `New error message: “${row.template}”`, detail: `${formatCount(row.count)} times${where}; not among the most frequent messages in ${previousLabel}.`, weight: row.count, url: url(allOf(errorQuery, fieldMatch(rules.messageFields[0]!, row.term))) });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.weight - a.weight);
  const truncated = buckets.some((b) => b.errors.truncated || b.volume.truncated);

  return {
    subdomain: context.subdomain,
    generatedAt: context.generatedAt,
    label: plan.label,
    from: plan.from,
    until: plan.until,
    bucketMs: plan.bucketMs,
    previous: plan.previous,
    previousLabel: plan.previousLabel,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rules: { scope: rules.scope, groupBy: rules.groupBy, errorQuery: rules.errorQuery, messageField: rules.messageFields[0], spikeRatio: rules.spikeRatio, minErrors },
    totals: { ...totals, systems: systems.filter((s) => (s.events ?? 0) > 0 || s.errors > 0).length, erroringSystems: systems.filter((s) => s.errors > 0).length, previous: previousTotals },
    timeline,
    topSystems,
    peak,
    systems,
    findings,
    messages,
    patterns,
    truncated,
    notes: [...plan.notes, ...(truncated ? [`Loggly lists at most ${rules.maxSystems} systems per period, so the smallest systems are counted in totals but may be missing from tables.`] : [])],
    urls: { errors: url(errorQuery), events: url(allOf(rules.scope)) },
  };
}

/** The health check's per-10-minute minimum, scaled by the square root of a longer span: 50 → 173 for 2 hours, 1,587 for a week. */
export function scaledMinimum(minimum: number, spanMs: number): number {
  return Math.round(minimum * Math.sqrt(Math.max(1, spanMs / (10 * MINUTE_MS))));
}

/** Error patterns estimated from each bucket's sample, weighted by the bucket's error count. */
function samplePatterns(data: PeriodData, rules: HealthRules, totalErrors: number): ReportModel["patterns"] {
  const groups = new Map<string, { row: PatternRow; systems: Map<string, number> }>();
  let sampled = 0;
  for (const bucket of data.buckets) {
    if (!bucket.sample.length) continue;
    const weight = bucket.errors.totalEvents / bucket.sample.length;
    for (const event of bucket.sample) {
      sampled++;
      const message = extractMessage(event, rules.messageFields);
      const template = templateOf(message);
      let group = groups.get(template);
      if (!group) {
        group = { row: { template, estimate: 0, share: 0, sampled: 0, example: singleLine(message, 300), systems: [], firstSeen: event.timestamp, lastSeen: event.timestamp }, systems: new Map() };
        groups.set(template, group);
      }
      group.row.estimate += weight;
      group.row.sampled++;
      group.row.firstSeen = Math.min(group.row.firstSeen, event.timestamp);
      group.row.lastSeen = Math.max(group.row.lastSeen, event.timestamp);
      const system = fieldText(getField(event, rules.groupBy)) ?? `(no ${rules.groupBy})`;
      group.systems.set(system, (group.systems.get(system) ?? 0) + weight);
    }
  }
  const rows = [...groups.values()].map(({ row, systems }) => ({
    ...row,
    estimate: Math.round(row.estimate),
    share: totalErrors ? row.estimate / totalErrors : 0,
    systems: topShares(systems, row.estimate),
  }));
  rows.sort((a, b) => b.estimate - a.estimate);
  return { rows: rows.slice(0, 25), sampled };
}

/** Exact message counts grouped by pattern, with systems taken from the sample when the pattern was sampled. */
function exactMessages(data: PeriodData, field: string, totalErrors: number, sampled: readonly PatternRow[]): NonNullable<ReportModel["messages"]> {
  const previous = data.previous?.messages ? new Set(data.previous.messages.terms.map((term) => templateOf(term.term))) : undefined;
  const bySample = new Map(sampled.map((row) => [row.template, row.systems]));
  const groups = new Map<string, MessageRow>();
  for (const term of data.messages!.terms) {
    const template = templateOf(term.term);
    const group = groups.get(template);
    if (group) group.count += term.count;
    else groups.set(template, { template, term: term.term, count: term.count, share: 0, example: singleLine(term.term, 300), isNew: previous ? !previous.has(template) : undefined, systems: bySample.get(template) ?? [] });
  }
  const rows = [...groups.values()].map((row) => ({ ...row, share: totalErrors ? row.count / totalErrors : 0 })).sort((a, b) => b.count - a.count);
  return { field, rows: rows.slice(0, 25), covered: sum(data.messages!.terms.map((term) => term.count)) };
}

function topShares(counts: Map<string, number>, total: number, limit = 3): Array<{ name: string; share: number }> {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, share: total ? count / total : 0 }));
}

function termMap(facet: FacetResult): Map<string, number> {
  return new Map(facet.terms.map((term) => [term.term, term.count]));
}

/**
 * The run of near-silent periods at the end of a series (under 1% of its
 * median), its events, and the longest such run before it.
 */
export function finalSilence(series: ReadonlyArray<number | undefined>): { length: number; events: number; longestEarlierGap: number } {
  const known = series.filter((count): count is number => count !== undefined);
  const quiet = (count: number | undefined) => count !== undefined && count <= median(known) * 0.01;
  let length = 0;
  let events = 0;
  for (let i = series.length - 1; i >= 0 && quiet(series[i]); i--) {
    length++;
    events += series[i]!;
  }
  let longestEarlierGap = 0;
  let run = 0;
  for (const count of series.slice(0, series.length - length)) {
    run = quiet(count) ? run + 1 : 0;
    longestEarlierGap = Math.max(longestEarlierGap, run);
  }
  return { length, events, longestEarlierGap };
}

function rate(events: number, errors: number): Totals {
  return { events, errors, errorRate: events ? errors / events : 0 };
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** "1 hour", "24 hours", "7 days", "5 minutes", "11 hours 35 minutes", "2 days 6 hours". */
export function formatSpan(ms: number): string {
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;
  const minutes = Math.round(ms / MINUTE_MS);
  if (ms >= 2 * DAY_MS || (ms % DAY_MS === 0 && ms > 0)) {
    const hours = Math.round((ms % DAY_MS) / HOUR_MS);
    return hours ? `${unit(Math.floor(ms / DAY_MS), "day")} ${unit(hours, "hour")}` : unit(Math.floor(ms / DAY_MS), "day");
  }
  if (minutes >= 60) return minutes % 60 ? `${unit(Math.floor(minutes / 60), "hour")} ${unit(minutes % 60, "minute")}` : unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

/** "per hour", "per 5 minutes". */
export function per(ms: number): string {
  const span = formatSpan(ms);
  return `per ${span.startsWith("1 ") ? span.slice(2) : span}`;
}

/** "the previous hour", "the previous 2 hours". */
export function previousPeriod(ms: number): string {
  const span = formatSpan(ms);
  return `the previous ${span.startsWith("1 ") ? span.slice(2) : span}`;
}

/** True when a period crosses local midnight, so times need their date. */
export function spansDays(span: Span): boolean {
  return new Date(span.from).toDateString() !== new Date(span.until - 1).toDateString();
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local "Fri 30 Oct", or "Fri 30 Oct 2026". Built by hand: locale formats differ between ICU versions. */
export function formatDay(time: number, withYear = false): string {
  const d = new Date(time);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ""}`;
}

/** Local time: "14:05", "14:05 Wed 29 Oct" when the report spans days, "Wed 29 Oct" for daily periods. */
export function formatTime(time: number, bucketMs: number, withDate: boolean): string {
  if (bucketMs >= DAY_MS) return formatDay(time);
  return withDate ? `${formatClock(time)} ${formatDay(time)}` : formatClock(time);
}
