const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface Timeframe {
  from: Date;
  until: Date;
  /** The timeframe in words, such as "last 2 hours" or "yesterday". */
  label: string;
  /** A length of time up to now, such as "last 2 hours": it may move back to end at indexed data. */
  rolling?: boolean;
}

export const DEFAULT_TIMEFRAME = "last 24 hours";

export const TIMEFRAME_EXAMPLES = ["last 2h", "last 24 hours", "today", "yesterday", "since 9am", "since monday", "last 7 days", "2026-10-28", "2026-10-28 09:00 to 12:00"];

export class TimeframeError extends Error {
  override name = "TimeframeError";
}

const UNITS = [
  { pattern: /^(?:m|mins?|minutes?)$/, ms: MINUTE_MS, name: "minute" },
  { pattern: /^(?:h|hrs?|hours?)$/, ms: 60 * MINUTE_MS, name: "hour" },
  { pattern: /^(?:d|days?)$/, ms: DAY_MS, name: "day" },
  { pattern: /^(?:w|wks?|weeks?)$/, ms: 7 * DAY_MS, name: "week" },
  { pattern: /^(?:mo|mons?|months?)$/, ms: 30 * DAY_MS, name: "month" },
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Read a timeframe written in words, in the local time zone. Empty means the
 * default. Timeframes ending in the future end now.
 */
export function parseTimeframe(input: string, now: Date = new Date()): Timeframe {
  const text = normalize(input) || DEFAULT_TIMEFRAME;
  const parsed = parse(text, now);
  if (!parsed) throw new TimeframeError(`Could not read "${input.trim()}" as a timeframe. Try ${TIMEFRAME_EXAMPLES.slice(0, 7).join(", ")}.`);
  if (parsed.from.getTime() >= now.getTime()) throw new TimeframeError(`"${input.trim()}" starts in the future.`);
  const until = parsed.until.getTime() > now.getTime() ? now : parsed.until;
  if (until.getTime() <= parsed.from.getTime()) throw new TimeframeError(`"${input.trim()}" ends before it starts.`);
  return { ...parsed, until };
}

function normalize(input: string): string {
  return input
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(?:(?:over|in|for|during|within) )?(?:the )?/, "");
}

function parse(text: string, now: Date): Timeframe | undefined {
  // "last 2 hours", "past day", "2h", "-90m", "last week".
  const relative = /^(?:(?:last|past|previous) ?)?-?(\d+(?:\.\d+)?)? ?([a-z]+)$/.exec(text);
  const unit = relative && UNITS.find((u) => u.pattern.test(relative[2]!));
  if (relative && unit) {
    const count = relative[1] ? Number(relative[1]) : 1;
    if (!(count > 0)) return undefined;
    return { from: new Date(now.getTime() - count * unit.ms), until: now, label: `last ${count === 1 ? unit.name : `${count} ${unit.name}s`}`, rolling: true };
  }
  if (text === "this week") return { from: addDays(startOfDay(now), -((now.getDay() + 6) % 7)), until: now, label: text };
  if (text === "this month") return { from: new Date(now.getFullYear(), now.getMonth(), 1), until: now, label: text };
  const since = /^since (.+)$/.exec(text);
  if (since) {
    const start = point(since[1]!, now);
    if (!start) return undefined;
    // "since 9am" before 9am means yesterday's.
    const from = start.timeOnly && start.date > now ? addDays(start.date, -1) : start.date;
    return { from, until: now, label: text };
  }
  const range = /^(?:from |between )?(.+?) (?:to|until|till|through|and|-|–|—) (.+)$/.exec(text);
  if (range) {
    const start = point(range[1]!, now);
    if (!start) return undefined;
    const end = point(range[2]!, now, start.date);
    if (!end) return undefined;
    // A date alone as the end includes that day; a time alone that is earlier means the next day.
    let until = end.dayOnly ? addDays(end.date, 1) : end.date;
    if (end.timeOnly && until <= start.date) until = addDays(until, 1);
    return { from: start.date, until, label: text };
  }
  // A whole day: "yesterday", "monday", "2026-10-28".
  const day = point(text, now);
  return day?.dayOnly ? { from: day.date, until: addDays(day.date, 1), label: text } : undefined;
}

interface Point {
  date: Date;
  /** A whole day, such as "yesterday" or "2026-10-28". */
  dayOnly: boolean;
  /** A time of day without a date, such as "9am". */
  timeOnly: boolean;
}

/** A moment in words. Times without a date fall on `base`'s day, or today. */
function point(text: string, now: Date, base?: Date): Point | undefined {
  if (text === "now") return { date: now, dayOnly: false, timeOnly: false };
  const ago = /^(\d+(?:\.\d+)?) ?([a-z]+) ago$/.exec(text) ?? /^-(\d+(?:\.\d+)?) ?([a-z]+)$/.exec(text);
  const agoUnit = ago && UNITS.find((u) => u.pattern.test(ago[2]!));
  if (ago && agoUnit) return { date: new Date(now.getTime() - Number(ago[1]) * agoUnit.ms), dayOnly: false, timeOnly: false };
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}):(\d{2})(?::(\d{2}))?(z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, zone] = iso;
    if (zone) return valid({ date: new Date(Date.parse(text.toUpperCase().replace(" ", "T"))), dayOnly: false, timeOnly: false });
    return valid({ date: new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)), dayOnly: h === undefined, timeOnly: false });
  }
  const dayStart = dayWord(text, now);
  if (dayStart) return { date: dayStart, dayOnly: true, timeOnly: false };
  const time = timeOfDay(text);
  if (time !== undefined) return { date: new Date(startOfDay(base ?? now).getTime() + time), dayOnly: false, timeOnly: true };
  // "yesterday 9am", "monday 14:00".
  const split = /^(.+) (?:at )?(\S+)$/.exec(text);
  if (split) {
    const day = dayWord(split[1]!, now);
    const at = timeOfDay(split[2]!);
    if (day && at !== undefined) return { date: new Date(day.getTime() + at), dayOnly: false, timeOnly: false };
  }
  return undefined;
}

function dayWord(text: string, now: Date): Date | undefined {
  if (text === "today") return startOfDay(now);
  if (text === "yesterday") return addDays(startOfDay(now), -1);
  const weekday = WEEKDAYS.indexOf(text.replace(/^(?:last|on) /, ""));
  if (weekday < 0) return undefined;
  // The most recent such day, today included.
  return addDays(startOfDay(now), -((now.getDay() - weekday + 7) % 7));
}

/** Milliseconds after midnight for "9am", "9:30", "14:00", "noon" or "midnight". */
function timeOfDay(text: string): number | undefined {
  if (text === "noon") return 12 * 60 * MINUTE_MS;
  if (text === "midnight") return 0;
  const match = /^(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/.exec(text);
  // A bare number is not a time: "9" could mean anything.
  if (!match || (match[2] === undefined && match[3] === undefined)) return undefined;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (match[3]) {
    if (hours < 1 || hours > 12) return undefined;
    hours = (hours % 12) + (match[3] === "pm" ? 12 : 0);
  }
  if (hours > 23 || minutes > 59) return undefined;
  return (hours * 60 + minutes) * MINUTE_MS;
}

function valid(p: Point): Point | undefined {
  return Number.isNaN(p.date.getTime()) ? undefined : p;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Add calendar days in local time, so days stay midnight-to-midnight across daylight saving changes. */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
