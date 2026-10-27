import { Type, type Static, type TSchema, type TObject } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";

export type RunId = string;
export type StepKey = string;
export type ModelRef = { provider: string; modelId: string } | `${string}/${string}`;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RunBudget { maxAgents?: number; maxCostUsd?: number; maxTokens?: number; maxDurationMs?: number }
export interface AgentSpec {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  instructions?: string;
  tools?: string[] | { remove: string[] };
  cwd?: string;
  isolation?: "none" | "worktree";
  budget?: { maxCostUsd?: number; maxTurns?: number };
  timeoutMs?: number;
  retries?: number;
}
export interface AgentOptions extends AgentSpec { label?: string; phase?: string; agentType?: string; key?: string }
export type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: { message: string; code?: string } };
export type PipelineStage<In, Out, Item> = (prev: In, item: Item, index: number) => Promise<Out> | Out;
export interface BackgroundAgent {
  readonly name: string;
  readonly conversationId: string;
  send(message: string, options?: { whenBusy?: "steer" | "followUp" }): Promise<void>;
  wait(options?: { timeoutMs?: number }): Promise<string>;
  status(): Promise<"idle" | "busy" | "stopped">;
  stop(): Promise<void>;
}
export interface SwarmOptions<Item, Out> {
  workers: number;
  queue: readonly Item[] | { initial: readonly Item[]; allowPush?: boolean };
  worker: AgentSpec & { prompt: (item: Item, blackboard: string) => string; schema?: TSchema };
  until?: (state: { processed: number; remaining: number; results: Out[]; blackboard: string }) => boolean;
  label?: string;
  phase?: string;
}
export interface WorkflowContext<Args = unknown> {
  readonly runId: RunId;
  readonly args: Args;
  readonly cwd: string;
  readonly depth: number;
  readonly budget: { costUsd: number | null; agents: number | null };
  agent<S extends TSchema>(prompt: string, options: AgentOptions & { schema: S }): Promise<Static<S>>;
  agent(prompt: string, options?: AgentOptions): Promise<string>;
  parallel<T>(thunks: ReadonlyArray<() => Promise<T>>, options: { concurrency?: number; failure: "allSettled" }): Promise<Settled<T>[]>;
  parallel<T>(thunks: ReadonlyArray<() => Promise<T>>, options?: { concurrency?: number; failure?: "null" | "failFast" }): Promise<Array<T | null>>;
  pipeline<T, A>(items: readonly T[], s1: PipelineStage<T, A, T>): Promise<Array<A | null>>;
  pipeline<T, A, B>(items: readonly T[], s1: PipelineStage<T, A, T>, s2: PipelineStage<A, B, T>): Promise<Array<B | null>>;
  pipeline<T, A, B, C>(items: readonly T[], s1: PipelineStage<T, A, T>, s2: PipelineStage<A, B, T>, s3: PipelineStage<B, C, T>): Promise<Array<C | null>>;
  pipeline<T, A, B, C, D>(items: readonly T[], s1: PipelineStage<T, A, T>, s2: PipelineStage<A, B, T>, s3: PipelineStage<B, C, T>, s4: PipelineStage<C, D, T>): Promise<Array<D | null>>;
  step<T>(key: string, fn: (step: { signal: AbortSignal; log(msg: string): void }) => Promise<T>, options?: { retries?: number; compensate?: (result: T) => Promise<void> }): Promise<T>;
  workflow<R = unknown>(nameOrRef: string | { path: string }, args?: unknown): Promise<R>;
  signal<S extends TSchema = TSchema>(key: string, options?: { schema?: S; timeoutMs?: number; prompt?: string }): Promise<Static<S>>;
  sleep(ms: number): Promise<void>;
  spawn(options: AgentOptions & { name: string; initialPrompt?: string; detach?: boolean }): Promise<BackgroundAgent>;
  swarm<Item, Out>(options: SwarmOptions<Item, Out>): Promise<{ results: Out[]; blackboard: string; processed: number }>;
  phase(title: string): void;
  log(message: string, data?: unknown): void;
  now(): number;
  random(): number;
}
export interface WorkflowDefinition<A extends TSchema = TSchema, R = unknown> {
  name: string;
  description?: string;
  args?: A;
  agents?: Record<string, AgentSpec>;
  defaults?: AgentSpec;
  budget?: RunBudget;
  /** Extra durable tools; explicitly add their names to an agent's tool allowlist. */
  tools?: readonly ToolRegistration[];
  run: (ctx: WorkflowContext<Static<A>>) => Promise<R>;
}
/** Define a typed workflow. Loading and launch perform runtime schema and option validation. */
export function defineWorkflow<A extends TSchema = TObject<{}>, R = unknown>(definition: WorkflowDefinition<A, R>): WorkflowDefinition<A, R> {
  if (!definition || typeof definition.name !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.name)) {
    throw new Error("Workflow name must be kebab-case, for example 'review-changes'.");
  }
  if (typeof definition.run !== "function") throw new Error("Workflow must define an async run(ctx) function.");
  return { ...definition, args: definition.args ?? Type.Object({}, { additionalProperties: false }) as unknown as A };
}

export type RunStatus = "queued" | "running" | "waiting_signal" | "completed" | "failed" | "cancelled" | "reverted" | "outdated";
export interface Usage { inputTokens: number; outputTokens: number; costUsd?: number }
export interface StepRecord {
  key: StepKey;
  kind: "agent" | "step" | "signal" | "sleep" | "workflow" | "spawn" | "swarm" | "parallel" | "pipeline" | "phase" | "log" | "now" | "random";
  label?: string;
  phase?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" | "compensated";
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  conversationId?: string;
  usage?: Usage;
  error?: { message: string; reason?: string; code?: string };
  result?: unknown;
  resultRef?: string;
  worktree?: { path: string; branch: string };
}
export interface RunRecord {
  id: RunId;
  workflow: { name: string; path: string; hash: string };
  args: unknown;
  cwd: string;
  model?: ModelRef;
  budget?: RunBudget;
  status: RunStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  attempt: number;
  phases: Array<{ title: string; agents: number; done: number; tokens: number; elapsedMs: number }>;
  steps: StepRecord[];
  usage: Usage & { agents: number };
  result?: unknown;
  resultRef?: string;
  error?: { message: string; reason?: string; code?: string; stepKey?: StepKey };
  origin: { kind: "tool"; sessionId: string } | { kind: "cli" } | { kind: "workflow"; parentRunId: RunId; stepKey: StepKey };
  depth: number;
  children: RunId[];
  logs?: Array<{ time: number; message: string; data?: unknown }>;
  parked?: boolean;
  waitingFor?: { key: string; prompt?: string; deadline?: number };
  worktrees?: Array<{ path: string; branch: string }>;
}
export interface BackgroundAgentRecord {
  runId: RunId;
  name: string;
  conversationId: string;
  status: "idle" | "busy" | "stopped";
  /** True only while the conversation has admitted work; queued messages may be busy but inactive. */
  active?: boolean;
  detached: boolean;
}
export interface CatalogEntry { name: string; description?: string; path: string; args: TSchema; source: "project" | "user" }
export interface ValidationResult { valid: boolean; path?: string; name?: string; hash?: string; args?: TSchema; diagnostics: Array<{ message: string; line?: number; code?: string }> }
