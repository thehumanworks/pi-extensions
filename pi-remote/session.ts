import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	acceptHostKey,
	connectSsh,
	forgetHostKey,
	HostKeyChangedError,
	HostKeyUnknownError,
	Connection,
	localDaemon,
	LocalExecutionEnv,
	type RemotePlatform,
	RemoteExecutionEnv,
	scanHostKey,
	type SshTarget,
} from "@earendil-works/pi-env";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { hostId, parseHostList, parseRemoteTarget, type RemoteHostSpec } from "./hosts.ts";

export interface ConnectedRemote {
	spec: RemoteHostSpec;
	connection: { close(): void };
	env: ExecutionEnv;
	platform: RemotePlatform;
	cwd: string;
}

export interface RemoteSessionOptions {
	cwd: string;
	initial?: string;
	hostList?: string;
	identityFile?: string;
	knownHostsFile?: string;
	sshConfigFile?: string;
	trustUnknownHostKeys?: boolean;
	log?: (text: string) => void;
}

interface RemoteConfigFile {
	hosts?: Array<string | { target: string; identityFile?: string }>;
	identityFile?: string;
	knownHostsFile?: string;
	sshConfigFile?: string;
}

export class RemoteSession {
	readonly localCwd: string;
	readonly hosts = new Map<string, RemoteHostSpec>();
	activeId = "local";
	private readonly connected = new Map<string, ConnectedRemote>();
	private localConnection: Connection | undefined;
	private localEnv: ExecutionEnv | undefined;
	private pendingInitial: string | undefined;
	private readonly options: RemoteSessionOptions;

	constructor(options: RemoteSessionOptions) {
		this.options = options;
		this.localCwd = options.cwd;
		this.configure(options);
		this.loadConfiguredHostsSync();
	}

	configure(options: Pick<RemoteSessionOptions, "initial" | "hostList" | "identityFile">): void {
		if (options.identityFile) this.options.identityFile = options.identityFile;
		for (const host of parseHostList(options.hostList, "flag")) this.hosts.set(host.id, host);
		if (options.initial) this.pendingInitial = options.initial;
	}

	private addConfiguredHosts(parsed: RemoteConfigFile, file: string): void {
		for (const item of parsed.hosts ?? []) this.addConfiguredHost(item, file);
	}

	private addConfiguredHost(item: string | { target: string; identityFile?: string }, file: string): void {
		const target = typeof item === "string" ? item : item.target;
		const parsed = parseRemoteTarget(target);
		const spec: RemoteHostSpec = { id: hostId(parsed), ...parsed, source: "config" };
		if (typeof item !== "string" && item.identityFile) spec.identityFile = resolve(dirname(file), item.identityFile);
		if (!this.hosts.has(spec.id)) this.hosts.set(spec.id, spec);
	}

	private loadConfiguredHostsSync(): void {
		for (const file of [join(this.localCwd, ".pi", "remote-hosts.json"), join(homedir(), ".pi", "remote-hosts.json")]) {
			if (!existsSync(file)) continue;
			try {
				this.addConfiguredHosts(JSON.parse(readFileSync(file, "utf8")) as RemoteConfigFile, file);
			} catch {
				// Invalid optional config does not block the session.
			}
		}
	}

	async loadConfiguredHosts(): Promise<void> {
		if (this.pendingInitial) await this.use(this.pendingInitial);
		for (const file of [join(this.localCwd, ".pi", "remote-hosts.json"), join(homedir(), ".pi", "remote-hosts.json")]) {
			let parsed: RemoteConfigFile;
			try {
				parsed = JSON.parse(await readFile(file, "utf8")) as RemoteConfigFile;
			} catch {
				continue;
			}
			for (const item of parsed.hosts ?? []) {
				const target = typeof item === "string" ? item : item.target;
				this.addConfiguredHost(item, file);
			}
		}
		if (this.options.initial) await this.use(this.options.initial);
	}

	list(): Array<{ id: string; cwd?: string; active: boolean; connected: boolean }> {
		return [
			{ id: "local", cwd: this.localCwd, active: this.activeId === "local", connected: true },
			...[...this.hosts.values()].map((host) => ({
				id: host.id,
				cwd: this.connected.get(host.id)?.cwd ?? host.cwd,
				active: host.id === this.activeId,
				connected: this.connected.has(host.id),
			})),
		];
	}

	current(): { id: string; cwd: string; remote: boolean } {
		if (this.activeId === "local") return { id: "local", cwd: this.localCwd, remote: false };
		const connected = this.connected.get(this.activeId);
		if (!connected) return { id: "local", cwd: this.localCwd, remote: false };
		return { id: connected.spec.id, cwd: connected.cwd, remote: true };
	}

	activeEnv(): ExecutionEnv | undefined {
		return this.activeId === "local" ? undefined : this.connected.get(this.activeId)?.env;
	}

	async use(target: string, cwd?: string): Promise<{ id: string; cwd: string; remote: boolean }> {
		if (target === "local") {
			this.activeId = "local";
			return this.current();
		}
		const parsed = this.hosts.has(target) ? undefined : parseRemoteTarget(target);
		const id = parsed ? hostId(parsed) : target;
		const existing = this.hosts.get(id);
		const spec: RemoteHostSpec = existing ?? {
			id,
			host: parsed!.host,
			...(parsed?.user ? { user: parsed.user } : {}),
			...(parsed?.port ? { port: parsed.port } : {}),
			...(parsed?.cwd ? { cwd: parsed.cwd } : {}),
			source: "agent",
		};
		if (cwd) spec.cwd = cwd;
		this.hosts.set(id, spec);
		const connected = await this.connect(spec);
		if (cwd) {
			getOrThrow(await connected.env.createDir(cwd, { recursive: true }, BACKGROUND_CONTEXT));
			connected.cwd = cwd;
			connected.env.cwd = cwd;
		}
		this.activeId = id;
		return this.current();
	}

	async probe(id = this.activeId): Promise<Record<string, unknown>> {
		if (id === "local") return { id, ok: true, cwd: this.localCwd, platform: process.platform, arch: process.arch };
		const spec = this.hosts.get(id);
		if (!spec) throw new Error(`Unknown remote host: ${id}`);
		const started = performance.now();
		const connected = await this.connect(spec);
		return {
			id,
			ok: true,
			cwd: connected.cwd,
			platform: connected.platform.platform,
			arch: connected.platform.arch,
			home: connected.platform.home,
			latencyMs: Math.round(performance.now() - started),
		};
	}

	async execOn(id: string, command: string, timeoutSeconds = 30): Promise<Record<string, unknown>> {
		const spec = this.hosts.get(id);
		if (!spec) throw new Error(`Unknown remote host: ${id}`);
		const connected = await this.connect(spec);
		const chunks: string[] = [];
		const started = performance.now();
		const result = await connected.env.exec(
			command,
			{ cwd: connected.cwd, timeout: timeoutSeconds, inheritEnv: true, onOutput: (text) => chunks.push(text) },
			BACKGROUND_CONTEXT,
		);
		if (!result.ok) return { id, ok: false, error: result.error.message, durationMs: Math.round(performance.now() - started) };
		return { id, ok: true, exitCode: result.value.exitCode, output: chunks.join(""), durationMs: Math.round(performance.now() - started) };
	}

	async copy(sourceHost: string, sourcePath: string, destinationHost: string, destinationPath: string): Promise<string> {
		const source = await this.envFor(sourceHost);
		const destination = await this.envFor(destinationHost);
		const bytes = getOrThrow(await source.readBinaryFile(sourcePath, BACKGROUND_CONTEXT));
		getOrThrow(await destination.createDir(dirname(destinationPath), { recursive: true }, BACKGROUND_CONTEXT));
		getOrThrow(await destination.writeFile(destinationPath, bytes, BACKGROUND_CONTEXT));
		const digest = createHash("sha256").update(bytes).digest("hex");
		return `Copied ${bytes.byteLength} bytes from ${sourceHost}:${sourcePath} to ${destinationHost}:${destinationPath} (sha256 ${digest})`;
	}

	close(): void {
		for (const connected of this.connected.values()) connected.connection.close();
		this.connected.clear();
		this.localConnection?.close();
		this.localConnection = undefined;
		this.localEnv = undefined;
		this.activeId = "local";
	}

	private async envFor(id: string): Promise<ExecutionEnv> {
		if (id === "local") {
			this.localConnection ??= new Connection({ command: [localDaemon()] });
			this.localEnv ??= new LocalExecutionEnv({ cwd: this.localCwd, connection: this.localConnection });
			return this.localEnv;
		}
		const spec = this.hosts.get(id);
		if (!spec) throw new Error(`Unknown remote host: ${id}`);
		return (await this.connect(spec)).env;
	}

	private async connect(spec: RemoteHostSpec): Promise<ConnectedRemote> {
		const cached = this.connected.get(spec.id);
		if (cached) return cached;
		const target = await this.sshTarget(spec);
		try {
			await this.trustUnknownKey(target);
			const { connection, remote } = await connectSsh({ ...target, onLog: this.options.log });
			const cwd = spec.cwd ?? remote.home;
			const env = new RemoteExecutionEnv({ connection, id: `pi-remote:${spec.id}`, cwd });
			const connected = { spec, connection, env, platform: remote, cwd };
			this.connected.set(spec.id, connected);
			return connected;
		} catch (error) {
			if (error instanceof HostKeyChangedError) {
				throw new Error(`${error.message} Confirm the new key out of band, then retry after the old key is forgotten.`, { cause: error });
			}
			throw error;
		}
	}

	private async sshTarget(spec: RemoteHostSpec): Promise<SshTarget> {
		return {
			host: spec.host,
			...(spec.user ? { user: spec.user } : {}),
			...(spec.port ? { port: spec.port } : {}),
			...(spec.identityFile || this.options.identityFile ? { identityFile: spec.identityFile ?? this.options.identityFile } : {}),
			knownHostsFile: this.options.knownHostsFile ?? join(homedir(), ".pi", "remote", "known_hosts"),
			hostKeyAlias: `pi-remote-${spec.id.replaceAll(/[^A-Za-z0-9._-]/g, "_")}`,
			configFile: await this.sshConfig(spec),
		};
	}

	private async sshConfig(spec: RemoteHostSpec): Promise<string> {
		const path = join(homedir(), ".pi", "remote", "ssh-config", `${spec.id.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.conf`);
		const identity = spec.identityFile ?? this.options.identityFile;
		const config = [
			`Host ${spec.host}`,
			`  HostName ${spec.host}`,
			...(spec.port ? [`  Port ${spec.port}`] : []),
			...(spec.user ? [`  User ${spec.user}`] : []),
			...(identity ? [`  IdentityFile ${identity}`, "  IdentitiesOnly yes"] : []),
			"",
		].join("\n");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, config, { mode: 0o600 });
		return path;
	}

	private async trustUnknownKey(target: SshTarget): Promise<void> {
		if (!this.options.trustUnknownHostKeys) return;
		try {
			const { detectPlatform } = await import("@earendil-works/pi-env");
			await detectPlatform(target);
		} catch (error) {
			if (!(error instanceof HostKeyUnknownError)) throw error;
			const scanned = await scanHostKey(target);
			await mkdir(dirname(target.knownHostsFile), { recursive: true });
			await acceptHostKey(target, scanned.lines);
			this.options.log?.(`Trusted first-seen host key for ${target.host}: ${scanned.fingerprints.join("; ")}\n`);
		}
	}

	async forget(id: string): Promise<void> {
		const spec = this.hosts.get(id);
		if (!spec) throw new Error(`Unknown remote host: ${id}`);
		await forgetHostKey(await this.sshTarget(spec));
		this.connected.get(id)?.connection.close();
		this.connected.delete(id);
		if (this.activeId === id) this.activeId = "local";
	}
}
