/** A Loggly time: relative text such as "-15m" or "now", an ISO 8601 timestamp, or a Date. */
export type TimeValue = string | Date;

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Format a time for Loggly. Strings pass through verbatim; Loggly validates their syntax. */
export function formatTime(value: TimeValue): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Search times must be valid dates");
    return value.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Search times must be non-empty strings or dates");
  return value.trim();
}

/** Parse a duration such as "90s", "15m", "2h", "1d" or "1w" into milliseconds. */
export function parseDuration(text: string, options: { allowZero?: boolean } = {}): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/.exec(text);
  if (!match) throw new TypeError(`Invalid duration "${text}": use a number followed by s, m, h, d or w`);
  const ms = Number(match[1]) * UNIT_MS[match[2]!]!;
  if (!Number.isFinite(ms) || ms < 0 || (ms === 0 && !options.allowZero)) throw new TypeError(`Invalid duration "${text}": must be positive`);
  return ms;
}

/**
 * Resolve a Loggly time to epoch milliseconds. Supports "now", relative
 * offsets ("-15m", "-1d", "+5m") and ISO 8601 timestamps.
 */
export function resolveTime(value: TimeValue, now = Date.now()): number {
  if (value instanceof Date) return Date.parse(formatTime(value));
  const text = formatTime(value);
  if (text.toLowerCase() === "now") return now;
  const relative = /^([+-])\s*(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(text);
  if (relative) {
    const ms = Number(relative[2]) * UNIT_MS[relative[3]!]!;
    return relative[1] === "-" ? now - ms : now + ms;
  }
  // Only accept ISO-like dates; Date.parse also accepts ambiguous locale formats.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new TypeError(`Unsupported time "${text}": use "now", a relative offset like -15m/-2h/-1d, or ISO 8601`);
}

/** Format a duration in milliseconds compactly ("10m", "1h", "1h30m", "2d"). */
export function formatDuration(ms: number): string {
  if (ms % UNIT_MS.d! === 0) return `${ms / UNIT_MS.d!}d`;
  if (ms >= UNIT_MS.h! && ms % UNIT_MS.h! === 0) return `${ms / UNIT_MS.h!}h`;
  if (ms > UNIT_MS.h! && ms % UNIT_MS.m! === 0) return `${Math.floor(ms / UNIT_MS.h!)}h${(ms % UNIT_MS.h!) / UNIT_MS.m!}m`;
  if (ms % UNIT_MS.m! === 0) return `${ms / UNIT_MS.m!}m`;
  return `${Math.round(ms / 1000)}s`;
}
