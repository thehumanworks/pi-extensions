import { deepStrictEqual, ok, rejects } from "node:assert/strict";

export { deepStrictEqual as assertEquals, ok as assert };

/** Keep concise rejection checks with optional error type and message fragment. */
export async function assertRejects(
  run: () => Promise<unknown>,
  errorClass?: new (...args: never[]) => Error,
  message?: string,
): Promise<void> {
  await rejects(run, (error: unknown) => {
    ok(error instanceof Error, "Expected an Error rejection");
    if (errorClass)
      ok(error instanceof errorClass, `Expected ${errorClass.name}`);
    if (message)
      ok(
        error.message.includes(message),
        `Expected error message to include ${message}`,
      );
    return true;
  });
}
