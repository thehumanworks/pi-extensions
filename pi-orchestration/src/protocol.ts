import { readFile, stat } from "node:fs/promises";
import { Type, type TProperties } from "typebox";
import { Value } from "typebox/value";
import type { ModelRef, RunBudget, RunRecord, RunStatus, StepKey, ThinkingLevel } from "./index.ts";
import { WorkflowError } from "./errors.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled", "reverted", "outdated"]);
export function isTerminal(status: RunStatus): boolean { return TERMINAL_STATUSES.has(status); }
export interface WorkerStatus { version: number; build?: string; pid: number; home: string; uptimeMs: number }
/**
 * The build of the worker this package spawns: the package version and when dist/worker.js was written, so an
 * upgrade or `npm run build` changes it. The worker reports it from startup; clients compare it with the current
 * one. PI_WORKFLOW_BUILD overrides it for tests. Undefined when dist/worker.js is missing.
 */
export async function workerBuild(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.PI_WORKFLOW_BUILD) return env.PI_WORKFLOW_BUILD;
  try {
    const [manifest, worker] = await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"), stat(new URL("../dist/worker.js", import.meta.url)),
    ]);
    return `${(JSON.parse(manifest) as { version: string }).version}+${worker.mtime.toISOString()}`;
  } catch { return undefined; }
}
export type WorkflowRef = { path: string } | { name: string };
export type ControlRequest =
  | { action: "ping" | "stop" }
  | { action: "run"; requestId: string; workflow: WorkflowRef; args?: unknown; cwd: string; model?: ModelRef; thinkingLevel?: ThinkingLevel; origin: RunRecord["origin"]; budget?: RunBudget; callerRunId?: string; callerStep?: string }
  | { action: "status"; runId: string; verbose?: boolean }
  | { action: "list"; filter?: { status?: RunStatus[]; workflow?: string; all?: boolean; limit?: number } }
  | { action: "result" | "cancel"; runId: string }
  | { action: "retry"; runId: string; from?: StepKey; allowChanged?: boolean }
  | { action: "revert"; runId: string; keepWorktrees?: boolean }
  | { action: "signal"; runId: string; key: string; value: unknown }
  | { action: "steer"; runId: string; agent: string; message: string }
  | { action: "agents"; runId?: string }
  | { action: "catalog"; cwd: string }
  | { action: "validate"; workflow: WorkflowRef; cwd: string };
export type ControlResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; stepKey?: string } };

const text = Type.String({ minLength: 1, maxLength: MAX_REQUEST_BYTES });
const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const reference = Type.Union([object({ path: text }), object({ name: text })]);
const model = Type.Union([Type.String({ pattern: "^[^/]+/.+$" }), object({ provider: text, modelId: text })]);
const budget = object({ maxAgents: Type.Optional(Type.Integer({ minimum: 0 })), maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })), maxTokens: Type.Optional(Type.Integer({ minimum: 0 })), maxDurationMs: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) });
const statuses = ["queued", "running", "waiting_signal", "completed", "failed", "cancelled", "reverted", "outdated"] as const;
const origin = Type.Union([
  object({ kind: Type.Literal("cli") }),
  object({ kind: Type.Literal("tool"), sessionId: text }),
  object({ kind: Type.Literal("workflow"), parentRunId: text, stepKey: text }),
]);
const schemas = {
  ping: object({ action: Type.Literal("ping") }),
  stop: object({ action: Type.Literal("stop") }),
  run: object({ action: Type.Literal("run"), requestId: text, workflow: reference, args: Type.Optional(Type.Unknown()), cwd: text, model: Type.Optional(model), thinkingLevel: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(x => Type.Literal(x)))), origin, budget: Type.Optional(budget), callerRunId: Type.Optional(text), callerStep: Type.Optional(text) }),
  status: object({ action: Type.Literal("status"), runId: text, verbose: Type.Optional(Type.Boolean()) }),
  list: object({ action: Type.Literal("list"), filter: Type.Optional(object({ status: Type.Optional(Type.Array(Type.Union(statuses.map(x => Type.Literal(x))))), workflow: Type.Optional(text), all: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })) })) }),
  result: object({ action: Type.Literal("result"), runId: text }),
  cancel: object({ action: Type.Literal("cancel"), runId: text }),
  retry: object({ action: Type.Literal("retry"), runId: text, from: Type.Optional(text), allowChanged: Type.Optional(Type.Boolean()) }),
  revert: object({ action: Type.Literal("revert"), runId: text, keepWorktrees: Type.Optional(Type.Boolean()) }),
  signal: object({ action: Type.Literal("signal"), runId: text, key: text, value: Type.Unknown() }),
  steer: object({ action: Type.Literal("steer"), runId: text, agent: text, message: text }),
  agents: object({ action: Type.Literal("agents"), runId: Type.Optional(text) }),
  catalog: object({ action: Type.Literal("catalog"), cwd: text }),
  validate: object({ action: Type.Literal("validate"), workflow: reference, cwd: text }),
};
export function validateRequest(value: unknown): ControlRequest {
  if (!value || typeof value !== "object" || !("action" in value) || typeof value.action !== "string" || !Object.hasOwn(schemas, value.action)) {
    throw new WorkflowError("invalid_request", "Unknown workflow action. Use run, status, list, result, cancel, retry, revert, signal, steer, agents, catalog or validate.");
  }
  const action = value.action as keyof typeof schemas;
  const schema = schemas[action];
  if (!Value.Check(schema, value)) throw new WorkflowError("invalid_request", `Invalid ${action} request: ${JSON.stringify(Value.Errors(schema, value))}`);
  return value as ControlRequest;
}
