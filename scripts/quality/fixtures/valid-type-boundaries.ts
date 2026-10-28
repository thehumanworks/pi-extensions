// A documented negative type test is allowed; tsc checks it stays necessary.
// @ts-expect-error: The boundary deliberately rejects strings for numeric counts.
export const count: number = "not a number";

export function invoke(callback: () => string): string {
  return callback();
}

interface SessionContract {
  cwd: string;
}

export class Session implements SessionContract {
  constructor(public cwd: string) {}
}

export function cwd(session: SessionContract | undefined): string {
  return session?.cwd ?? ".";
}
