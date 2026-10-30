import type { CatalogEntry, ModelRef, RunRecord, RunStatus, StepRecord, ValidationResult } from "./index.ts";
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

export function modelLabel(model: ModelRef | undefined, thinkingLevel?: string): string {
  const name = model === undefined ? "no model" : typeof model === "string" ? model : `${model.provider}/${model.modelId}`;
  return thinkingLevel && model !== undefined ? `${name}:${thinkingLevel}` : name;
}

/** Failed work inside a run, including branches that a default parallel turned into null. */
export function failedSteps(run: RunRecord): StepRecord[] {
  return run.steps.filter(step => step.status === "failed" && step.kind !== "parallel" && step.kind !== "pipeline");
}

export function runSummary(run: RunRecord, now = Date.now()): string {
  const elapsed = (run.endedAt ?? now) - (run.startedAt ?? run.createdAt);
  const phases = run.phases.map(phase => `${phase.title} ${phase.done}/${phase.agents}`).join(" · ");
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  const failed = failedSteps(run).length;
  return `${run.id} ${run.workflow.name} ${run.status} ${duration(elapsed)} · ${modelLabel(run.model, run.thinkingLevel)}` +
    `${phases ? ` · ${phases}` : ""} · ${run.usage.agents} agents · ${tokens} tokens · ${cost(run.usage.costUsd)}` +
    `${failed ? ` · ${failed} failed step${failed === 1 ? "" : "s"}` : ""}`;
}

/** The compact view of a run: outcome first, internals only on request. */
export function runBrief(run: RunRecord, program = "workflow"): { view: Record<string, unknown>; text: string } {
  const failed = failedSteps(run).map(step => ({ key: step.key, ...(step.label ? { label: step.label } : {}), error: step.error?.message ?? "failed" }));
  const view: Record<string, unknown> = {
    runId: run.id, workflow: run.workflow.name, status: run.status, summary: runSummary(run),
    ...(run.error ? { error: run.error } : {}),
    ...(failed.length ? { failedSteps: failed } : {}),
    ...(run.waitingFor ? { waitingFor: run.waitingFor } : {}),
    ...(run.parked ? { parked: true } : {}),
    ...(run.result !== undefined ? { result: run.result } : run.resultRef ? { resultStored: true } : {}),
  };
  const lines = [runSummary(run)];
  for (const step of failed) lines.push(`failed ${step.key}${step.label ? ` (${step.label})` : ""}: ${step.error}`);
  if (run.error) lines.push(`${run.error.reason ?? "error"}: ${run.error.message}${run.error.stepKey ? ` (${run.error.stepKey})` : ""}`);
  if (run.waitingFor) lines.push(`Waiting for signal ${JSON.stringify(run.waitingFor.key)}${run.waitingFor.prompt ? `: ${run.waitingFor.prompt}` : ""}`);
  if (run.waitingFor?.schema) lines.push(`Expects: ${JSON.stringify(run.waitingFor.schema)}`);
  if (run.result !== undefined) lines.push(modelResult(run.result, run.id, RESULT_BYTES, program).text);
  else if (run.resultRef) lines.push(`The result is stored separately; fetch it with result ${run.id}.`);
  return { view, text: lines.join("\n") };
}

/** How a view names the next step: a CLI command, or a call of the Pi tool. */
export interface Hints { signal(runId: string, key: string): string; retry(runId: string): string }

export function cliHints(program = "workflow"): Hints {
  return { signal: (id, key) => `${program} signal ${id} ${JSON.stringify(key)} '<json>'`, retry: id => `${program} retry ${id}` };
}

export const toolHints: Hints = {
  signal: (id, key) => `{"action":"signal","runId":${JSON.stringify(id)},"key":${JSON.stringify(key)},"value":<JSON value, not a string>}`,
  retry: id => `{"action":"retry","runId":${JSON.stringify(id)}}`,
};

/** The verbose view: the step tree, then each step's own result. */
export function runDetail(run: RunRecord, program: string | Hints = "workflow"): string {
  const results = run.steps.filter(step => step.result !== undefined && step.kind !== "parallel" && step.kind !== "pipeline")
    .map(step => `${step.key}: ${typeof step.result === "string" ? step.result : JSON.stringify(step.result)}`);
  const sections = [runTree(run, Date.now(), program)];
  if (results.length) sections.push(`Step results:\n${results.join("\n")}`);
  if (run.result !== undefined) sections.push(`Result:\n${typeof run.result === "string" ? run.result : json(run.result)}`);
  return modelResult(sections.join("\n\n"), run.id, RESULT_BYTES, typeof program === "string" ? program : "workflow").text;
}

export function validationText(result: ValidationResult): string {
  const problems = result.diagnostics.map(item => `${item.line === undefined ? "" : `line ${item.line}: `}${item.message}${item.code ? ` (${item.code})` : ""}`);
  return result.valid ? [`Valid: ${result.name} (${result.path}).`, ...problems].join("\n") : ["Invalid:", ...problems].join("\n");
}

export function catalogText(entries: CatalogEntry[]): string {
  return entries.map(entry => entry.error
    ? `${entry.name} (${entry.source}) cannot load: ${entry.error}`
    : `${entry.name} (${entry.source})${entry.description ? `: ${entry.description}` : ""}\n  args: ${JSON.stringify(entry.args)}`).join("\n");
}

function stepLine(step: StepRecord, now: number): string {
  const elapsed = step.startedAt === undefined ? "" : ` ${duration((step.endedAt ?? now) - step.startedAt)}`;
  const tokens = step.usage ? ` ${step.usage.inputTokens + step.usage.outputTokens} tokens` : "";
  const label = step.label && step.label !== step.key ? ` ${step.label}` : "";
  const error = step.error ? ` — ${step.error.reason ?? "error"}: ${step.error.message}` : "";
  return `  ${step.key}${label} [${step.status}]${elapsed}${tokens}${error}`;
}

/** A complete progress view derived from one status response. */
export function runTree(run: RunRecord, now = Date.now(), program: string | Hints = "workflow"): string {
  const hints = typeof program === "string" ? cliHints(program) : program;
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
  if (run.parked) lines.push(`Parked after repeated restarts. Resume with: ${hints.retry(run.id)}`);
  if (run.waitingFor) {
    if (run.waitingFor.prompt) lines.push(run.waitingFor.prompt);
    lines.push(`Waiting for ${run.waitingFor.key}; deliver with: ${hints.signal(run.id, run.waitingFor.key)}`);
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
export function modelResult(value: unknown, runId?: string, limit = RESULT_BYTES, program = "workflow"): {
  text: string; truncated: boolean;
} {
  const full = typeof value === "string" ? value : json(value);
  if (Buffer.byteLength(full) <= limit) return { text: full, truncated: false };
  const pointer = runId
    ? `Full result: ${program} result ${runId} --json (or workflow action "result", runId "${runId}").`
    : 'Use the CLI with --json for the complete response.';
  const suffix = `\n[Truncated at ${limit} bytes. ${pointer}]`;
  const budget = Math.max(0, limit - Buffer.byteLength(suffix));
  let text = Buffer.from(full).subarray(0, budget).toString("utf8");
  if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text: text + suffix, truncated: true };
}
