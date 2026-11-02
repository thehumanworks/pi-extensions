export interface IdleCompactionConfig {
	enabled: boolean;
	/** Compact only when the context holds at least this many tokens. */
	tokenThreshold: number;
	/** Idle time before compacting, in minutes. */
	idleMinutes: number;
}

/**
 * The idle time is the shortest prompt cache lifetime among the providers Pi
 * commonly talks to: Anthropic's default 5-minute TTL (also Claude Code's main
 * conversation TTL off-subscription) and OpenAI's in-memory retention (about
 * 5-10 minutes of inactivity on pre-GPT-5.6 models). After that, the next
 * request re-reads the whole context uncached either way.
 */
export const DEFAULTS: IdleCompactionConfig = {
	enabled: true,
	tokenThreshold: 150_000,
	idleMinutes: 5,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads `idleCompaction` from Pi settings: `true`, `false`, or `{ enabled, tokenThreshold, idleMinutes }`. */
export function readConfig(settings: unknown): IdleCompactionConfig {
	const raw = isObject(settings) ? settings.idleCompaction : undefined;
	if (raw === undefined) return { ...DEFAULTS };
	if (typeof raw === "boolean") return { ...DEFAULTS, enabled: raw };
	if (!isObject(raw)) throw new Error("settings.idleCompaction must be true, false, or an object");

	const { enabled = DEFAULTS.enabled, tokenThreshold = DEFAULTS.tokenThreshold, idleMinutes = DEFAULTS.idleMinutes } = raw;
	if (typeof enabled !== "boolean") throw new Error("settings.idleCompaction.enabled must be a boolean");
	if (typeof tokenThreshold !== "number" || !Number.isInteger(tokenThreshold) || tokenThreshold < 1) {
		throw new Error("settings.idleCompaction.tokenThreshold must be a positive integer");
	}
	if (typeof idleMinutes !== "number" || !Number.isFinite(idleMinutes) || idleMinutes <= 0 || idleMinutes > 24 * 60) {
		throw new Error("settings.idleCompaction.idleMinutes must be a number of minutes above 0 and at most 1440");
	}
	return { enabled, tokenThreshold, idleMinutes };
}
