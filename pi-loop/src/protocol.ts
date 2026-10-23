export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 128 * 1024;

export function intervalMs(frequency: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/i.exec(frequency.trim());
  if (!match) throw new Error("Frequency must be a positive interval such as 30s, 5m, 2h, 1d, or 1w.");
  const scales: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const ms = Number(match[1]) * scales[match[2].toLowerCase()];
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 365 * 86_400_000)
    throw new Error("Frequency must be between one second and 365 days, in whole milliseconds.");
  return ms;
}

export function parseLoop(text: string): { frequency: string; task: string } {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (!match || !match[2].trim()) throw new Error("Usage: /loop <frequency> <task> (for example /loop 5m check the build)");
  intervalMs(match[1]);
  return { frequency: match[1].toLowerCase(), task: match[2].trim() };
}

/** Fixed cadence; coalesce missed ticks instead of replaying a backlog. */
export function nextDue(previous: number, interval: number, now: number): number {
  return previous + Math.max(1, Math.floor((now - previous) / interval) + 1) * interval;
}

export type CreateRequest = {
  action: "create";
  requestId: string;
  frequency: string;
  prompt: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};
export type Request = CreateRequest | { action: "ping" } | { action: "list" } | { action: "stop" } |
  { action: "show" | "pause" | "resume" | "delete"; id: string };

export function validateRequest(value: unknown): Request {
  if (!value || typeof value !== "object") throw new Error("Expected an object.");
  const r = value as Record<string, unknown>;
  if (["ping", "list", "stop"].includes(String(r.action))) return { action: r.action } as Request;
  if (["show", "pause", "resume", "delete"].includes(String(r.action))) {
    if (typeof r.id !== "string" || !r.id) throw new Error("A schedule ID is required.");
    return { action: r.action, id: r.id } as Request;
  }
  if (r.action !== "create") throw new Error("Unknown loop action.");
  for (const key of ["requestId", "frequency", "prompt", "cwd"] as const)
    if (typeof r[key] !== "string" || !(r[key] as string).trim()) throw new Error(`Missing ${key}.`);
  intervalMs(r.frequency as string);
  if ((r.prompt as string).length > 32_000) throw new Error("Prompt exceeds 32,000 characters.");
  const model = r.model as Record<string, unknown> | undefined;
  if (!model || typeof model.provider !== "string" || !model.provider || typeof model.modelId !== "string" || !model.modelId)
    throw new Error("A provider and modelId are required.");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(r.thinkingLevel)))
    throw new Error("Invalid thinking level.");
  return { action: "create", requestId: r.requestId, frequency: (r.frequency as string).trim().toLowerCase(),
    prompt: (r.prompt as string).trim(), cwd: r.cwd, model: { provider: model.provider, modelId: model.modelId },
    thinkingLevel: r.thinkingLevel } as CreateRequest;
}
