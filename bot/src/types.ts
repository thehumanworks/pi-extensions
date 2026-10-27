import type { Models } from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface CapabilityInfo { name: string; source: string; description?: string }
export interface BotInfo {
  name: string;
  description: string;
  sourceDir: string;
  stateDir: string;
  format: 2;
  inherit: "none" | "global";
  model?: string;
  thinking?: ThinkingLevel;
  revision: string;
  tools: CapabilityInfo[];
  skills: CapabilityInfo[];
  diagnostics: string[];
}
export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number;
}
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface BotRunRecord {
  runId: string;
  sessionId: string;
  bot: string;
  cwd: string;
  status: RunStatus;
  output: string;
  error?: string;
  model?: string;
  usage: Usage;
  toolCalls: number;
  createdAt: string;
  updatedAt: string;
}
export interface BotSessionInfo {
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
}
export interface BotEvent {
  type: string;
  sessionId?: string;
  runId?: string;
  data?: unknown;
}
export interface RunOptions {
  /** Omit or use "new" for a new conversation, "last" for this cwd's latest. */
  session?: string;
  cwd?: string;
  requestId?: string;
  signal?: AbortSignal;
  onEvent?: (event: BotEvent) => void;
}
export interface OpenBotOptions {
  cwd?: string;
  stateDir?: string;
  model?: string;
  thinking?: ThinkingLevel;
  /** Pi's model collection. Omitted: use ModelRuntime with the user's existing Pi auth. */
  models?: Models;
  /** Pi user config/auth directory; NEVER replaced by the bot's state directory. */
  agentDir?: string;
  /** Isolate source and state in a temporary directory. Does not sandbox tools/workspace. */
  ephemeral?: boolean;
}
export interface InitBotOptions {
  name?: string;
  description?: string;
  prompt?: string;
  model?: string;
  inherit?: "none" | "global";
}
export interface ReloadResult { changed: boolean; revision: string; diagnostics: string[] }
export interface BotToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: unknown;
  isError?: boolean;
}
export interface BotHandle {
  readonly sourceDir: string;
  readonly stateDir: string;
  info(): Promise<BotInfo>;
  submit(message: string, options?: RunOptions): Promise<BotRunRecord>;
  run(message: string, options?: RunOptions): Promise<BotRunRecord>;
  getRun(runId: string): Promise<BotRunRecord>;
  listSessions(): Promise<BotSessionInfo[]>;
  /** Snapshot plus subsequent updates; reconnect by subscribing again. */
  watch(sessionId: string, listener: (event: BotEvent) => void): Promise<() => Promise<void>>;
  cancel(runId: string): Promise<void>;
  callTool(name: string, input: unknown, options?: { session?: string; signal?: AbortSignal }): Promise<BotToolResult>;
  reload(): Promise<ReloadResult>;
  close(): Promise<void>;
}
