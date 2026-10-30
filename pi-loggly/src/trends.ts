import { mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatCount, formatPercent, sparkline } from "./analysis/format.ts";
import { allOf, type HealthRules } from "./analysis/health.ts";
import { fieldText, getField, singleLine, templateOf } from "./analysis/patterns.ts";
import { checkEstimates, covers, estimatePatterns, estimateTotals, margin, sampleErrors, type SampleDesign } from "./analysis/sampling.ts";
import type { LogglyClient } from "./sdk/client.ts";
import type { FacetTerm, LogEvent } from "./sdk/types.ts";

const DAY_MS = 86_400_000;
/** Loggly needs a little time to index the end of a day. */
const SETTLE_MS = 30 * 60_000;
/** A lock older than this belongs to a process that died. Refreshed after each day. */
const LOCK_STALE_MS = 15 * 60_000;
/** Loggly's shortest plan keeps 7 days; used when the account does not say. */
const FALLBACK_RETENTION_DAYS = 7;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
/** Estimated patterns saved per day. */
const PATTERN_LIMIT = 100;
/** Misses of the sample check saved per day. */
const MISS_LIMIT = 5;
/** Earlier files of days saved again, under the trends directory. */
const REPLACED_DIR = "replaced";
/** Refresh the lock this often while a day is sampled. */
const LOCK_REFRESH_MS = 60_000;

/** The rules a day was captured with. Days captured with other rules are not compared. */
export interface TrendRules {
  scope: string;
  groupBy: string;
  errorQuery: string;
  messageField?: string;
}

/** One UTC day of counts, saved as trends/<day>.json. */
export interface TrendDay {
  version: 1;
  /** UTC date, YYYY-MM-DD. */
  day: string;
  collectedAt: string;
  rules: TrendRules;
  /** Exact totals for the day. */
  totals: { events: number; errors: number };
  /** Events and errors for the 300 largest systems by events and the 300 largest by errors. */
  systems: Record<string, { events: number; errors: number }>;
  /** More systems existed than were saved. */
  truncated: boolean;
  /** Error message templates with exact counts, from the 300 most frequent exact messages. */
  messages: Array<{ template: string; count: number; example: string }>;
  /** Errors covered by those 300 messages. */
  messagesCovered: number;
  /** Patterns of the errors outside those messages, estimated from a sample. Absent when sampling was off. */
  patterns?: TrendPatterns;
}

/**
 * Error patterns estimated from random windows of the day (see
 * analysis/sampling.ts), for the errors the exact messages do not cover:
 * those without the message field and those with rarer messages.
 */
export interface TrendPatterns {
  design: SampleDesign;
  /** Errors outside the exact messages, exactly. The patterns divide these. */
  errors: number;
  /** Sampled errors among them. */
  sampled: number;
  /** Patterns seen in at least 10 windows and estimated to within 30%, largest first: errors and standard errors. */
  rows: Array<{ template: string; estimate: number; se: number; windows: number; example: string; systems: Array<{ name: string; share: number }> }>;
  /** Estimated errors in other patterns, each too rare or uneven to estimate. */
  other: number;
  /** The sample's estimate of `errors`; its 95% interval should hold the exact count. */
  estimated: { estimate: number; se: number };
  /**
   * The same sample's estimates of counts Loggly knows exactly (systems and
   * listed messages): how many were usable, how many 95% intervals held the
   * exact count, and the worst misses.
   */
  check: { checked: number; inside: number; misses: Array<{ name: string; estimate: number; se: number; exact: number }> };
}

export interface TrendUpdate {
  /** Days captured by this update, oldest first. */
  captured: string[];
  /** Of those, days saved before whose earlier file was moved to replaced/. */
  replaced: string[];
  /** All stored days, oldest first. */
  stored: string[];
  /** Another process held the lock, so nothing was captured. */
  busy: boolean;
}

export type TrendClient = Pick<LogglyClient, "facet" | "account" | "search" | "count">;

export interface UpdateOptions {
  /**
   * Also save again the days Loggly still keeps that were saved with other
   * rules, or without pattern estimates while sampling is on. Earlier files
   * are moved to replaced/, not deleted.
   */
  replace?: boolean;
  /** Estimate patterns for the days saved, when trends.sampleWindows is on. Default true. */
  sample?: boolean;
  onProgress?: (progress: { day: string; done: number; days: number }) => void;
}

export interface CaptureOptions {
  signal?: AbortSignal;
  now?: number;
  /** Random windows to sample for error patterns; 0 or undefined skips them. */
  sampleWindows?: number;
  seed?: number;
  onWindow?: () => void;
}

export function defaultTrendsDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-loggly", "trends");
}

export function trendRules(rules: HealthRules): TrendRules {
  const result: TrendRules = { scope: rules.scope, groupBy: rules.groupBy, errorQuery: rules.errorQuery };
  if (rules.messageFields[0]) result.messageField = rules.messageFields[0];
  return result;
}

/** Whether counts from two days are comparable: the same systems and the same definition of an error. */
export function comparableRules(a: TrendRules, b: TrendRules): boolean {
  return a.scope === b.scope && a.groupBy === b.groupBy && a.errorQuery === b.errorQuery;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Complete UTC days whose events are all still in Loggly, oldest first. */
export function capturableDays(now: number, retentionDays: number): string[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const days: string[] = [];
  // The oldest day starts a day inside retention; the newest has ended and settled.
  for (let start = today - (retentionDays - 1) * DAY_MS; start + DAY_MS + SETTLE_MS <= now; start += DAY_MS) days.push(isoDay(start));
  return days;
}

/** The newest UTC day that has ended and settled. */
export function latestCompleteDay(now: number): string {
  return isoDay(Math.floor((now - SETTLE_MS - DAY_MS) / DAY_MS) * DAY_MS);
}

/**
 * Count one day: errors and events by system and the most frequent error
 * messages, in three requests. Then, when asked, estimate the patterns of the
 * errors those messages leave out from random windows, about one request per
 * window.
 */
export async function captureDay(client: Pick<LogglyClient, "facet" | "search" | "count">, rules: HealthRules, day: string, options: CaptureOptions = {}): Promise<TrendDay> {
  const from = new Date(`${day}T00:00:00.000Z`);
  const range = { from, until: new Date(from.getTime() + DAY_MS), size: 300 };
  const r = trendRules(rules);
  const errorQuery = allOf(r.scope, r.errorQuery);
  const signal = options.signal;
  const [errors, volume, messages] = await Promise.all([
    client.facet(r.groupBy, { ...range, query: errorQuery }, { signal }),
    client.facet(r.groupBy, { ...range, query: allOf(r.scope) }, { signal }),
    r.messageField ? client.facet(r.messageField, { ...range, query: errorQuery }, { signal }) : undefined,
  ]);
  // A Map, since system names are log data and may be any string.
  const systems = new Map<string, { events: number; errors: number }>();
  for (const term of volume.terms) systems.set(term.term, { events: term.count, errors: 0 });
  for (const term of errors.terms) {
    const counts = systems.get(term.term) ?? { events: 0, errors: 0 };
    counts.errors = term.count;
    systems.set(term.term, counts);
  }
  const record: TrendDay = {
    version: 1,
    day,
    collectedAt: new Date(options.now ?? Date.now()).toISOString(),
    rules: r,
    totals: { events: volume.totalEvents, errors: errors.totalEvents },
    systems: Object.fromEntries(systems),
    truncated: volume.truncated || errors.truncated,
    messages: groupMessages(messages?.terms ?? []),
    messagesCovered: (messages?.terms ?? []).reduce((sum, term) => sum + term.count, 0),
  };
  if (options.sampleWindows && errors.totalEvents > 0) {
    const sample = await sampleErrors(client, errorQuery, range.from.getTime(), range.until.getTime(), errors.totalEvents, { windows: options.sampleWindows, seed: options.seed, signal, onWindow: options.onWindow });
    // Errors with a listed message are counted exactly; only the rest are estimated.
    const listed = new Set((messages?.terms ?? []).map((term) => term.term));
    const isListed = (event: LogEvent) => {
      const value = r.messageField ? fieldText(getField(event, r.messageField)) : undefined;
      return value !== undefined && listed.has(value);
    };
    const estimated = estimatePatterns(sample, { messageFields: rules.messageFields, groupBy: r.groupBy, skip: isListed });
    const rest = estimateTotals(sample, (event) => (isListed(event) ? undefined : "rest")).get("rest");
    // The same sample also estimates counts Loggly knows exactly; how often their intervals hold them shows whether the estimates can be trusted.
    const checks = [checkEstimates(estimateTotals(sample, (event) => fieldText(getField(event, r.groupBy))), termCounts(errors.terms))];
    if (r.messageField && messages) checks.push(checkEstimates(estimateTotals(sample, (event) => fieldText(getField(event, r.messageField!))), termCounts(messages.terms)));
    const misses = checks.flatMap((check) => check.misses).sort((a, b) => Math.abs(b.estimate - b.exact) / b.se - Math.abs(a.estimate - a.exact) / a.se);
    record.patterns = {
      design: sample.design,
      errors: errors.totalEvents - record.messagesCovered,
      sampled: estimated.sampled,
      rows: estimated.rows.slice(0, PATTERN_LIMIT).map((row) => ({
        template: row.template,
        estimate: Math.round(row.estimate),
        se: Math.round(row.se),
        windows: row.windows,
        example: row.example,
        systems: row.systems.map((s) => ({ name: s.name, share: Math.round(s.share * 1000) / 1000 })),
      })),
      other: Math.round(estimated.other + estimated.rows.slice(PATTERN_LIMIT).reduce((sum, row) => sum + row.estimate, 0)),
      estimated: { estimate: Math.round(rest?.estimate ?? 0), se: Math.round(rest?.se ?? 0) },
      check: {
        checked: checks.reduce((sum, c) => sum + c.checked, 0),
        inside: checks.reduce((sum, c) => sum + c.inside, 0),
        misses: misses.slice(0, MISS_LIMIT).map((miss) => ({ name: singleLine(miss.key, 120), estimate: Math.round(miss.estimate), se: Math.round(miss.se), exact: miss.exact })),
      },
    };
  }
  return record;
}

function termCounts(terms: readonly FacetTerm[]): Map<string, number> {
  return new Map(terms.map((term) => [term.term, term.count]));
}

function groupMessages(terms: readonly FacetTerm[], limit = 60): TrendDay["messages"] {
  const groups = new Map<string, TrendDay["messages"][number]>();
  for (const term of [...terms].sort((a, b) => b.count - a.count)) {
    const template = templateOf(term.term);
    const group = groups.get(template);
    if (group) group.count += term.count;
    else groups.set(template, { template, count: term.count, example: singleLine(term.term, 300) });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * Saves a file per complete day still in Loggly, so trends outlive its
 * retention. Updates are cheap when nothing is missing (no requests), are
 * joined within a process and locked across processes.
 */
export class TrendRecorder {
  readonly dir: string;
  readonly #getClient: () => TrendClient;
  readonly #getRules: () => HealthRules;
  readonly #getSampleWindows: () => number;
  readonly #now: () => number;
  #retentionDays?: number;
  #inflight?: { promise: Promise<TrendUpdate>; replace: boolean; sample: boolean };

  constructor(dir: string, deps: { getClient: () => TrendClient; getRules: () => HealthRules; getSampleWindows?: () => number; now?: () => number }) {
    this.dir = dir;
    this.#getClient = deps.getClient;
    this.#getRules = deps.getRules;
    this.#getSampleWindows = deps.getSampleWindows ?? (() => 0);
    this.#now = deps.now ?? Date.now;
  }

  get running(): boolean {
    return this.#inflight !== undefined;
  }

  /** Days Loggly keeps, once an update has asked. */
  get retentionDays(): number | undefined {
    return this.#retentionDays;
  }

  /**
   * Complete days newer than the newest saved one, without asking Loggly.
   * Undefined when nothing is saved yet.
   */
  async waitingDays(): Promise<number | undefined> {
    let days: string[];
    try {
      days = [...(await storedDays(this.dir))].sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const newest = days.at(-1);
    if (!newest) return undefined;
    return Math.max(0, Math.round((Date.parse(latestCompleteDay(this.#now())) - Date.parse(newest)) / DAY_MS));
  }

  /**
   * Capture every missing day Loggly still keeps, oldest first so days about
   * to leave Loggly come first. With `replace`, also save again the days it
   * keeps that are out of date (see UpdateOptions). Days Loggly no longer
   * keeps are never replaced. A running update is joined, unless this one
   * replaces or samples and that one does not: then this one follows it.
   */
  update(signal?: AbortSignal, options: UpdateOptions = {}): Promise<TrendUpdate> {
    const replace = !!options.replace;
    const sample = options.sample ?? true;
    if (this.#inflight && (this.#inflight.replace || !replace) && (this.#inflight.sample || !sample)) return this.#inflight.promise;
    const before = this.#inflight?.promise.catch(() => undefined);
    const promise: Promise<TrendUpdate> = (async () => {
      const earlier = await before;
      const update = await this.#update(signal, replace, sample, options.onProgress);
      // Report what the update it followed saved too.
      return earlier ? { ...update, captured: [...earlier.captured, ...update.captured].sort(), replaced: [...earlier.replaced, ...update.replaced].sort() } : update;
    })().finally(() => {
      if (this.#inflight?.promise === promise) this.#inflight = undefined;
    });
    this.#inflight = { promise, replace, sample };
    return promise;
  }

  async #update(signal: AbortSignal | undefined, replace: boolean, sample: boolean, onProgress: UpdateOptions["onProgress"]): Promise<TrendUpdate> {
    const now = this.#now();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const sampleWindows = sample ? this.#getSampleWindows() : 0;
    const rules = trendRules(this.#getRules());
    // Without replacing, only file names matter, so the frequent background check reads no files.
    const load = async () => (replace ? savedDays(this.dir) : new Map([...(await storedDays(this.dir))].map((day) => [day, undefined])));
    const isDue = (saved: Map<string, SavedDay | undefined>) => (day: string) => {
      if (!saved.has(day)) return true;
      if (!replace) return false;
      const record = saved.get(day);
      return !record?.rules || !comparableRules(record.rules, rules) || (!!sampleWindows && !record.patterns);
    };
    let saved = await load();
    if (this.#retentionDays !== undefined && !capturableDays(now, this.#retentionDays).some(isDue(saved))) {
      return { captured: [], replaced: [], stored: [...saved.keys()].sort(), busy: false };
    }
    const lock = await acquireLock(join(this.dir, ".lock"));
    if (!lock) return { captured: [], replaced: [], stored: [...saved.keys()].sort(), busy: true };
    const captured: string[] = [];
    const replaced: string[] = [];
    try {
      const client = this.#getClient();
      this.#retentionDays ??= (await client.account({ signal })).retentionDays ?? FALLBACK_RETENTION_DAYS;
      // Another process may have saved days while this one waited.
      saved = await load();
      const due = capturableDays(now, this.#retentionDays).filter(isDue(saved));
      let refreshed = Date.now();
      // Sampling a day takes minutes: keep the lock fresh meanwhile.
      const onWindow = () => {
        if (Date.now() - refreshed < LOCK_REFRESH_MS) return;
        refreshed = Date.now();
        void lock.refresh();
      };
      for (const day of due) {
        signal?.throwIfAborted();
        onProgress?.({ day, done: captured.length, days: due.length });
        const record = await captureDay(client, this.#getRules(), day, { signal, now, sampleWindows, onWindow });
        if (saved.has(day) && (await moveAside(this.dir, day))) replaced.push(day);
        await writeDay(this.dir, record);
        captured.push(day);
        await lock.refresh();
      }
    } finally {
      await lock.release();
    }
    return { captured, replaced, stored: [...new Set([...saved.keys(), ...captured])].sort(), busy: false };
  }
}

/** Read every saved day, oldest first. Unreadable files are counted, not fatal. */
export async function loadTrends(dir: string): Promise<{ days: TrendDay[]; unreadable: number }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { days: [], unreadable: 0 };
    throw error;
  }
  const days: TrendDay[] = [];
  let unreadable = 0;
  for (const name of names.filter((n) => DAY_FILE.test(n)).sort()) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8")) as unknown;
      if (isTrendDay(record)) days.push(record);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return { days, unreadable };
}

async function storedDays(dir: string): Promise<Set<string>> {
  return new Set((await readdir(dir)).map((name) => DAY_FILE.exec(name)?.[1]).filter((day): day is string => !!day));
}

interface SavedDay {
  /** Undefined when the file cannot be read. */
  rules?: TrendRules;
  patterns: boolean;
}

/** What each saved day was captured with. */
async function savedDays(dir: string): Promise<Map<string, SavedDay>> {
  const saved = new Map<string, SavedDay>();
  for (const day of await storedDays(dir)) {
    try {
      const record = JSON.parse(await readFile(join(dir, `${day}.json`), "utf8")) as unknown;
      saved.set(day, isTrendDay(record) ? { rules: record.rules, patterns: !!record.patterns } : { patterns: false });
    } catch {
      saved.set(day, { patterns: false });
    }
  }
  return saved;
}

/** Move a day's file to replaced/<day>.<time>.json, keeping it. False when there was none. */
async function moveAside(dir: string, day: string): Promise<boolean> {
  const target = join(dir, REPLACED_DIR);
  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    await rename(join(dir, `${day}.json`), join(target, `${day}.${Date.now()}.json`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeDay(dir: string, record: TrendDay): Promise<void> {
  const path = join(dir, `${record.day}.json`);
  const temp = `${path}.${process.pid}.tmp`;
  // Message examples are log data: keep files private.
  await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function acquireLock(path: string): Promise<{ refresh: () => Promise<void>; release: () => Promise<void> } | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return {
        refresh: () => utimes(path, new Date(), new Date()).catch(() => {}),
        release: () => rm(path, { force: true }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs < LOCK_STALE_MS) return undefined;
      await rm(path, { force: true });
    }
  }
  return undefined;
}

function isTrendDay(value: unknown): value is TrendDay {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<TrendDay>;
  return record.version === 1 && typeof record.day === "string" && typeof record.rules === "object" && typeof record.totals === "object" &&
    typeof record.systems === "object" && Array.isArray(record.messages) && (record.patterns === undefined || Array.isArray(record.patterns?.rows));
}

export interface TrendReportOptions {
  /** Days to report, ending yesterday. */
  days: number;
  /** Report one system's daily counts. */
  system?: string;
  /** Report error message templates containing this text (case-insensitive). */
  message?: string;
  /** Rows per list. */
  top: number;
  now: number;
}

interface Series {
  name: string;
  values: number[];
  recent: number;
  previous?: number;
  firstDay?: string;
  example?: string;
}

/** A plain-text report of saved daily trends, comparing the latest days with the days before. */
export function formatTrendReport(all: readonly TrendDay[], rules: TrendRules, options: TrendReportOptions): { text: string; data: Record<string, unknown> } {
  const today = Math.floor(options.now / DAY_MS) * DAY_MS;
  const range = Array.from({ length: options.days }, (_, index) => isoDay(today - (options.days - index) * DAY_MS));
  const comparable = all.filter((day) => comparableRules(day.rules, rules));
  const byDay = new Map(comparable.map((day) => [day.day, day]));
  const days = range.map((day) => byDay.get(day)).filter((day): day is TrendDay => !!day);
  const missing = range.filter((day) => !byDay.has(day));
  const excluded = all.filter((day) => !comparableRules(day.rules, rules) && range.includes(day.day)).length;
  const lines = [`Daily Loggly trends saved on this machine: ${days.length} of ${options.days} UTC days stored${days.length ? `, ${days[0]!.day} to ${days.at(-1)!.day}` : ""}.`];
  if (!days.length) {
    lines.push("Run /loggly trends to save every day Loggly still keeps, and /loggly trends every <days> to keep saving them at Pi start.");
    if (excluded) lines.push(`${excluded} saved days used other health rules (scope, groupBy or errorQuery) and are not compared. /loggly trends saves again those Loggly still keeps.`);
    return { text: lines.join("\n"), data: { days: [], missing } };
  }
  lines.push(`Systems are ${rules.groupBy} values within ${rules.scope}; errors match ${rules.errorQuery}.`);
  if (missing.length) lines.push(`Days not saved: ${compactDays(missing)}. /loggly trends saves any that Loggly still keeps.`);
  if (excluded) lines.push(`${excluded} days saved with other health rules are not compared. /loggly trends saves again those Loggly still keeps; earlier files go to replaced/.`);
  // Compare the latest week with the week before, or halves of a shorter range.
  const window = Math.min(7, Math.floor(days.length / 2));
  const compare = window > 0 ? `last ${plural(window, "saved day")} vs the ${window} before` : "";
  const series = (name: string, values: number[], extra: Partial<Series> = {}): Series => ({
    name, values,
    recent: average(values.slice(-Math.max(window, 1))),
    previous: window ? average(values.slice(-2 * window, -window)) : undefined,
    ...extra,
  });
  const describe = (s: Series) => `${formatCount(s.recent)}/day${s.previous !== undefined ? ` (${change(s.recent, s.previous)})` : ""} ${sparkline(s.values)}`;

  const totalErrors = series("errors", days.map((day) => day.totals.errors));
  const totalEvents = series("events", days.map((day) => day.totals.events));
  lines.push(`All systems: errors ${describe(totalErrors)}; events ${describe(totalEvents)}.${compare ? ` Changes compare the ${compare}.` : ""}`);
  const data: Record<string, unknown> = { days: days.map((day) => day.day), missing, totals: days.map((day) => ({ day: day.day, ...day.totals })) };

  if (options.system) {
    const counts = days.map((day) => systemCounts(day, options.system!));
    lines.push("", `${options.system}: errors ${describe(series("errors", counts.map((c) => c?.errors ?? 0)))}; events ${describe(series("events", counts.map((c) => c?.events ?? 0)))}`);
    lines.push("  day          events      errors   err%");
    for (const [index, day] of days.entries()) {
      const c = counts[index];
      lines.push(`  ${day.day}  ${pad(c ? formatCount(c.events) : "–", 10)}  ${pad(c ? formatCount(c.errors) : "–", 10)}  ${pad(c?.events ? formatPercent(c.errors / c.events) : "–", 5)}`);
    }
    if (counts.some((c) => !c) && days.some((day) => day.truncated)) lines.push("  – means not among the day's 300 largest systems, or no events.");
    data.system = { name: options.system, days: days.map((day, index) => ({ day: day.day, ...(counts[index] ?? { events: 0, errors: 0 }) })) };
    return { text: lines.join("\n"), data };
  }

  const messageSeries = messageTrends(days).map((m) => series(m.template, m.values, { firstDay: m.firstDay, example: m.example }));
  if (options.message) {
    const needle = options.message.toLowerCase();
    const matches = messageSeries.filter((m) => m.name.toLowerCase().includes(needle) || m.example?.toLowerCase().includes(needle)).sort((a, b) => b.recent - a.recent);
    lines.push("", matches.length ? `Error messages matching “${options.message}”:` : `No saved error message matches “${options.message}”. Only the most frequent messages of each day are saved.`);
    for (const m of matches.slice(0, options.top)) {
      lines.push(`  “${m.name}”: ${describe(m)}, first saved ${m.firstDay}`, `    daily: ${days.map((day, i) => `${day.day.slice(5)} ${formatCount(m.values[i]!)}`).join(", ")}`);
    }
    data.messages = matches.slice(0, options.top).map(seriesData);
    const sampled = days.filter((day) => day.patterns);
    const estimated = patternSeries(sampled).filter((p) => p.template.toLowerCase().includes(needle) || p.example.toLowerCase().includes(needle));
    if (estimated.length) {
      lines.push("", "Estimated patterns matching it, among errors outside the exact messages (95% intervals; – means not estimated that day):");
      for (const p of estimated.sort((a, b) => (mean(b.values)?.estimate ?? 0) - (mean(a.values)?.estimate ?? 0)).slice(0, options.top)) {
        lines.push(`  “${p.template}”`, `    daily: ${sampled.map((day, i) => `${day.day.slice(5)} ${p.values[i] ? `≈${formatCount(p.values[i]!.estimate)} ±${formatCount(margin(p.values[i]!))}` : "–"}`).join(", ")}`);
      }
      data.patterns = estimated.slice(0, options.top).map((p) => ({ template: p.template, days: sampled.map((day, i) => ({ day: day.day, ...p.values[i] })) }));
    }
    return { text: lines.join("\n"), data };
  }

  const systemNames = new Set(days.flatMap((day) => Object.keys(day.systems)));
  const systems = [...systemNames].map((name) => series(name, days.map((day) => systemCounts(day, name)?.errors ?? 0)));
  const top = (list: Series[]) => [...list].sort((a, b) => b.recent - a.recent).filter((s) => s.recent > 0).slice(0, options.top);
  // Ranked by added errors per day, among those up by a quarter or more.
  const rising = (list: Series[]) => list.filter((s) => s.previous !== undefined && s.recent > 0 && s.recent >= s.previous * 1.25).sort((a, b) => b.recent - b.previous! - (a.recent - a.previous!)).slice(0, Math.min(5, options.top));
  lines.push("", "Systems with the most errors:", ...top(systems).map((s) => `  ${s.name}: ${describe(s)}`));
  if (window) lines.push("", "Systems whose errors grew most (up 25% or more):", ...orNone(rising(systems).map((s) => `  ${s.name}: ${describe(s)}`)));
  lines.push("", "Most frequent error messages:", ...top(messageSeries).map((m) => `  “${m.name}”: ${describe(m)}, first saved ${m.firstDay}`));
  if (window) {
    const fresh = messageSeries.filter((m) => m.firstDay! > days[0]!.day && m.firstDay! >= days.at(-window)!.day).sort((a, b) => b.recent - a.recent).slice(0, 5);
    lines.push("", `Messages first saved in the last ${plural(window, "day")}:`, ...orNone(fresh.map((m) => `  “${m.name}”: ${describe(m)}, first saved ${m.firstDay}`)));
    lines.push("", "Messages that grew most (up 25% or more):", ...orNone(rising(messageSeries).map((m) => `  “${m.name}”: ${describe(m)}`)));
  }
  const coverage = average(days.map((day) => (day.totals.errors ? day.messagesCovered / day.totals.errors : 0)));
  lines.push("", `Message counts cover the 300 most frequent exact messages each day, ${formatPercent(coverage)} of errors on average; first saved means first among those.`);
  const patterns = patternSection(days, window, options.top);
  lines.push(...patterns.lines);
  if (patterns.data) data.patterns = patterns.data;
  if (days.some((day) => day.truncated)) lines.push("Each day keeps the 300 largest systems by events and by errors; smaller systems may be missing.");
  data.systems = top(systems).map(seriesData);
  data.messages = top(messageSeries).map(seriesData);
  return { text: lines.join("\n"), data };
}

interface PatternSeries {
  template: string;
  example: string;
  /** Per sampled day: the estimate, or undefined when it could not be estimated that day. */
  values: Array<{ estimate: number; se: number } | undefined>;
  systems: Array<{ name: string; share: number }>;
}

/** Estimated patterns across days that have them, in the order given. */
function patternSeries(sampled: readonly TrendDay[]): PatternSeries[] {
  const series = new Map<string, PatternSeries>();
  sampled.forEach((day, index) => {
    for (const row of day.patterns!.rows) {
      let s = series.get(row.template);
      if (!s) {
        s = { template: row.template, example: row.example, values: sampled.map(() => undefined), systems: row.systems };
        series.set(row.template, s);
      }
      s.values[index] = { estimate: row.estimate, se: row.se };
      s.systems = row.systems;
    }
  });
  return [...series.values()];
}

/** Mean per day over the days with an estimate; days are sampled independently, so variances add. */
function mean(values: ReadonlyArray<{ estimate: number; se: number } | undefined>): { estimate: number; se: number; days: number } | undefined {
  const known = values.filter((value): value is { estimate: number; se: number } => !!value);
  if (!known.length) return undefined;
  return { estimate: known.reduce((sum, v) => sum + v.estimate, 0) / known.length, se: Math.sqrt(known.reduce((sum, v) => sum + v.se ** 2, 0)) / known.length, days: known.length };
}

/**
 * Estimated patterns of the errors outside the exact messages, over the
 * latest sampled days, with 95% intervals; growth only where it exceeds the
 * sampling error; and how well the samples matched exact counts.
 */
function patternSection(days: readonly TrendDay[], window: number, top: number): { lines: string[]; data?: unknown[] } {
  const sampled = days.filter((day) => day.patterns);
  if (!sampled.length) return { lines: ["", "Error patterns beyond the exact messages are not estimated on these days. Set trends.sampleWindows, then /loggly trends adds them to days Loggly still keeps."] };
  const recentCount = Math.min(sampled.length, Math.max(window, 1));
  const earlierCount = window && sampled.length >= 2 * window ? window : 0;
  const recentDays = sampled.slice(-recentCount);
  const all = patternSeries(sampled).map((p) => ({ ...p, recent: mean(p.values.slice(-recentCount)), earlier: earlierCount ? mean(p.values.slice(-recentCount - earlierCount, -recentCount)) : undefined }));
  const ranked = all.filter((p) => p.recent).sort((a, b) => b.recent!.estimate - a.recent!.estimate).slice(0, top);
  const share = average(recentDays.map((day) => (day.totals.errors ? day.patterns!.errors / day.totals.errors : 0)));
  const where = (p: PatternSeries) => p.systems.slice(0, 2).map((s) => `${s.name} ${formatPercent(s.share)}`).join(", ");
  const lines = [
    "",
    recentCount === 1
      ? `Estimated error patterns among errors outside the exact messages (${formatPercent(share)} of errors) on the latest sampled day, with 95% intervals:`
      : `Estimated error patterns among errors outside the exact messages (${formatPercent(share)} of errors), per day on the last ${recentCount} sampled days where each could be estimated, with 95% intervals:`,
    ...orNone(ranked.map((p) => `  ≈${formatCount(p.recent!.estimate)} ±${formatCount(margin(p.recent!))}  “${p.template}” (${recentCount === 1 ? "" : `${p.recent!.days} of ${recentCount} days; `}${where(p)})`)),
  ];
  if (earlierCount) {
    // Only patterns estimated on every day of both periods, and only growth larger than the sampling error.
    const grew = all
      .filter((p) => p.recent?.days === recentCount && p.earlier?.days === earlierCount)
      .filter((p) => p.recent!.estimate >= p.earlier!.estimate * 1.25 && p.recent!.estimate - p.earlier!.estimate > margin({ se: Math.hypot(p.recent!.se, p.earlier!.se) }))
      .sort((a, b) => b.recent!.estimate - b.earlier!.estimate - (a.recent!.estimate - a.earlier!.estimate))
      .slice(0, Math.min(5, top));
    lines.push("", "Estimated patterns that grew 25% or more, beyond their sampling error:", ...orNone(grew.map((p) => `  “${p.template}”: ≈${formatCount(p.recent!.estimate)}/day, was ≈${formatCount(p.earlier!.estimate)} (${change(p.recent!.estimate, p.earlier!.estimate)})`)));
  }
  const checked = recentDays.reduce((sum, day) => sum + day.patterns!.check.checked, 0);
  const inside = recentDays.reduce((sum, day) => sum + day.patterns!.check.inside, 0);
  const held = recentDays.filter((day) => covers(day.patterns!.estimated, day.patterns!.errors)).length;
  const windows = recentDays.map((day) => day.patterns!.design.windows);
  // Against the exact number of errors outside the messages, not the sample's noisier estimate of it.
  const accounted = average(recentDays.map((day) => (day.patterns!.errors ? Math.min(1, day.patterns!.rows.reduce((sum, row) => sum + row.estimate, 0) / day.patterns!.errors) : 0)));
  lines.push(
    "",
    `The patterns estimated each day account for about ${formatPercent(accounted)} of those errors; the rest are in patterns too rare or uneven to estimate.`,
    `Each day was sampled in ${Math.min(...windows) === Math.max(...windows) ? windows[0] : `${Math.min(...windows)}–${Math.max(...windows)}`} random windows. Checked against exact counts on these days: ${inside} of ${checked} intervals held the exact count (about 95% expected), and ${held} of ${recentCount} held the exact number of errors outside the exact messages. Patterns that come in short bursts can be missed or underestimated.`,
  );
  if (sampled.length < days.length) lines.push(`Patterns are estimated on ${sampled.length} of ${days.length} days; /loggly trends adds them to days Loggly still keeps.`);
  return { lines, data: ranked.map((p) => ({ template: p.template, perDay: Math.round(p.recent!.estimate), margin: Math.round(margin(p.recent!)), days: p.recent!.days, of: recentCount, example: p.example, systems: p.systems })) };
}

/** A system's counts on a day, if saved. System names are log data, so only own keys count. */
export function systemCounts(day: TrendDay, system: string): { events: number; errors: number } | undefined {
  return Object.hasOwn(day.systems, system) ? day.systems[system] : undefined;
}

function messageTrends(days: readonly TrendDay[]): Array<{ template: string; values: number[]; firstDay: string; example: string }> {
  const trends = new Map<string, { template: string; values: number[]; firstDay: string; example: string }>();
  days.forEach((day, index) => {
    for (const message of day.messages) {
      let trend = trends.get(message.template);
      if (!trend) {
        trend = { template: message.template, values: days.map(() => 0), firstDay: day.day, example: message.example };
        trends.set(message.template, trend);
      }
      trend.values[index]! += message.count;
    }
  });
  return [...trends.values()];
}

function seriesData(s: Series) {
  return { name: s.name, recentPerDay: Math.round(s.recent), previousPerDay: s.previous === undefined ? undefined : Math.round(s.previous), values: s.values, firstDay: s.firstDay };
}

function change(recent: number, previous: number): string {
  if (previous === 0) return recent > 0 ? "new" : "flat";
  const ratio = recent / previous - 1;
  if (Math.abs(ratio) < 0.05) return "flat";
  return `${ratio > 0 ? "+" : "−"}${formatPercent(Math.abs(ratio))}`;
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function orNone(lines: string[]): string[] {
  return lines.length ? lines : ["  none"];
}

/** "2026-10-01, 2026-10-03 to 2026-10-05". */
function compactDays(days: readonly string[]): string {
  const runs: string[][] = [];
  for (const day of days) {
    const run = runs.at(-1);
    if (run && Date.parse(day) - Date.parse(run.at(-1)!) === DAY_MS) run.push(day);
    else runs.push([day]);
  }
  return runs.map((run) => (run.length === 1 ? run[0]! : `${run[0]} to ${run.at(-1)}`)).join(", ");
}
