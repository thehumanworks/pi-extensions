import { homedir } from "node:os";
import { isAbsolute, posix, resolve, win32 } from "node:path";

export interface RemoteHostSpec {
	id: string;
	host: string;
	user?: string;
	port?: number;
	cwd?: string;
	identityFile?: string;
	source: "flag" | "config" | "agent";
}

export interface ParsedRemoteTarget {
	host: string;
	user?: string;
	port?: number;
	cwd?: string;
}

// A leading `-` would make `ssh` read the field as an option.
const FIELD_PATTERN = /^[^\s\x00-\x1f\x7f-][^\s\x00-\x1f\x7f]*$/;

/**
 * Parses `[user@]host[:port][/absolute/cwd]` and the scp form `[user@]host[:port]:cwd`. Digits right after the host's
 * `:` are always a port. The cwd is kept as written; `~` and relative paths are resolved against the remote home once
 * connected. IPv6 hosts are bracketed: `[::1]:2222/srv`.
 */
export function parseRemoteTarget(value: string): ParsedRemoteTarget {
	const raw = value.trim();
	if (!raw || raw === "local") throw new Error("Remote target must name a host");
	if (raw.startsWith("-") || /[\x00-\x1f\x7f]/.test(raw)) {
		throw new Error(`Invalid remote target: ${JSON.stringify(value)}`);
	}

	// The user ends at the last `@` before the host; neither contains `/` or `:`, and IPv6 hosts start with `[`.
	let rest = raw;
	let user: string | undefined;
	const hostEnd = raw.search(/[/:[]/);
	const at = raw.lastIndexOf("@", hostEnd === -1 ? undefined : hostEnd);
	if (at !== -1) {
		user = raw.slice(0, at);
		rest = raw.slice(at + 1);
		if (!FIELD_PATTERN.test(user)) throw new Error(`Invalid SSH user: ${JSON.stringify(user)}`);
	}

	let host: string;
	if (rest.startsWith("[")) {
		const close = rest.indexOf("]");
		if (close === -1) throw new Error(`Invalid remote target: ${JSON.stringify(value)}`);
		host = rest.slice(1, close);
		rest = rest.slice(close + 1);
	} else {
		const end = rest.search(/[/:]/);
		host = end === -1 ? rest : rest.slice(0, end);
		rest = end === -1 ? "" : rest.slice(end);
	}
	if (!FIELD_PATTERN.test(host)) throw new Error(`Invalid SSH host: ${JSON.stringify(host)}`);

	let port: number | undefined;
	const portMatch = /^:(\d+)(?=[/:]|$)/.exec(rest);
	if (portMatch) {
		port = Number(portMatch[1]);
		if (port < 1 || port > 65535) throw new Error(`Invalid SSH port in ${JSON.stringify(value)}`);
		rest = rest.slice(portMatch[0].length);
	}
	if (rest && !rest.startsWith("/") && !rest.startsWith(":")) throw new Error(`Invalid remote target: ${JSON.stringify(value)}`);
	const cwd = rest.startsWith(":") ? rest.slice(1) : rest;
	return { host, ...(user ? { user } : {}), ...(port ? { port } : {}), ...(cwd ? { cwd } : {}) };
}

export function hostId(target: Pick<ParsedRemoteTarget, "host" | "user" | "port">): string {
	const host = target.host.includes(":") ? `[${target.host}]` : target.host;
	return `${target.user ? `${target.user}@` : ""}${host}${target.port ? `:${target.port}` : ""}`;
}

/** Resolves a remote working directory as `ssh` and `scp` do: `~` and relative paths start at the remote home. */
export function resolveRemotePath(path: string, home: string, windows = false): string {
	const fromHome = path === "~" ? "" : path.startsWith("~/") ? path.slice(2) : path;
	return (windows ? win32 : posix).resolve(home, fromHome);
}

export function displayHost(host: Pick<RemoteHostSpec, "id" | "cwd">, active = false): string {
	return `${active ? "* " : ""}${host.id}${host.cwd ? `:${host.cwd}` : ""}`;
}

export function parseHostList(value: string | undefined, source: RemoteHostSpec["source"]): RemoteHostSpec[] {
	if (!value?.trim()) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => {
			const parsed = parseRemoteTarget(item);
			return { id: hostId(parsed), ...parsed, source };
		});
}

export function normalizeLocalPath(value: string, base = process.cwd()): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function isSha256(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}
