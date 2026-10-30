import { resolveTime } from "./sdk/time.ts";

const DAY_MS = 86_400_000;

/**
 * Loggly deletes logs older than the account's retention, in batches, so
 * just before the limit it holds some logs and earlier none. Counts there
 * are partial or zero because logs were deleted, not because less happened,
 * and whatever is present at the limit may have begun before it. Ranges are
 * therefore cut at the limit, and results say so.
 */

/** The oldest time Loggly is sure to keep. */
export function retentionLimit(now: number, retentionDays: number): number {
  return now - retentionDays * DAY_MS;
}

export interface KeptRange {
  from: string;
  until: string;
  /** Why the range starts later than asked. */
  note?: string;
  /** Set instead when all of the range is past the limit, so there is nothing to query. */
  deleted?: string;
}

/** A range cut at Loggly's retention limit. Unchanged when retention is unknown or a time cannot be read here. */
export function keptRange(range: { from: string; until: string }, now: number, retentionDays: number | undefined): KeptRange {
  if (!retentionDays) return { ...range };
  let from: number;
  let until: number;
  try {
    from = resolveTime(range.from, now);
    until = resolveTime(range.until, now);
  } catch {
    return { ...range };
  }
  const limit = retentionLimit(now, retentionDays);
  const kept = `Loggly keeps ${retentionDays} days of logs (this account's retention) and has deleted older ones`;
  if (until <= limit) {
    return { ...range, deleted: `Nothing to query: ${kept}, and this range ends before ${isoSecond(limit)}. Use loggly_trends for daily counts saved on this machine, back to when saving began.` };
  }
  // A range starting exactly at the limit (-30d with 30 days kept) gets the note too.
  if (from > limit) return { ...range };
  return {
    from: new Date(limit).toISOString(),
    until: range.until,
    note: `${kept}, so this range starts at ${isoSecond(limit)}${from < limit ? ` instead of ${range.from}` : ""}. Whatever is already there at that start may have begun earlier: the data cannot show when.`,
  };
}

function isoSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
