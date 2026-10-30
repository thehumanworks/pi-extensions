import { defineDoc, type ConversationId, type TaskId, type JsonObject } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentOptions, RunRecord, StepRecord, WorkflowDefinition } from "../index.ts";

export type JournalEntry = StepRecord & {
  fingerprint: string;
  sequence: number;
  generation: number;
  deadline?: number;
  submissionId?: string;
  signalKey?: string;
  schema?: JsonObject;
  signalPrompt?: string;
  submitted?: boolean;
  taskId?: TaskId;
  childRunId?: string;
  outputRound?: number;
  agentAttempt?: number;
  retryAt?: number;
  worktreeCwd?: string;
  accountedUsage?: { inputTokens: number; outputTokens: number; costUsd: number };
  compensatable?: boolean;
};

export type RunData = Omit<RunRecord, "steps" | "logs"> & {
  requestId: string;
  taskId: TaskId | null;
  cwd: string;
  thinkingLevel?: AgentOptions["thinkingLevel"];
  limits: NonNullable<WorkflowDefinition["budget"]>;
  steps: JournalEntry[];
  helpers: Record<string, { kind: string; value: JsonValue; sequence?: number }>;
  positions?: Record<string, { key: string; kind: string; sequence: number }>;
  nextSequence: number;
  signals: Record<string, JsonValue>;
  logs: Array<{ time: number; message: string; data?: JsonValue }>;
  currentPhase?: string;
  cancelRequested?: boolean;
  parked?: boolean;
  keepWorktrees?: boolean;
  reverting?: boolean;
};

export type AgentMetadata = {
  runId: string;
  stepKey: string;
  options: JsonObject;
  turns: number;
  seenResponses: string[];
  budgetError?: string;
};

export const RunStore = defineDoc<{
  runs: Record<string, JsonObject>;
  requests: Record<string, string>;
}>({ kind: "workflow.runs", version: 1, scope: "session", initial: () => ({ runs: {}, requests: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100 });

export const AgentMeta = defineDoc<AgentMetadata>({
  kind: "workflow.agent", version: 1, scope: "conversation",
  history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ runId: "", stepKey: "", options: {}, turns: 0, seenResponses: [] }),
});

export const StructuredResult = defineDoc<{ submitted: boolean; value: JsonValue }>({
  kind: "workflow.structured-result", version: 1, scope: "conversation",
  history: "latest", fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ submitted: false, value: null }),
});

export type AgentIdentity = { conversationId: ConversationId; runId: string; stepKey: string };

/** Durable JSON deliberately rejects values that would silently change on replay. */
export function json(value: unknown): JsonValue {
  if (value === undefined) return null;
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint" || typeof item === "function" || typeof item === "symbol")
      throw new TypeError("Workflow results must contain only JSON values.");
    if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("Workflow results cannot contain NaN or Infinity.");
    return item;
  });
  if (text === undefined) throw new TypeError("Workflow result is not JSON serializable.");
  return JSON.parse(text) as JsonValue;
}

export function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export function storedRun(value: JsonObject): RunData { return value as unknown as RunData; }

const RUN_FIELDS = ["id", "workflow", "args", "cwd", "model", "thinkingLevel", "budget", "status", "createdAt", "startedAt", "endedAt",
  "attempt", "phases", "steps", "usage", "result", "resultRef", "error", "origin", "depth", "children", "logs", "parked", "waitingFor", "worktrees"] as const;
const STEP_FIELDS = ["key", "kind", "label", "phase", "status", "attempts", "startedAt", "endedAt", "conversationId", "usage", "error",
  "result", "resultRef", "worktree", "childRunId"] as const;

function pick<T extends object>(value: T, fields: readonly string[]): Partial<T> {
  return Object.fromEntries(fields.filter(field => (value as Record<string, unknown>)[field] !== undefined)
    .map(field => [field, (value as Record<string, unknown>)[field]])) as Partial<T>;
}

/** The documented run shape. Journal bookkeeping stays inside the worker. */
export function publicRun(run: RunData): RunRecord {
  return { ...pick(run, RUN_FIELDS), steps: run.steps.map(step => pick(step, STEP_FIELDS)) } as RunRecord;
}
