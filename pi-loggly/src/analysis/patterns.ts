import type { LogEvent } from "../sdk/types.ts";

/** A group of messages that differ only in variable parts (IDs, numbers, payloads). */
export interface MessagePattern {
  template: string;
  count: number;
  /** Fraction of the events described, from 0 to 1. */
  share: number;
  /** One original message, flattened to a single line. */
  example: string;
  /** Times of the events read; absent when the pattern was only counted. */
  firstSeen?: number;
  lastSeen?: number;
  /** Counts per value of the group field (for example per system), when one was given. */
  groups?: Record<string, number>;
}

export interface ClusterOptions {
  /** Field paths tried in order for the message text; logmsg is the fallback. */
  messageFields?: readonly string[];
  /** Field whose values are counted per pattern, such as the system name. */
  groupField?: string;
  /** Maximum patterns returned. Default 20. */
  limit?: number;
}

/**
 * Read a Loggly field path such as "json.message" from an event. JSON keys may
 * themselves contain dots, so the longest matching key wins at each level.
 */
export function getField(event: LogEvent, path: string): unknown {
  if (path === "logmsg") return event.logmsg;
  if (path === "tag" || path === "tags") return event.tags;
  if (path === "logtype" || path === "logtypes") return event.logtypes;
  return lookup(event.event, path.split("."));
}

function lookup(value: unknown, parts: string[]): unknown {
  if (!parts.length) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (let n = parts.length; n >= 1; n--) {
    const key = parts.slice(0, n).join(".");
    if (Object.hasOwn(record, key)) {
      const found = lookup(record[key], parts.slice(n));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The human-readable message of an event: the first configured field present, else logmsg. */
export function extractMessage(event: LogEvent, messageFields: readonly string[] = []): string {
  for (const path of messageFields) {
    const value = getField(event, path);
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  const logmsg = event.logmsg.trim();
  if (logmsg.startsWith("{")) {
    try {
      const parsed = JSON.parse(logmsg) as Record<string, unknown>;
      for (const key of ["message", "msg", "error", "errorMessage", "Message"]) {
        if (typeof parsed[key] === "string" && (parsed[key] as string).trim()) return parsed[key] as string;
      }
    } catch {
      // Not JSON after all; use the text.
    }
  }
  return logmsg;
}

/** A display string for a field value: strings verbatim, other values as compact JSON. */
export function fieldText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Flatten a message to one line and clamp it. */
export function singleLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Normalise a message into a template by masking variable parts: embedded
 * JSON payloads, UUIDs, emails, URLs' query strings, IPs, hex IDs, timestamps
 * and numbers. Only the first non-empty line is used, so stack traces group.
 */
export function templateOf(message: string, maxLength = 160): string {
  const line = message.split(/\r?\n/).find((part) => part.trim()) ?? "";
  // Stack traces logged one line per event: every frame is the same pattern.
  if (/^\s*at\s+\S.*(?:\(.*:\d+(?::\d+)?\)|:\d+:\d+|:line \d+)\s*$/.test(line)) return "at <stack frame>";
  let text = line;
  const withoutPayload = text.replace(/\s*[{[]\s*["{[][\s\S]*$/, " {…}");
  if (withoutPayload.replace(" {…}", "").trim().length >= 8) text = withoutPayload;
  text = text
    // Query strings after a URL or an absolute path carry IDs; mask them first, before other masks add "<": "/config?client=1&session=…" → "/config?…".
    .replace(/(https?:\/\/[^\s"'<>?]+|(?<![^\s"'(\[])\/[^\s"'<>?]*)\?[^\s"'<>]+/g, "$1?…")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}\b/gi, "<email>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(?:[.,]\d+)*/g, (digits: string, offset: number, text: string) => (startsName(text, offset, digits.length) ? digits : "<n>"))
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "(empty message)";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Units written straight after a number: "30secs" is a number, "7widgets" a name. (Ordinals such as "3rd" have too few letters to be names.) */
const UNIT = /^(?:sec|secs|seconds?|min|mins|minutes?|hrs|hours?|days?|weeks?|months?|years?|[kmgt]ib|bytes?|bits?)$/i;

/** Whether the digits at offset begin a name: a word of digits then three or more letters, as in "7widgets" or "404NotFound", not a unit or a short hex ID. */
function startsName(text: string, offset: number, length: number): boolean {
  if (/[A-Za-z0-9]/.test(text[offset - 1] ?? "")) return false;
  const letters = /^[A-Za-z]{3,}(?![A-Za-z0-9])/.exec(text.slice(offset + length))?.[0];
  return letters !== undefined && !UNIT.test(letters) && !/^[a-f]+$/i.test(letters);
}

/** Group events by message template, most frequent first. */
export function clusterMessages(events: readonly LogEvent[], options: ClusterOptions = {}): MessagePattern[] {
  const groups = new Map<string, MessagePattern & { firstSeen: number; lastSeen: number }>();
  for (const event of events) {
    const message = extractMessage(event, options.messageFields);
    const template = templateOf(message);
    let pattern = groups.get(template);
    if (!pattern) {
      pattern = { template, count: 0, share: 0, example: singleLine(message), firstSeen: event.timestamp, lastSeen: event.timestamp };
      if (options.groupField) pattern.groups = {};
      groups.set(template, pattern);
    }
    pattern.count++;
    pattern.firstSeen = Math.min(pattern.firstSeen, event.timestamp);
    pattern.lastSeen = Math.max(pattern.lastSeen, event.timestamp);
    if (options.groupField && pattern.groups) {
      const group = fieldText(getField(event, options.groupField)) ?? "(none)";
      pattern.groups[group] = (pattern.groups[group] ?? 0) + 1;
    }
  }
  const total = events.length || 1;
  return [...groups.values()]
    .map((pattern) => ({ ...pattern, share: pattern.count / total }))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
    .slice(0, options.limit ?? 20);
}
