export type BotErrorCode = "NOT_FOUND" | "INVALID_INPUT" | "CONFLICT" | "UNAVAILABLE";
/** Stable transport-neutral errors. No HTTP or daemon dependency. */
export class BotError extends Error {
  constructor(readonly code: BotErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "BotError";
  }
}
export function botError(error: unknown, fallback: BotErrorCode = "INVALID_INPUT"): BotError {
  if (error instanceof BotError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === "NOT_FOUND" || code === "INVALID_INPUT" || code === "CONFLICT" || code === "UNAVAILABLE") return error as BotError;
  return new BotError(code === "ENOENT" ? "NOT_FOUND" : fallback, error instanceof Error ? error.message : String(error), { cause: error });
}
