import { createHash } from 'node:crypto';
import type { BotEvent, BotInfoSummary, BotRun, BotSession, BotUsage } from './types.js';

export const LIMITS = Object.freeze({
  requestBytes: 1024 * 1024, textChars: 100_000, messages: 1000, parts: 1024,
  responseBytes: 8 * 1024 * 1024, eventBytes: 8 * 1024 * 1024,
  bufferBytes: 1024 * 1024, entries: 10_000, snapshotTimeoutMs: 15_000,
  requestTimeoutMs: 30_000, pollIntervalMs: 250,
});
export class BotAdapterError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'BotAdapterError'; }
}
export function bad(message = 'Invalid request'): never { throw new BotAdapterError(400, 'INVALID_INPUT', message); }
export function invalid(): never { throw new BotAdapterError(502, 'INVALID_BACKEND_RESPONSE', 'Bot returned an invalid response'); }
export function safeError(error: unknown): BotAdapterError {
  if (error instanceof BotAdapterError) return error;
  const code = record(error).code;
  if (code === 'NOT_FOUND') return new BotAdapterError(404, 'NOT_FOUND', 'Bot resource was not found');
  if (code === 'CONFLICT') return new BotAdapterError(409, 'CONFLICT', 'Request ID conflicts with an earlier submission');
  if (code === 'INVALID_INPUT') return new BotAdapterError(400, 'INVALID_INPUT', 'Bot rejected the request');
  return new BotAdapterError(503, 'BACKEND_UNAVAILABLE', 'Bot is unavailable; inspect history before retrying');
}
export function errorResponse(error: unknown): Response {
  const e = safeError(error);
  return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status, headers: { 'Cache-Control': 'no-store' } });
}
export function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function id(value: unknown, name = 'identifier'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\/\\\u0000-\u0020\u007f]/.test(value) || value === '.' || value === '..' || value === 'new' || value === 'last') bad(`Invalid ${name}`);
  return value;
}
export const stableId = (...parts: unknown[]): string => `bot-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;
export const terminal = (run: BotRun): boolean => ['completed', 'failed', 'cancelled'].includes(run.status);
export function bounded(value: unknown, bytes = LIMITS.responseBytes): void {
  try { if (Buffer.byteLength(JSON.stringify(value) ?? '') > bytes) invalid(); }
  catch (e) { if (e instanceof BotAdapterError) throw e; invalid(); }
}
export function usage(value: unknown): BotUsage {
  const v = record(value); const out = {} as BotUsage;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'turns'] as const) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || v[key] < 0) invalid();
    out[key] = v[key];
  }
  return out;
}
export function run(value: unknown): BotRun {
  bounded(value); const v = record(value);
  try { id(v.runId); id(v.sessionId); } catch { invalid(); }
  if (!['queued', 'running', 'completed', 'failed', 'cancelled'].includes(v.status) || typeof v.output !== 'string') invalid();
  // Never forward backend error strings (they can contain provider keys or paths).
  return { runId: v.runId, sessionId: v.sessionId, status: v.status, output: v.output,
    bot: typeof v.bot === 'string' ? v.bot : '', cwd: typeof v.cwd === 'string' ? v.cwd : '',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : '', updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    usage: usage(v.usage), toolCalls: typeof v.toolCalls === 'number' ? v.toolCalls : 0,
    ...(typeof v.model === 'string' ? { model: v.model } : {}),
    ...(v.status === 'failed' ? { error: 'Bot run failed; inspect the backend logs' } : {}) };
}
export function session(value: unknown): BotSession {
  const v = record(value); try { id(v.sessionId); } catch { invalid(); }
  if (typeof v.cwd !== 'string' || typeof v.createdAt !== 'string' || typeof v.updatedAt !== 'string' || (v.title !== undefined && typeof v.title !== 'string')) invalid();
  return { sessionId: v.sessionId, cwd: v.cwd, createdAt: v.createdAt, updatedAt: v.updatedAt, ...(v.title === undefined ? {} : { title: v.title }) };
}
export function sessions(value: unknown): BotSession[] {
  bounded(value); if (!Array.isArray(value) || value.length > LIMITS.entries) invalid();
  return value.map(session);
}
export function info(value: unknown): BotInfoSummary {
  bounded(value); const v = record(value);
  if (typeof v.name !== 'string' || typeof v.description !== 'string' || typeof v.revision !== 'string') invalid();
  const capabilities = (items: unknown) => {
    if (!Array.isArray(items) || items.length > LIMITS.entries) invalid();
    return items.map(item => { const c = record(item); if (typeof c.name !== 'string') invalid();
      return { name: c.name as string, ...(typeof c.description === 'string' ? { description: c.description } : {}) }; });
  };
  return { name: v.name, description: v.description, revision: v.revision, tools: capabilities(v.tools), skills: capabilities(v.skills),
    ...(typeof v.model === 'string' ? { model: v.model } : {}), ...(typeof v.thinking === 'string' ? { thinking: v.thinking } : {}) };
}
export function event(value: unknown, expectedSession?: string): BotEvent {
  bounded(value, LIMITS.eventBytes); const v = record(value);
  if (typeof v.type !== 'string' || !v.type || v.type.length > 128) invalid();
  try { if (v.sessionId !== undefined) id(v.sessionId); if (v.runId !== undefined) id(v.runId); } catch { invalid(); }
  if (expectedSession && v.sessionId !== undefined && v.sessionId !== expectedSession) invalid();
  return v as unknown as BotEvent;
}
export async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<string> {
  if (!body) return '';
  const reader = body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', aborted, { once: true });
  let text = ''; let bytes = 0;
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new BotAdapterError(413, 'BODY_TOO_LARGE', 'Message data exceeds the size limit');
      text += decoder.decode(value, { stream: true });
    }
  } finally { signal?.removeEventListener('abort', aborted); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function sameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new BotAdapterError(403, 'ORIGIN_REJECTED', 'Cross-origin mutations are not allowed');
}
