import type { UIMessage } from 'ai';

export type BotRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface BotUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }
/** Structural copy of the runtime's public run record, not a runtime dependency. */
export interface BotRun {
  runId: string; sessionId: string; bot: string; cwd: string; status: BotRunStatus;
  output: string; error?: string; model?: string; usage: BotUsage; toolCalls: number;
  createdAt: string; updatedAt: string;
}
export interface BotSession { sessionId: string; cwd: string; createdAt: string; updatedAt: string; title?: string }
export interface BotCapability { name: string; description?: string }
/** Public display fields only; backend filesystem paths and diagnostics are not projected. */
export interface BotInfoSummary {
  name: string; description: string; revision: string;
  model?: string; thinking?: string; tools: BotCapability[]; skills: BotCapability[];
}
export interface BotEvent { type: string; sessionId?: string; runId?: string; data?: unknown }
export interface BotSubmitOptions {
  session?: string; requestId?: string; onEvent?: (event: BotEvent) => void;
}
export interface BotWatchOptions { onError?: (error: Error) => void }
export interface BotBackend {
  info(): Promise<BotInfoSummary>;
  submit(message: string, options?: BotSubmitOptions): Promise<BotRun>;
  getRun(runId: string): Promise<BotRun>;
  listSessions(): Promise<BotSession[]>;
  watch(sessionId: string, listener: (event: BotEvent) => void, options?: BotWatchOptions): Promise<() => Promise<void>>;
  cancel(runId: string): Promise<void>;
}
export interface BotRunData { runId: string; sessionId: string; status: BotRunStatus }
export interface BotToolData {
  toolCallId: string; toolName: string; state: 'running' | 'completed' | 'failed';
  input?: unknown; output?: unknown; parentToolCallId?: string;
}
export type BotDataParts = {
  'bot-run': BotRunData;
  'bot-tool': BotToolData;
  'bot-progress': { type: string; attempt?: number };
  'bot-usage': BotUsage;
};
export type BotUIMessage = UIMessage<unknown, BotDataParts>;
export interface BotHistory { messages: BotUIMessage[]; session: BotSession; run?: BotRun }
export interface BotChatAdapter {
  chat(request: Request): Promise<Response>;
  resume(request: Request, sessionId: string, runId?: string): Promise<Response>;
  history(sessionId: string): Promise<BotHistory>;
  sessions(): Promise<BotSession[]>;
  info(): Promise<BotInfoSummary>;
  cancel(runId: string): Promise<void>;
}
