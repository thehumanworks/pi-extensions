import type { RunRecord, RunStatus, StepRecord } from "./index.ts";
export { TERMINAL_STATUSES } from "./protocol.ts";

export const RESULT_BYTES = 16 * 1024;

export function statusExitCode(status: RunStatus): number {
  if (status === "cancelled") return 3;
  if (status === "failed" || status === "outdated") return 2;
  return 0;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function cost(value: number | undefined): string {
  return value === undefined ? "cost unavailable" : `$${value.toFixed(4)}`;
}

export function runSummary(run: RunRecord, now = Date.now()): string {
  const elapsed = (run.endedAt ?? now) - (run.startedAt ?? run.createdAt);
  const phases = run.phases.map(phase => `${phase.title} ${phase.done}/${phase.agents}`).join(" · ");
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  return `${run.id} ${run.workflow.name} ${run.status} ${duration(elapsed)}` +
    `${phases ? ` · ${phases}` : ""} · ${run.usage.agents} agents · ${tokens} tokens · ${cost(run.usage.costUsd)}`;
}

function stepLine(step: StepRecord, now: number): string {
  const elapsed = step.startedAt === undefined ? "" : ` ${duration((step.endedAt ?? now) - step.startedAt)}`;
  const tokens = step.usage ? ` ${step.usage.inputTokens + step.usage.outputTokens} tokens` : "";
  const label = step.label && step.label !== step.key ? ` ${step.label}` : "";
  const error = step.error ? ` — ${step.error.reason ?? "error"}: ${step.error.message}` : "";
  return `  ${step.key}${label} [${step.status}]${elapsed}${tokens}${error}`;
}

/** A complete progress view derived from one status response. */
export function runTree(run: RunRecord, now = Date.now()): string {
  const lines = [runSummary(run, now)];
  let phase: string | undefined;
  for (const step of run.steps) {
    if (step.phase && step.phase !== phase) {
      phase = step.phase;
      lines.push(` ${phase}`);
    }
    lines.push(stepLine(step, now));
    if (step.worktree) lines.push(`    worktree ${step.worktree.branch} ${step.worktree.path}`);
  }
  if (run.error) lines.push(`${run.error.reason ?? "error"}: ${run.error.message}${run.error.stepKey ? ` (${run.error.stepKey})` : ""}`);
  if (run.parked) lines.push(`Parked after repeated restarts. Resume with: pi-workflow retry ${run.id}`);
  if (run.waitingFor) {
    if (run.waitingFor.prompt) lines.push(run.waitingFor.prompt);
    lines.push(`Waiting for ${run.waitingFor.key}; deliver with: pi-workflow signal ${run.id} ${JSON.stringify(run.waitingFor.key)} '<json>'`);
  }
  if (run.logs?.length) lines.push(`log: ${run.logs.at(-1)!.message}`);
  return lines.join("\n");
}

export function runList(runs: RunRecord[]): string {
  if (!runs.length) return "No workflow runs.";
  // Show children beneath their parent, oldest first; keep the given order for top-level runs.
  const present = new Set(runs.map(run => run.id));
  const children = new Map<string, RunRecord[]>();
  for (const run of runs) if (run.origin.kind === "workflow" && present.has(run.origin.parentRunId)) {
    const siblings = children.get(run.origin.parentRunId) ?? [];
    siblings.push(run); children.set(run.origin.parentRunId, siblings);
  }
  const lines: string[] = [];
  const add = (run: RunRecord) => {
    lines.push(`${"  ".repeat(run.depth)}${runSummary(run)}`);
    for (const child of (children.get(run.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)) add(child);
  };
  for (const run of runs) if (!(run.origin.kind === "workflow" && present.has(run.origin.parentRunId))) add(run);
  return lines.join("\n");
}

/** Truncate UTF-8 without cutting a code point; the full result remains in the worker. */
export function modelResult(value: unknown, runId?: string, limit = RESULT_BYTES): {
  text: string; truncated: boolean;
} {
  const full = typeof value === "string" ? value : json(value);
  if (Buffer.byteLength(full) <= limit) return { text: full, truncated: false };
  const pointer = runId
    ? `Full result: pi-workflow result ${runId} --json (or workflow action "result", runId "${runId}").`
    : 'Use the CLI with --json for the complete response.';
  const suffix = `\n[Truncated at ${limit} bytes. ${pointer}]`;
  const budget = Math.max(0, limit - Buffer.byteLength(suffix));
  let text = Buffer.from(full).subarray(0, budget).toString("utf8");
  if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text: text + suffix, truncated: true };
}
