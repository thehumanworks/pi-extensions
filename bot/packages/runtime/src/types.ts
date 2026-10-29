import type { Models } from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface CapabilityInfo { name: string; source: string; description?: string }
export interface BotInfo {
  name: string;
  description: string;
  sourceDir: string;
  stateDir: string;
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
/** Read-only recall over one bot home's persisted conversations, regardless of cwd. */
export interface BotHistoryQuery {
  action: "list" | "search" | "read";
  session?: string;
  query?: string;
  entryId?: number;
  /** UTF-16 character offset in the readable entry projection; requires entryId. */
  offset?: number;
  limit?: number;
  cursor?: string;
}
export interface BotHistoryEntry {
  sessionId: string;
  cwd: string;
  entryId: number;
  kind: "message";
  text: string;
  offset: number;
  totalChars: number;
  nextOffset?: number;
}
export interface BotHistoryPage {
  items: Array<BotSessionInfo | BotHistoryEntry>;
  /** Continue even when items is empty: search work is bounded per call. */
  nextCursor?: string;
}
/** Bot-owned public transcript. Provider metadata, credentials and private system context never cross this boundary. */
export type BotContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "image"; mimeType: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export interface BotMessage {
  role: "user" | "assistant" | "toolResult";
  content: BotContent[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}
export interface BotTranscriptEntry {
  /** Immutable positive identifier scoped to the session. Gaps are allowed. */
  id: number;
  kind: "message";
  model: BotMessage[];
}
export type BotMessageChange =
  | { type: "message"; message: BotMessage }
  | { type: "block" | "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: BotContent }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string };
export interface BotToolActivity {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  parentToolCallId?: string;
  status: "running" | "completed" | "failed";
  /** Bounded display summary, not a second full tool result. */
  summary?: string;
}
export interface BotSnapshot {
  /** Current or most recent run for this session. */
  run?: BotRunRecord;
  /** Recent completed entries; full history is paged through bot_history. */
  entries: BotTranscriptEntry[];
  generation?: { message: BotMessage };
  tools: BotToolActivity[];
  notice?: string;
}
export interface BotEventData {
  snapshot: BotSnapshot;
  message_start: { message: BotMessage };
  message_update: { changes: BotMessageChange[] };
  message_end: { entry: BotTranscriptEntry };
  tool_execution_start: Omit<BotToolActivity, "status">;
  tool_execution_update: Omit<BotToolActivity, "status">;
  tool_execution_end: Omit<BotToolActivity, "status"> & { isError: boolean; entry?: BotTranscriptEntry };
  run_start: Record<string, never>;
  turn_start: Record<string, never>;
  turn_end: Record<string, never>;
  run_end: Record<string, never>;
  auto_retry_start: { attempt: number; errorMessage: string };
  auto_retry_end: { success: boolean; errorMessage?: string };
  compaction_start: Record<string, never>;
  compaction_end: { error?: string };
  task_failed: { message: string };
  error: { code: string; message: string };
  run_accepted: BotRunRecord;
  run_settled: BotRunRecord;
}
/** Stable, unversioned wire contract shared by SDK, workers, HTTP and terminal consumers. */
export type BotEvent = { [K in keyof BotEventData]: {
  type: K;
  sessionId?: string;
  runId?: string;
  data: BotEventData[K];
} }[keyof BotEventData];
export interface RunOptions {
  /** Omit or use "new" for a new conversation, "last" for this cwd's latest. */
  session?: string;
  cwd?: string;
  requestId?: string;
  signal?: AbortSignal;
  onEvent?: (event: BotEvent) => void;
}
export interface OpenBotOptions {
  /** Execution workspace only; never selects the bot's memory/history. */
  cwd?: string;
  /** Explicit alternate persistence home; default <canonical source>/.bot. */
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
  excludeTools?: string[];
  excludeExtensions?: string[];
  excludeMcpServers?: string[];
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
