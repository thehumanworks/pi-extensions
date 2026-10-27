import type { Static, TSchema } from "typebox";
export { Type } from "typebox";
import type { BotToolResult } from "./types.js";

/** Tool context shared by all SDK entry points. Paths are absolute. */
export interface BotToolContext {
  cwd: string;
  sourceDir: string;
  stateDir: string;
  signal: AbortSignal;
  sessionId: string;
  runId?: string;
}
export interface BotToolDefinition<P extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: P;
  /** Default unsafe: an interrupted external effect is never blindly retried. */
  replay?: "safe" | "unsafe";
  execute(args: Static<P>, ctx: BotToolContext): unknown | Promise<unknown>;
}
export interface BotExtensionDefinition {
  name: string;
  tools?: readonly BotToolDefinition[];
  instructions?: string;
}
/** Identity helper; TypeBox parameters infer execute's args. */
export function defineTool<P extends TSchema>(tool: BotToolDefinition<P>): BotToolDefinition<P> { return tool; }
export function defineExtension(extension: BotExtensionDefinition): BotExtensionDefinition { return extension; }

/** Reject non-JSON data instead of allowing a later durable commit to fault. */
export function serializable<T>(value: T): T {
  const seen = new Set<object>();
  function check(item: unknown): void {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null) throw new Error("Tool results must be JSON serializable (no undefined, functions, bigint or non-finite numbers).");
    if (seen.has(item)) throw new Error("Tool result contains a cycle.");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Tool results must contain only plain JSON objects.");
    seen.add(item);
    for (const child of Array.isArray(item) ? Array.from(item) : Object.values(item)) check(child);
    seen.delete(item);
  }
  check(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
export function toolResult(value: unknown): BotToolResult {
  if (value && typeof value === "object" && "content" in value) {
    const result = value as BotToolResult;
    if (!Array.isArray(result.content) || result.content.some(part => !part || (part.type === "text" ? typeof part.text !== "string" : part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string"))) throw new Error("Invalid BotToolResult content.");
    if (result.isError !== undefined && typeof result.isError !== "boolean") throw new Error("BotToolResult.isError must be boolean.");
    const unsupported = Object.keys(result).filter(key => !["content", "details", "isError"].includes(key));
    if (unsupported.length) throw new Error(`Unsupported BotToolResult fields: ${unsupported.join(", ")}.`);
    return serializable({ content: result.content, ...(result.details === undefined ? {} : { details: result.details }), ...(result.isError === undefined ? {} : { isError: result.isError }) });
  }
  const result = serializable(value === undefined ? null : value);
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
}
