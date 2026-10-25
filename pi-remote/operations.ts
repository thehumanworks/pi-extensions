import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	GrepOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { getOrThrow, type ExecutionEnv, type FileListing } from "@earendil-works/pi-durable/env";

const IMAGE_SNIFF_BYTES = 4100;
const LOCAL_TEMP_PREFIXES = ["/tmp/pi-", "/tmp/pi_", "/private/tmp/pi-", "/private/tmp/pi_"];

function aborted(signal: AbortSignal | undefined, label: string): Context {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) controller.abort();
	const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	context.abortSignal?.addEventListener("abort", () => signal?.removeEventListener("abort", onAbort), { once: true });
	if (controller.signal.aborted) throw new Error(`${label} aborted`);
	return context;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function imageMime(bytes: Uint8Array): string | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return "image/png";
	}
	const head = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
	if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
	if (head.startsWith("RIFF") && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
	if (head.startsWith("BM")) return "image/bmp";
	return null;
}

function isLocalToolSpill(path: string): boolean {
	return LOCAL_TEMP_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function list(env: ExecutionEnv, path: string, signal?: AbortSignal): Promise<FileListing> {
	const result = await env.listFiles?.(
		path,
		{ hidden: true, gitignore: true, maxEntries: 100_000, timeoutMs: 30_000 },
		aborted(signal, "list"),
	);
	if (!result) throw new Error("Remote file listing is unavailable");
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

export function createRemoteReadOperations(env: ExecutionEnv): ReadOperations {
	return {
		readFile: async (path) => {
			const result = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
			if (!result.ok && result.error.code === "not_found" && isLocalToolSpill(path)) {
				return readFile(path);
			}
			return Buffer.from(getOrThrow(result));
		},
		access: async (path) => {
			const result = await env.exists(path, BACKGROUND_CONTEXT);
			if (!result.ok && result.error.code === "not_found" && isLocalToolSpill(path)) {
				await access(path, constants.R_OK);
				return;
			}
			if (!result.ok || !result.value) throw new Error(`ENOENT: no such file: ${path}`);
		},
		detectImageMimeType: async (path) => {
			const opened = await env.openBinaryReader(path, undefined, BACKGROUND_CONTEXT);
			if (!opened.ok) return isLocalToolSpill(path) ? null : null;
			try {
				const bytes = await opened.value.read(0, IMAGE_SNIFF_BYTES, BACKGROUND_CONTEXT);
				return bytes.ok ? imageMime(bytes.value) : null;
			} finally {
				await opened.value.close(BACKGROUND_CONTEXT);
			}
		},
	};
}

export function createRemoteWriteOperations(env: ExecutionEnv): WriteOperations {
	return {
		writeFile: async (path, content) => {
			getOrThrow(await env.writeFile(path, content, BACKGROUND_CONTEXT));
		},
		mkdir: async (dir) => {
			getOrThrow(await env.createDir(dir, { recursive: true }, BACKGROUND_CONTEXT));
		},
	};
}

export function createRemoteEditOperations(env: ExecutionEnv): EditOperations {
	const read = createRemoteReadOperations(env);
	const write = createRemoteWriteOperations(env);
	return { readFile: read.readFile, writeFile: write.writeFile, access: read.access };
}

export function createRemoteBashOperations(env: ExecutionEnv): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env: commandEnv }) => {
			throwIfAborted(signal);
			const forwarded = Object.fromEntries(
				Object.entries(commandEnv ?? {}).filter((entry): entry is [string, string] => entry[0].startsWith("PI_")),
			);
			let callbackError: Error | undefined;
			const result = await env.exec(
				command,
				{
					cwd,
					timeout,
					inheritEnv: true,
					env: forwarded,
					onOutput: (text) => {
						try {
							onData(Buffer.from(text));
						} catch (error) {
							callbackError = error instanceof Error ? error : new Error(String(error));
							signal?.throwIfAborted();
						}
					},
				},
				aborted(signal, "command"),
			);
			if (callbackError) throw callbackError;
			if (!result.ok) {
				if (result.error.code === "aborted") throw new Error("aborted");
				if (result.error.code === "timeout") throw new Error(result.error.message);
				throw new Error(result.error.message);
			}
			return { exitCode: result.value.exitCode };
		},
	};
}

function parentPath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	const index = normalized.lastIndexOf("/");
	return index <= 0 ? normalized.slice(0, 1) || "." : normalized.slice(0, index);
}

export function createRemoteLsOperations(env: ExecutionEnv): LsOperations {
	const cache = new Map<string, Promise<Map<string, { isDirectory(): boolean }>>>();
	const entries = (dir: string) => {
		const cached = cache.get(dir);
		if (cached) return cached;
		const loading = env.listDir(dir, BACKGROUND_CONTEXT).then((result) => {
			if (!result.ok) throw new Error(result.error.message);
			return new Map(result.value.map((entry) => [entry.name, { isDirectory: () => entry.kind === "directory" }]));
		});
		cache.set(dir, loading);
		return loading;
	};
	return {
		exists: async (path) => getOrThrow(await env.exists(path, BACKGROUND_CONTEXT)),
		stat: async (path) => {
			const parent = parentPath(path);
			const name = posix.basename(path.replaceAll("\\", "/"));
			const known = await entries(parent).catch(() => undefined);
			const cached = known?.get(name);
			if (cached) return cached;
			const info = getOrThrow(await env.fileInfo(path, BACKGROUND_CONTEXT));
			return { isDirectory: () => info.kind === "directory" };
		},
		readdir: async (path) => [...(await entries(path)).keys()],
	};
}

export function createRemoteFindOperations(env: ExecutionEnv): FindOperations {
	return {
		exists: async (path) => getOrThrow(await env.exists(path, BACKGROUND_CONTEXT)),
		glob: async (pattern, cwd, { limit }) => {
			const listing = await list(env, cwd);
			const regex = globToRegExp(pattern);
			return listing.entries
				.filter((entry) => entry.kind === "file" && regex.test(entry.path))
				.slice(0, limit)
				.map((entry) => posix.join(cwd, entry.path));
		},
	};
}

export function createRemoteGrepOperations(env: ExecutionEnv): GrepOperations {
	return {
		isDirectory: async (path) => getOrThrow(await env.fileInfo(path, BACKGROUND_CONTEXT)).kind === "directory",
		readFile: async (path) => getOrThrow(await env.readTextFile(path, BACKGROUND_CONTEXT)),
	};
}

function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replaceAll("\\", "/");
	let source = "^";
	for (let index = 0; index < normalized.length; index++) {
		const char = normalized[index];
		const next = normalized[index + 1];
		if (char === "*" && next === "*") {
			source += ".*";
			index++;
			if (normalized[index + 1] === "/") index++;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += /[\\^$+?.()|[\]{}]/.test(char!) ? `\\${char}` : char;
	}
	return new RegExp(`${source}$`);
}
