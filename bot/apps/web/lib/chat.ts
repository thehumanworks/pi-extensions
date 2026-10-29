import type { BotRun, BotSession, BotUIMessage } from "@nothumanwork/bot-ai-sdk";

export type RunState = Pick<BotRun, "runId" | "sessionId" | "status">;
export type PendingSubmission = { message: BotUIMessage; userCountBefore: number; runIdBefore?: string };
export type History = { messages: BotUIMessage[]; session: BotSession; run?: BotRun };
export const isActive = (run?: RunState) => run?.status === "queued" || run?.status === "running";
export const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);

export function runData(value: unknown): RunState | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  if (!validId(data.runId) || !validId(data.sessionId) || !["queued", "running", "completed", "failed", "cancelled"].includes(String(data.status))) return;
  return { runId: data.runId, sessionId: data.sessionId, status: data.status as RunState["status"] };
}

/** Recover a lost admission acknowledgement without silently dropping an optimistic user turn. */
export function submissionInHistory(pending: PendingSubmission, messages: BotUIMessage[], run?: RunState): boolean {
  return messages.some(message => message.id === pending.message.id)
    || messages.filter(message => message.role === "user").length > pending.userCountBefore
    || (run !== undefined && run.runId !== pending.runIdBefore);
}

export function latestUserId(messages: BotUIMessage[]): string | undefined {
  return messages.findLast(message => message.role === "user")?.id;
}

export function sessionTitle(session: BotSession): string {
  return session.title?.trim() || `Session ${session.sessionId.slice(0, 8)}`;
}

export function readableJson(value: unknown): string {
  if (value === undefined) return "Not available yet";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? "Not available yet"; }
  catch { return "Unable to display this value"; }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  if (!response.ok) {
    // Only display messages from our JSON route envelope, never raw HTML/errors.
    let message = `Request failed (${response.status}). Please retry.`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body) {
        if (typeof body.error === "string") message = body.error.slice(0, 500);
        else if (body.error && typeof body.error === "object" && "message" in body.error && typeof body.error.message === "string") message = body.error.message.slice(0, 500);
      }
    } catch { /* The network/proxy may not have sent JSON. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
