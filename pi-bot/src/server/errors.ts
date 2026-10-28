/** An error that already knows its HTTP status. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a bot or session helper on behalf of a request. Those helpers validate input and throw
 * plain errors with a message, so a failure here is the caller's fault unless the message says
 * otherwise. Errors raised outside this wrapper stay internal (500).
 */
export async function fromRequest<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = errorText(error);
    const status = /^Unknown bot |has no (session|conversation) /.test(message) ? 404
      : /already exists/.test(message) ? 409
      : /^Cannot start /.test(message) ? 502
      : 400;
    throw new HttpError(status, message);
  }
}
