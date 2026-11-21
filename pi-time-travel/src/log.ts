import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = (record: Record<string, unknown>) => void;

/** Appends one JSON line per record. Logging never breaks the agent. */
export function fileLogger(path: string | undefined, base: Record<string, unknown>): Logger {
	if (!path) return () => {};
	let ready = false;
	return (record) => {
		try {
			if (!ready) {
				mkdirSync(dirname(path), { recursive: true });
				ready = true;
			}
			appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...base, ...record })}\n`);
		} catch {
			// Best effort.
		}
	};
}
