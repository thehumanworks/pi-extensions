import { formatCount, formatPercent, formatRatio, sparkline } from "./analysis/format.ts";
import type { HealthIssue, HealthSnapshot, SystemHealth } from "./analysis/health.ts";
import type { MessagePattern } from "./analysis/patterns.ts";
import { formatDuration } from "./sdk/time.ts";

const iso = (ms: number) => new Date(ms).toISOString().replace(/:00\.000Z$/, "Z").replace(/\.000Z$/, "Z");

export interface ReportOptions {
  /** Limit the report to one system. */
  system?: string;
  /** Patterns sampled on demand for that system, when it has no sampled issue. */
  systemPatterns?: { patterns: MessagePattern[]; sampled: number };
  /** Systems listed in the table. Default 15. */
  maxSystems?: number;
  /** Error from the latest refresh attempt, if it failed after an earlier success. */
  staleError?: string;
}

/** A plain-text health report for the model or non-interactive modes. */
export function formatHealthReport(snapshot: HealthSnapshot, options: ReportOptions = {}): string {
  const rules = snapshot.rules;
  const counts = { critical: 0, warning: 0, notice: 0 };
  for (const issue of snapshot.issues) counts[issue.severity]++;
  const summary = [counts.critical && `${counts.critical} critical`, counts.warning && `${counts.warning} warning`, counts.notice && `${counts.notice} chronic`].filter(Boolean).join(", ");
  const lines = [
    `Loggly health: ${snapshot.status.toUpperCase()}${summary ? ` (${summary})` : ""}, checked ${iso(snapshot.generatedAt)}`,
    `Systems are ${rules.groupBy} values within ${rules.scope}. Errors match: ${rules.errorQuery}`,
    `Current window ${iso(snapshot.current.from)} to ${iso(snapshot.current.until)} (${formatDuration(snapshot.windowMs)}), compared with the median of the ${rules.baselineWindows} preceding windows.`,
    `Totals: ${formatCount(snapshot.totals.errorsNow)} errors (usually ${formatCount(snapshot.totals.errorsBaseline)}) in ${formatCount(snapshot.totals.volumeNow)} events (usually ${formatCount(snapshot.totals.volumeBaseline)}).`,
  ];
  if (options.staleError) lines.push(`Warning: the latest refresh failed (${options.staleError}); this snapshot is older.`);

  const issues = options.system ? snapshot.issues.filter((issue) => issue.system === options.system) : snapshot.issues;
  const systems = options.system ? snapshot.systems.filter((system) => system.name === options.system) : snapshot.systems;
  if (options.system && !systems.length) lines.push("", `No events from ${rules.groupBy}:"${options.system}" in the checked windows.`);

  lines.push("", issues.length ? "Issues, most pressing first:" : options.system ? "No issues for this system." : "No issues: no error spikes, silent systems or chronic error rates.");
  issues.forEach((issue, index) => lines.push(...issueLines(issue, index + 1)));
  if (options.systemPatterns && !issues.some((issue) => issue.patterns)) {
    lines.push("", `Error patterns (sample of ${options.systemPatterns.sampled} newest errors):`);
    lines.push(...options.systemPatterns.patterns.map((pattern) => `  ${formatPercent(pattern.share)} “${pattern.template}”`));
  }

  if (systems.length) {
    const shown = systems.slice(0, options.maxSystems ?? 15);
    lines.push("", `${options.system ? "System" : `Systems (${shown.length} of ${systems.length}, most pressing first)`}: status, errors now / usual (ratio), error rate, events now / usual, error trend`);
    lines.push(...shown.map(systemLine));
  }
  const muted = snapshot.systems.filter((system) => system.status === "muted").map((system) => system.name);
  if (muted.length && !options.system) lines.push("", `Muted: ${muted.join(", ")}`);
  if (snapshot.warnings.length) lines.push("", ...snapshot.warnings.map((warning) => `Note: ${warning}`));
  return lines.join("\n");
}

function issueLines(issue: HealthIssue, index: number): string[] {
  const lines = [`${index}. [${issue.severity}] ${issue.system ?? "all systems"}: ${issue.summary}`, `   query: ${issue.query}`];
  if (issue.patterns?.length) {
    lines.push(`   error patterns (sample of ${issue.sampled}): ${issue.patterns.slice(0, 3).map((pattern) => `${formatPercent(pattern.share)} “${pattern.template}”`).join("; ")}`);
  }
  return lines;
}

function systemLine(system: SystemHealth): string {
  return `  ${system.name}: ${system.status}, ${formatCount(system.errorsNow)} / ${formatCount(system.errorsBaseline)} (${formatRatio(system.ratio)}), ${system.volumeNow ? formatPercent(system.errorRate) : "–"}, ${formatCount(system.volumeNow)} / ${formatCount(system.volumeBaseline)}, ${sparkline(system.errors)}`;
}
