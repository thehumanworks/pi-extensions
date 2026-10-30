import type { LogglyClient } from "../sdk/client.ts";
import type { LogEvent } from "../sdk/types.ts";
import { extractMessage, fieldText, getField, singleLine, templateOf, type MessagePattern } from "./patterns.ts";

/**
 * Message patterns that describe a whole time window, not just its newest
 * events. Errors come in bursts, and jobs log one kind of message after
 * another, so the newest few hundred events of a window can miss most of it.
 *
 * 1. One facet on the first message field counts its most common values
 *    exactly across the window (Loggly returns up to 300).
 * 2. A window no larger than the sample is read whole.
 * 3. Otherwise the events the facet did not count are read in two parts:
 *    events without the message field (raw lines such as stack frames), and
 *    events with it (values beyond the facet's top 300, and the group field of
 *    every pattern). A part that fits its share of the sample is read whole;
 *    a larger one is spread over STRATA equal slices of the window, each
 *    counted, with its earliest and latest events read and weighted by
 *    count / read.
 * 4. With a group field, one facet on it finds windows from a single group,
 *    whose patterns then all belong to it, read or not.
 *
 * Reading both ends of a slice keeps a trend within it from being read from
 * one side only, but the reads are still blocks of consecutive events: a job
 * that logs at the same second of every minute is over- or under-weighted
 * when the slices start on the minute. The facet keeps that error to the part
 * of the window it cannot count.
 */

export type PatternClient = Pick<LogglyClient, "count" | "facet" | "search">;

export interface WindowPatternOptions {
  query: string;
  from: number;
  until: number;
  /** Most events to read. */
  sampleSize: number;
  /** Field paths tried in order for the message text; logmsg is the fallback. The first is faceted. */
  messageFields?: readonly string[];
  /** Field counted per pattern, such as the system. Patterns the facet counted are still read for it. */
  groupField?: string;
  /** Maximum patterns returned. Default 20. */
  limit?: number;
  signal?: AbortSignal;
}

/** How a window's patterns were measured. */
export interface PatternBasis {
  /** Events in the window. */
  total: number;
  /** Events read. */
  read: number;
  /** Events whose pattern was counted, not estimated. */
  exact: number;
}

export interface WindowPatterns extends PatternBasis {
  /** Counts are events in the window, estimated unless exact covers the total; shares are of the total. */
  patterns: MessagePattern[];
  /** The group field's value, when every event in the window has the same one. */
  onlyGroup?: string;
}

/** Equal slices of the window a part is spread over when it is too large to read whole. */
export const STRATA = 4;
/** Loggly's largest facet. */
const FACET_SIZE = 300;
/** Paths getField reads from the event envelope rather than the indexed event, which Loggly cannot facet. */
const ENVELOPE = new Set(["logmsg", "tag", "tags", "logtype", "logtypes"]);

interface Read {
  event: LogEvent;
  weight: number;
}

interface Part {
  reads: Read[];
  /** Every matching event was read. */
  whole: boolean;
}

export async function windowPatterns(client: PatternClient, options: WindowPatternOptions): Promise<WindowPatterns> {
  const { query, from, until, sampleSize, signal } = options;
  const messageFields = options.messageFields ?? [];
  const field = messageFields[0] !== undefined && !ENVELOPE.has(messageFields[0]) ? messageFields[0] : undefined;
  const range = { from: new Date(from), until: new Date(until) };
  const [facet, single] = await Promise.all([
    field ? client.facet(field, { query, ...range, size: FACET_SIZE }, { signal }) : undefined,
    options.groupField ? singleGroup(client, options.groupField, query, range, signal) : undefined,
  ]);
  const total = facet ? facet.totalEvents : (await client.count({ query, ...range }, { signal })).count;
  // A blank value is not the message: extractMessage falls through to the next field.
  const terms = new Map((facet?.terms ?? []).filter((term) => term.term.trim()).map((term) => [term.term, term.count]));
  const counted = sum(terms.values());
  const tally = new Tally(messageFields, options.groupField, single);
  const finish = (basis: PatternBasis): WindowPatterns => ({ ...basis, ...(single !== undefined && { onlyGroup: single }), patterns: tally.patterns(basis.total, options.limit ?? 20) });

  if (facet && !facet.truncated && counted === total && !options.groupField) {
    tally.addTerms(terms);
    return finish({ total, read: 0, exact: total });
  }
  if (total <= sampleSize) {
    const events = await client.search({ query, ...range, order: "desc" }, { limit: sampleSize, signal });
    for (const event of events) tally.add(event, 1);
    return finish({ total: events.length, read: events.length, exact: events.length });
  }

  // Events without the message field, which the facet cannot count.
  const blanks = facet ? facet.terms.some((term) => !term.term.trim()) : false;
  const lacking = !field ? total : facet!.truncated || blanks ? Math.min(total - counted, (await client.count({ query: `(${query}) AND NOT ${field}:*`, ...range }, { signal })).count) : total - counted;
  // Values beyond the facet's top 300 (and blank values).
  const tail = Math.max(0, total - counted - lacking);
  const readField = field !== undefined && (tail > 0 || (options.groupField !== undefined && counted > 0));
  const [rawBudget, fieldBudget] = split(sampleSize, lacking, readField ? (options.groupField ? total - lacking : tail) : 0);
  const [raw, withField] = await Promise.all([
    lacking > 0 ? readPart(client, field ? `(${query}) AND NOT ${field}:*` : query, from, until, lacking, rawBudget, signal) : undefined,
    readField ? readPart(client, `(${query}) AND ${field}:*`, from, until, total - lacking, fieldBudget, signal) : undefined,
  ]);

  tally.addTerms(terms);
  if (raw) tally.addScaled(raw, lacking);
  if (withField) {
    const isCounted = (read: Read) => {
      const value = getField(read.event, field!);
      return (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && terms.has(String(value));
    };
    tally.addScaled({ reads: withField.reads.filter((read) => !isCounted(read)), whole: withField.whole }, tail);
    tally.describe(withField.reads.filter(isCounted));
  }
  const exact = counted + (!raw || raw.whole ? lacking : 0) + (!withField || withField.whole ? tail : 0);
  return finish({ total, read: (raw?.reads.length ?? 0) + (withField?.reads.length ?? 0), exact });
}

/** How patterns were measured, for example "803 errors: all counted". */
export function describeBasis(basis: PatternBasis, noun = "event"): string {
  return `${basis.total.toLocaleString("en-GB")} ${noun}${basis.total === 1 ? "" : "s"}: ${describeMethod(basis)}`;
}

/** "all counted", "600 counted, the rest estimated from 200 read at both ends of 4 equal time slices" or "estimated from 500 read at both ends of 4 equal time slices". */
export function describeMethod(basis: PatternBasis): string {
  if (basis.exact >= basis.total) return "all counted";
  const read = `${basis.read.toLocaleString("en-GB")} read at both ends of ${STRATA} equal time slices`;
  return basis.exact ? `${basis.exact.toLocaleString("en-GB")} counted, the rest estimated from ${read}` : `estimated from ${read}`;
}

/** Sample budgets for the part without the message field and the part with it, given each part's size. */
function split(budget: number, raw: number, field: number): [number, number] {
  if (!field) return [budget, 0];
  if (!raw) return [0, budget];
  if (raw <= budget / 2) return [raw, budget - raw];
  const quarter = Math.ceil(budget / 4);
  const rawBudget = Math.min(budget - quarter, Math.max(quarter, Math.round((budget * raw) / (raw + field))));
  return [rawBudget, budget - rawBudget];
}

/** The group field's only value when every event in the window has it; undefined when there are several, or the facet fails. */
async function singleGroup(client: PatternClient, groupField: string, query: string, range: { from: Date; until: Date }, signal?: AbortSignal): Promise<string | undefined> {
  if (ENVELOPE.has(groupField)) return undefined;
  try {
    const facet = await client.facet(groupField, { query, ...range, size: 2 }, { signal });
    const [only] = facet.terms;
    return facet.terms.length === 1 && only!.count === facet.totalEvents ? only!.term : undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

/** Read a part whole when it fits the budget, else the earliest and latest events of each of STRATA slices, weighted by slice count / read. */
async function readPart(client: PatternClient, query: string, from: number, until: number, size: number, budget: number, signal?: AbortSignal): Promise<Part> {
  if (size <= budget) {
    const events = await client.search({ query, from: new Date(from), until: new Date(until), order: "desc" }, { limit: budget, signal });
    return { reads: events.map((event) => ({ event, weight: 1 })), whole: true };
  }
  const slices = Array.from({ length: STRATA }, (_, i) => ({ from: from + Math.round(((until - from) * i) / STRATA), until: from + Math.round(((until - from) * (i + 1)) / STRATA) }));
  const counts = await Promise.all(slices.map(async (slice) => (await client.count({ query, from: new Date(slice.from), until: new Date(slice.until) }, { signal })).count));
  const quotas = allocate(counts, budget);
  const read = async (slice: { from: number; until: number }, order: "asc" | "desc", limit: number) => (limit ? client.search({ query, from: new Date(slice.from), until: new Date(slice.until), order }, { limit, signal }) : []);
  const batches = await Promise.all(slices.map(async (slice, i) => {
    const quota = quotas[i]!;
    if (quota >= counts[i]! || quota < 2) return read(slice, "desc", quota);
    const [latest, earliest] = await Promise.all([read(slice, "desc", Math.ceil(quota / 2)), read(slice, "asc", Math.floor(quota / 2))]);
    // Events indexed since the count could make the two ends meet.
    const ids = new Set(latest.map((event) => event.id));
    return [...latest, ...earliest.filter((event) => !ids.has(event.id))];
  }));
  return { reads: batches.flatMap((events, i) => events.map((event) => ({ event, weight: counts[i]! / events.length }))), whole: false };
}

/** Split a budget across slices in proportion to their counts (largest remainder), reading at least one event of every non-empty slice. */
export function allocate(counts: readonly number[], budget: number): number[] {
  const total = sum(counts);
  if (!total) return counts.map(() => 0);
  const ideal = counts.map((count) => Math.min(count, (budget * count) / total));
  const quotas = ideal.map(Math.floor);
  const byRemainder = counts.map((_, i) => i).sort((a, b) => ideal[b]! - quotas[b]! - (ideal[a]! - quotas[a]!));
  let left = budget - sum(quotas);
  for (const i of byRemainder) {
    if (left <= 0) break;
    if (quotas[i]! < counts[i]!) {
      quotas[i]!++;
      left--;
    }
  }
  for (const [i, count] of counts.entries()) {
    if (count <= 0 || quotas[i]) continue;
    const largest = quotas.indexOf(Math.max(...quotas));
    if (quotas[largest]! <= 1) break;
    quotas[largest]!--;
    quotas[i] = 1;
  }
  return quotas;
}

interface Entry {
  template: string;
  count: number;
  /** Events counted by the facet, whose groups come from the counted events read. */
  counted: number;
  example: string;
  firstSeen?: number;
  lastSeen?: number;
  groups: Map<string, number>;
  countedGroups: Map<string, number>;
}

/** Weighted pattern counts across the facet and the parts read. */
class Tally {
  readonly #entries = new Map<string, Entry>();
  readonly #messageFields: readonly string[];
  readonly #groupField?: string;
  /** The group of every event in the window, when there is only one. */
  readonly #single?: string;

  constructor(messageFields: readonly string[], groupField?: string, single?: string) {
    this.#messageFields = messageFields;
    this.#groupField = groupField;
    this.#single = single;
  }

  addTerms(terms: ReadonlyMap<string, number>): void {
    for (const [term, count] of terms) {
      const entry = this.#entry(templateOf(term), term);
      entry.count += count;
      entry.counted += count;
    }
  }

  add(event: LogEvent, weight: number): void {
    const entry = this.#see(event);
    entry.count += weight;
    if (this.#groupField) increment(entry.groups, this.#group(event), weight);
  }

  /** Add reads scaled so they sum to size, unless they are the whole part. */
  addScaled(part: Part, size: number): void {
    const weight = sum(part.reads.map((read) => read.weight));
    const scale = part.whole || !weight ? 1 : size / weight;
    for (const read of part.reads) this.add(read.event, read.weight * scale);
  }

  /** Seen times and groups of events the facet already counted. */
  describe(reads: readonly Read[]): void {
    for (const read of reads) {
      const entry = this.#see(read.event);
      if (this.#groupField) increment(entry.countedGroups, this.#group(read.event), read.weight);
    }
  }

  patterns(total: number, limit: number): MessagePattern[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.count > 0)
      .map((entry): MessagePattern => {
        const pattern: MessagePattern = { template: entry.template, count: Math.max(1, Math.round(entry.count)), share: total ? entry.count / total : 0, example: entry.example };
        if (entry.firstSeen !== undefined) [pattern.firstSeen, pattern.lastSeen] = [entry.firstSeen, entry.lastSeen];
        if (this.#groupField) pattern.groups = this.#groups(entry);
        return pattern;
      })
      .sort((a, b) => b.count - a.count || (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || (a.template < b.template ? -1 : 1))
      .slice(0, limit);
  }

  #groups(entry: Entry): Record<string, number> {
    if (this.#single !== undefined) return { [this.#single]: Math.max(1, Math.round(entry.count)) };
    const groups = new Map(entry.groups);
    const read = sum(entry.countedGroups.values());
    for (const [group, weight] of entry.countedGroups) increment(groups, group, (entry.counted * weight) / read);
    return Object.fromEntries([...groups].map(([group, count]) => [group, Math.round(count)] as const).filter(([, count]) => count > 0));
  }

  #see(event: LogEvent): Entry {
    const message = extractMessage(event, this.#messageFields);
    const entry = this.#entry(templateOf(message), message);
    entry.firstSeen = Math.min(entry.firstSeen ?? event.timestamp, event.timestamp);
    entry.lastSeen = Math.max(entry.lastSeen ?? event.timestamp, event.timestamp);
    return entry;
  }

  #entry(template: string, message: string): Entry {
    let entry = this.#entries.get(template);
    if (!entry) {
      entry = { template, count: 0, counted: 0, example: singleLine(message), groups: new Map(), countedGroups: new Map() };
      this.#entries.set(template, entry);
    }
    return entry;
  }

  #group(event: LogEvent): string {
    return fieldText(getField(event, this.#groupField!)) ?? "(none)";
  }
}

function increment(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
