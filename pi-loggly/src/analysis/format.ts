/** Compact counts: 950, 1.2k, 21k, 3.4M. */
export function formatCount(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  const [divisor, suffix] = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : [1e3, "k"];
  const scaled = value / divisor;
  return `${Math.abs(scaled) >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${suffix}`;
}

/** Percentages with one decimal below 10%: 0.4%, 9.5%, 41%. */
export function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
}

/** Ratios such as ×8.1 or ×120. */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "×∞";
  return `×${ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10}`;
}

const SPARKS = "▁▂▃▄▅▆▇█";

/** A sparkline scaled from zero to the series maximum. */
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values);
  if (max === 0) return SPARKS[0]!.repeat(values.length);
  return values.map((value) => SPARKS[Math.min(SPARKS.length - 1, Math.round((Math.max(0, value) / max) * (SPARKS.length - 1)))]).join("");
}

/** "12s ago", "4m ago", "2h ago". */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Local clock time, "09:42". */
export function formatClock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}
