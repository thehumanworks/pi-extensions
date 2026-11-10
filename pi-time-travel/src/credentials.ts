import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The API key Pi has stored for a provider (`/login` or `pi auth`), so the Claude Code hook can
 * reuse it without new credentials. Supports Pi's value forms: a literal, `$VAR`/`${VAR}`
 * references, and `!command`.
 */
export function piStoredApiKey(provider: string, home: string, env: NodeJS.ProcessEnv): string | undefined {
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
	let entry: unknown;
	try {
		entry = (JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>)[provider];
	} catch {
		return undefined;
	}
	const { type, key } = (entry ?? {}) as { type?: unknown; key?: unknown };
	if (type !== "api_key" || typeof key !== "string" || !key) return undefined;
	if (key.startsWith("!")) {
		try {
			return execFileSync("sh", ["-c", key.slice(1)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	let missing = false;
	const value = key
		.replace(/\$\$/g, "\u0000")
		.replace(/\$\{(\w+)\}|\$([A-Za-z_]\w*)/g, (_, braced: string | undefined, bare: string | undefined) => {
			const resolved = env[(braced ?? bare)!];
			if (resolved === undefined) missing = true;
			return resolved ?? "";
		})
		.replace(/\u0000/g, "$")
		.replace(/\$!/g, "!");
	return missing ? undefined : value;
}
