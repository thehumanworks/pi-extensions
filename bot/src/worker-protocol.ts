import type { BotErrorCode } from "./errors.js";
import type { BotEvent, BotInfo, BotRunRecord, BotSessionInfo, BotToolResult, OpenBotOptions, ReloadResult, RunOptions } from "./types.js";

export type WorkerOpenOptions = Omit<OpenBotOptions, "models">;
export type WorkerRunOptions = Pick<RunOptions, "session" | "cwd" | "requestId">;
export interface WorkerMethods {
  init: { input: { source: string; options: WorkerOpenOptions; closeTimeoutMs: number; maxMessageBytes: number }; output: BotInfo };
  info: { input: undefined; output: BotInfo };
  submit: { input: { message: string; options: WorkerRunOptions; events: boolean }; output: BotRunRecord };
  run: { input: { message: string; options: WorkerRunOptions; events: boolean }; output: BotRunRecord };
  getRun: { input: { runId: string }; output: BotRunRecord };
  listSessions: { input: undefined; output: BotSessionInfo[] };
  watch: { input: { sessionId: string }; output: null };
  unwatch: { input: { subscription: number }; output: null };
  cancel: { input: { runId: string }; output: null };
  callTool: { input: { name: string; input: unknown; session?: string }; output: BotToolResult };
  reload: { input: undefined; output: ReloadResult };
  close: { input: undefined; output: null };
}
export type WorkerMethod = keyof WorkerMethods;
export type WorkerRequest = { [M in WorkerMethod]: { type: "request"; id: number; method: M; params: WorkerMethods[M]["input"] } }[WorkerMethod];
export type WorkerInput = WorkerRequest | { type: "abort"; id: number };
export interface WorkerError { name: string; code?: BotErrorCode; message: string }
export type WorkerOutput =
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; error: WorkerError }
  | { type: "event"; id: number; event: BotEvent }
  | { type: "settled"; id: number };
export const WORKER_METHODS = new Set<string>(["init", "info", "submit", "run", "getRun", "listSessions", "watch", "unwatch", "cancel", "callTool", "reload", "close"]);
export const ERROR_CODES = new Set<string>(["NOT_FOUND", "INVALID_INPUT", "CONFLICT", "UNAVAILABLE"]);
export const DEFAULT_MESSAGE_LIMIT = 4 * 1024 * 1024;
export function messageBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
export function validId(id: unknown): id is number { return typeof id === "number" && Number.isSafeInteger(id) && id > 0; }
