import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

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

const FIELD_PATTERN = /^[^\s\x00-\x1f\x7f-]+$/;

export function parseRemoteTarget(value: string): ParsedRemoteTarget {
	const raw = value.trim();
	if (!raw || raw === "local") throw new Error("Remote target must name a host");
	if (raw.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(raw)) {
		throw new Error(`Invalid remote target: ${JSON.stringify(value)}`);
	}

	let rest = raw;
	let cwd: string | undefined;
	const slash = rest.indexOf("/");
	if (slash !== -1) {
		cwd = rest.slice(slash);
		rest = rest.slice(0, slash);
		if (!cwd.startsWith("/")) throw new Error("Remote working directory must be absolute");
	}

	let user: string | undefined;
	const at = rest.lastIndexOf("@");
	if (at !== -1) {
		user = rest.slice(0, at);
		rest = rest.slice(at + 1);
		if (!user || !FIELD_PATTERN.test(user)) throw new Error(`Invalid SSH user: ${JSON.stringify(user)}`);
	}
	if (!rest) throw new Error(`Invalid remote target: ${JSON.stringify(value)}`);

	let host = rest;
	let port: number | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon !== -1 && !rest.startsWith("[")) {
		host = rest.slice(0, colon);
		const portText = rest.slice(colon + 1);
		port = Number(portText);
		if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`Invalid SSH port in ${JSON.stringify(value)}`);
		}
	}
	if (!FIELD_PATTERN.test(host)) throw new Error(`Invalid SSH host: ${JSON.stringify(host)}`);
	return { host, ...(user ? { user } : {}), ...(port ? { port } : {}), ...(cwd ? { cwd } : {}) };
}

export function hostId(target: Pick<ParsedRemoteTarget, "host" | "user" | "port">): string {
	return `${target.user ? `${target.user}@` : ""}${target.host}${target.port ? `:${target.port}` : ""}`;
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
