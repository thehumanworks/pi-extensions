import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
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
	SshError,
	type SshTarget,
} from "@earendil-works/pi-env";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { hostId, parseHostList, parseRemoteTarget, resolveRemotePath, shellQuote, type RemoteHostSpec } from "./hosts.ts";

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
	log?: (text: string) => void;
}

interface RemoteConfigFile {
	hosts?: Array<string | { target: string; identityFile?: string }>;
	identityFile?: string;
	knownHostsFile?: string;
	sshConfigFile?: string;
}

const execFileAsync = promisify(execFile);

/**
 * The keys OpenSSH trusts for the host, as `type key` lines: the known-hosts files and the name the key is filed under
 * (`HostKeyAlias`, `[host]:port`) come from `ssh -G`, so they match what `ssh` checks. Revoked keys and certificate
 * authorities are left out, and only the first key of each type is kept.
 */
async function openSshHostKeys(spec: RemoteHostSpec, configFile: string | undefined): Promise<string[]> {
	const { stdout } = await execFileAsync("ssh", [
		"-G",
		...(configFile ? ["-F", configFile] : []),
		...(spec.user ? ["-l", spec.user] : []),
		...(spec.port ? ["-p", String(spec.port)] : []),
		"--",
		spec.host,
	]);
	const settings = new Map(stdout.split("\n").map((line) => {
		const [name = "", ...values] = line.trim().split(/\s+/);
		return [name, values] as const;
	}));
	const host = settings.get("hostname")?.[0] ?? spec.host;
	const port = settings.get("port")?.[0] ?? "22";
	const name = settings.get("hostkeyalias")?.[0] ?? (port === "22" ? host : `[${host}]:${port}`);
	const files = [...(settings.get("userknownhostsfile") ?? []), ...(settings.get("globalknownhostsfile") ?? [])];
	const keys = new Map<string, string>();
	const revoked = new Set<string>();
	for (const file of files.filter((file) => file !== "none")) {
		// `ssh-keygen -F` matches hashed names and patterns as `ssh` does; it fails when nothing matches or the file is missing.
		const found = await execFileAsync("ssh-keygen", ["-F", name, "-f", file]).then(({ stdout }) => stdout, () => "");
		for (const line of found.split("\n")) {
			const fields = line.trim().split(/\s+/);
			if (fields[0] === "" || fields[0]!.startsWith("#")) continue;
			const marker = fields[0]!.startsWith("@") ? fields.shift() : undefined;
			const [, type, key] = fields;
			if (type === undefined || key === undefined) continue;
			if (marker === "@revoked") revoked.add(key);
			else if (marker === undefined && !keys.has(type)) keys.set(type, key);
		}
	}
	return [...keys].filter(([, key]) => !revoked.has(key)).map(([type, key]) => `${type} ${key}`);
}

export class RemoteSession {
	readonly localCwd: string;
	readonly hosts = new Map<string, RemoteHostSpec>();
	activeId = "local";
	private readonly connected = new Map<string, ConnectedRemote>();
	private localConnection: Connection | undefined;
	private localEnv: ExecutionEnv | undefined;
	private pendingInitial: string | undefined;
	private startupFailure: { target: string; message: string } | undefined;
	private readonly options: RemoteSessionOptions;

	constructor(options: RemoteSessionOptions) {
		this.options = options;
		this.localCwd = options.cwd;
		this.configure(options);
		this.loadConfiguredHostsSync();
	}

	configure(options: Pick<RemoteSessionOptions, "initial" | "hostList" | "identityFile">): void {
		if (options.initial) this.pendingInitial = options.initial;
		if (options.identityFile) this.options.identityFile = options.identityFile;
		for (const host of parseHostList(options.hostList, "flag")) {
			this.hosts.set(host.id, { ...this.hosts.get(host.id), ...host });
		}
	}

	private addConfiguredHosts(parsed: RemoteConfigFile, file: string): void {
		for (const item of parsed.hosts ?? []) this.addConfiguredHost(item, file);
	}

	private addConfiguredHost(item: string | { target: string; identityFile?: string }, file: string): void {
		const target = typeof item === "string" ? item : item.target;
		const parsed = parseRemoteTarget(target);
		const spec: RemoteHostSpec = { id: hostId(parsed), ...parsed, source: "config" };
		if (typeof item !== "string" && item.identityFile) spec.identityFile = resolve(dirname(file), item.identityFile);
		// Flags override fields they supply, not configured credentials or cwd they omit.
		this.hosts.set(spec.id, { ...spec, ...this.hosts.get(spec.id) });
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

	async loadConfiguredHosts(options?: Pick<RemoteSessionOptions, "initial" | "hostList" | "identityFile">): Promise<void> {
		try {
			if (options) this.configure(options);
			for (const file of [join(this.localCwd, ".pi", "remote-hosts.json"), join(homedir(), ".pi", "remote-hosts.json")]) {
				try {
					this.addConfiguredHosts(JSON.parse(await readFile(file, "utf8")) as RemoteConfigFile, file);
				} catch {
					// Invalid optional config must not prevent selection of the requested host.
				}
			}
			if (this.pendingInitial) await this.use(this.pendingInitial);
		} catch (error) {
			if (this.pendingInitial) {
				this.startupFailure = {
					target: this.pendingInitial,
					message: error instanceof Error ? error.message : String(error),
				};
			}
			throw error;
		}
	}

	get unavailable(): Readonly<{ target: string; message: string }> | undefined {
		return this.startupFailure;
	}

	/** Never silently execute locally when the user explicitly requested an unavailable remote host. */
	assertReady(): void {
		if (this.startupFailure) {
			throw new Error(
				`Execution is blocked because the requested remote host ${this.startupFailure.target} is unavailable. ` +
				`Retry with /remote use <host> or explicitly select /remote use local.\n${this.startupFailure.message}`,
			);
		}
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

	activeRemote(): ConnectedRemote | undefined {
		this.assertReady();
		return this.activeId === "local" ? undefined : this.connected.get(this.activeId);
	}

	async use(target: string, cwd?: string): Promise<{ id: string; cwd: string; remote: boolean }> {
		if (target === "local") {
			this.activeId = "local";
			this.startupFailure = undefined;
			return this.current();
		}
		const parsed = this.hosts.has(target) ? undefined : parseRemoteTarget(target);
		const id = parsed ? hostId(parsed) : target;
		const spec: RemoteHostSpec = this.hosts.get(id) ?? { id, ...parsed!, source: "agent" };
		// A cwd in the target counts as much as an explicit one, also for a host that is already known or connected.
		const requested = cwd ?? parsed?.cwd;
		if (requested) spec.cwd = requested;
		this.hosts.set(id, spec);
		const connected = await this.connect(spec);
		if (requested) {
			const resolved = resolveRemotePath(requested, connected.platform.home, connected.platform.platform === "windows");
			getOrThrow(await connected.env.createDir(resolved, { recursive: true }, BACKGROUND_CONTEXT));
			connected.cwd = resolved;
			connected.env.cwd = resolved;
		}
		this.activeId = id;
		this.startupFailure = undefined;
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
		const target = this.sshTarget(spec);
		let result: Awaited<ReturnType<typeof connectSsh>>;
		try {
			result = await this.connectTrusted(spec, target);
		} catch (error) {
			if (error instanceof SshError && error.exitCode === 255 && /Permission denied \([^)]+\)/i.test(error.stderr)) {
				const command = [
					"ssh", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none",
					...(target.configFile ? ["-F", shellQuote(target.configFile)] : []),
					...(target.identityFile ? ["-i", shellQuote(target.identityFile), "-o", "IdentitiesOnly=yes"] : []),
					...(target.user ? ["-l", shellQuote(target.user)] : []),
					...(target.port ? ["-p", String(target.port)] : []),
					"--", shellQuote(target.host), "true",
				].join(" ");
				throw new Error(
					`SSH authentication failed for ${spec.id}. pi-remote uses non-interactive SSH (BatchMode=yes); ` +
					"passwords and keyboard-interactive prompts are unavailable, and existing shared SSH connections are not reused. " +
					(target.identityFile ? `Configured identity: ${target.identityFile} (IdentitiesOnly=yes). ` : "") +
					"Check the SSH user and that an authorized key or SSH agent is available to the process running Pi. " +
					`Test from the same shell: ${command}\n${error.message}`,
					{ cause: error },
				);
			}
			throw error;
		}
		const { connection, remote } = result;
		// The remote home is only known once connected; it is the default cwd and the base of `~` and relative paths.
		const cwd = resolveRemotePath(spec.cwd ?? "~", remote.home, remote.platform === "windows");
		const env = new RemoteExecutionEnv({ connection, id: `pi-remote:${spec.id}`, cwd });
		const connected = { spec, connection, env, platform: remote, cwd };
		this.connected.set(spec.id, connected);
		return connected;
	}

	/**
	 * Connect, settling host keys as `ssh` would: the keys OpenSSH trusts for the host replace ours, and a host OpenSSH
	 * has never seen is trusted on first use. A key that differs from a trusted one is refused.
	 */
	private async connectTrusted(spec: RemoteHostSpec, target: SshTarget): ReturnType<typeof connectSsh> {
		const connect = () => connectSsh({ ...target, onLog: this.options.log });
		const ssh = `ssh ${spec.port ? `-p ${spec.port} ` : ""}${spec.user ? `${spec.user}@` : ""}${spec.host}`;
		const changed = (error: HostKeyChangedError, fromOpenSsh: boolean) => {
			const fix = fromOpenSsh
				? `remove the old key from ~/.ssh/known_hosts with ssh-keygen -R and accept the new one with \`${ssh}\``
				: `remove the old key with remote_host forget ${spec.id}`;
			return new Error(
				`The host key of ${spec.host} changed, which can mean the connection is being intercepted. If the change is expected, ${fix}, then retry.`,
				{ cause: error },
			);
		};
		try {
			return await connect();
		} catch (error) {
			if (!(error instanceof HostKeyUnknownError) && !(error instanceof HostKeyChangedError)) throw error;
			const known = await openSshHostKeys(spec, this.options.sshConfigFile);
			if (known.length > 0) {
				await forgetHostKey(target);
				await acceptHostKey(target, known.map((line) => `${target.hostKeyAlias} ${line}`));
			} else if (error instanceof HostKeyUnknownError) {
				const scanned = await scanHostKey(target);
				await acceptHostKey(target, scanned.lines);
				this.options.log?.(`Trusted first-seen host key for ${target.host}: ${scanned.fingerprints.join("; ")}\n`);
			} else {
				throw changed(error, false);
			}
			try {
				return await connect();
			} catch (retryError) {
				if (retryError instanceof HostKeyChangedError) throw changed(retryError, known.length > 0);
				throw retryError;
			}
		}
	}

	private sshTarget(spec: RemoteHostSpec): SshTarget {
		return {
			host: spec.host,
			...(spec.user ? { user: spec.user } : {}),
			...(spec.port ? { port: spec.port } : {}),
			...(spec.identityFile || this.options.identityFile ? { identityFile: spec.identityFile ?? this.options.identityFile } : {}),
			knownHostsFile: this.options.knownHostsFile ?? join(homedir(), ".pi", "remote", "known_hosts"),
			hostKeyAlias: `pi-remote-${spec.id.replaceAll(/[^A-Za-z0-9._-]/g, "_")}`,
			// Without a config file `ssh` reads ~/.ssh/config, so aliases, users, keys and jump hosts work as with `ssh`.
			...(this.options.sshConfigFile ? { configFile: this.options.sshConfigFile } : {}),
		};
	}

	async forget(id: string): Promise<void> {
		const spec = this.hosts.get(id);
		if (!spec) throw new Error(`Unknown remote host: ${id}`);
		await forgetHostKey(this.sshTarget(spec));
		this.connected.get(id)?.connection.close();
		this.connected.delete(id);
		if (this.activeId === id) this.activeId = "local";
	}
}
