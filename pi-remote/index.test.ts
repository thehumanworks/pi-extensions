import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { BashOperations, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { SshError } from "@earendil-works/pi-env";
import remoteExtension from "./index.ts";
import { hostId, parseRemoteTarget, resolveRemotePath } from "./hosts.ts";
import { RemoteSession } from "./session.ts";

// Loopback by default; set PI_REMOTE_TEST_ADDRESS to bind the disposable sshd elsewhere.
const address = process.env.PI_REMOTE_TEST_ADDRESS ?? "127.0.0.1";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("parses remote targets without treating cwd as an SSH option", () => {
	expect(parseRemoteTarget("alice@gpu.example:2222/work/app")).toEqual({
		user: "alice",
		host: "gpu.example",
		port: 2222,
		cwd: "/work/app",
	});
	expect(hostId(parseRemoteTarget("gpu.example"))).toBe("gpu.example");
	expect(() => parseRemoteTarget("-oProxyCommand=evil")).toThrow("Invalid remote target");
	expect(() => parseRemoteTarget("alice@-oProxyCommand=evil")).toThrow("Invalid SSH host");
});

test("accepts a cwd with or without a port, in path or scp form", () => {
	const cases: Array<[string, ReturnType<typeof parseRemoteTarget>]> = [
		["tomas@100.75.176.119/home/tomas", { user: "tomas", host: "100.75.176.119", cwd: "/home/tomas" }],
		["tomas@100.75.176.119:22/home/tomas", { user: "tomas", host: "100.75.176.119", port: 22, cwd: "/home/tomas" }],
		["tomas@100.75.176.119:/home/tomas", { user: "tomas", host: "100.75.176.119", cwd: "/home/tomas" }],
		["tomas@100.75.176.119:22:/home/tomas", { user: "tomas", host: "100.75.176.119", port: 22, cwd: "/home/tomas" }],
		["my-box:~/src/app", { host: "my-box", cwd: "~/src/app" }],
		["my-box:src/app", { host: "my-box", cwd: "src/app" }],
		["my-box:", { host: "my-box" }],
		["first-last@my-box.tail1234.ts.net/srv/My Projects", { user: "first-last", host: "my-box.tail1234.ts.net", cwd: "/srv/My Projects" }],
		["alice@corp.example@build:/work/a@b:c", { user: "alice@corp.example", host: "build", cwd: "/work/a@b:c" }],
		["[fd7a:115c::1]:2222/srv", { host: "fd7a:115c::1", port: 2222, cwd: "/srv" }],
		["[fd7a:115c::1]:~", { host: "fd7a:115c::1", cwd: "~" }],
	];
	for (const [target, expected] of cases) expect(parseRemoteTarget(target)).toEqual(expected);
	expect(hostId(parseRemoteTarget("[fd7a:115c::1]:2222/srv"))).toBe("[fd7a:115c::1]:2222");
	expect(() => parseRemoteTarget("host:0/srv")).toThrow("Invalid SSH port");
	expect(() => parseRemoteTarget("host:70000")).toThrow("Invalid SSH port");
	expect(() => parseRemoteTarget("[::1]x")).toThrow("Invalid remote target");
	expect(resolveRemotePath("~", "/home/tomas")).toBe("/home/tomas");
	expect(resolveRemotePath("~/src/", "/home/tomas")).toBe("/home/tomas/src");
	expect(resolveRemotePath("src", "/home/tomas")).toBe("/home/tomas/src");
	expect(resolveRemotePath("/srv/../opt", "/home/tomas")).toBe("/opt");
	expect(resolveRemotePath("~/src", "C:\\Users\\tomas", true)).toBe("C:\\Users\\tomas\\src");
});

test("local remains active until a remote host is selected", async () => {
	const session = new RemoteSession({ cwd: "/work" });
	expect(session.current()).toEqual({ id: "local", cwd: "/work", remote: false });
	expect(session.activeRemote()).toBeUndefined();
	session.close();
});

test("invalid host flags cannot bypass blocking an explicitly requested remote", async () => {
	const session = new RemoteSession({ cwd: "/work" });
	try {
		await expect(session.loadConfiguredHosts({ initial: "requested.example", hostList: "-invalid" }))
			.rejects.toThrow("Invalid remote target");
		expect(session.unavailable?.target).toBe("requested.example");
		expect(() => session.activeRemote()).toThrow("Execution is blocked");
	} finally {
		session.close();
	}
});

test("invalid optional config does not prevent initial host selection", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-remote-config-"));
	roots.push(root);
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "remote-hosts.json"), JSON.stringify({ hosts: 42 }));
	const session = new RemoteSession({ cwd: root, initial: "local" });
	try {
		await session.loadConfiguredHosts();
		expect(session.current()).toEqual({ id: "local", cwd: root, remote: false });
		expect(session.unavailable).toBeUndefined();
	} finally {
		session.close();
	}
});

test("connects to disposable SSH hosts and switches execution between them", async () => {
	const sshd = execFileSync("sh", ["-c", "command -v sshd"], { encoding: "utf8" }).trim();
	if (!sshd.startsWith("/")) throw new Error(`sshd must be resolved to an absolute path, got ${sshd}`);
	const root = mkdtempSync(join(tmpdir(), "pi-remote-e2e-"));
	roots.push(root);
	const firstHome = join(root, "one");
	const secondHome = join(root, "two");
	const first = await sshServer(root, "one", firstHome, sshd);
	const second = await sshServer(root, "two", secondHome, sshd);
	const logs: string[] = [];
	const session = new RemoteSession({
		cwd: root,
		hostList: `${userInfo().username}@${address}:${first.port}${firstHome}/srv/one,${userInfo().username}@${address}:${second.port}${secondHome}/srv/two`,
		identityFile: first.identity,
		knownHostsFile: join(root, "known_hosts"),
		sshConfigFile: sshConfig(root).file,
		log: (text) => logs.push(text),
	});
	session.hosts.get(hostId({ user: userInfo().username, host: address, port: first.port }))!.identityFile = first.identity;
	session.hosts.get(hostId({ user: userInfo().username, host: address, port: second.port }))!.identityFile = second.identity;
	try {
		const alpha = await session.use(`${userInfo().username}@${address}:${first.port}`, `${firstHome}/srv/one`);
		const beta = await session.use(`${userInfo().username}@${address}:${second.port}`, `${secondHome}/srv/two`);
		expect(alpha.remote).toBe(true);
		expect(beta.cwd).toBe(`${secondHome}/srv/two`);
		expect(logs.filter((line) => line.startsWith("Trusted first-seen host key"))).toHaveLength(2);
		const written = await session.execOn(beta.id, "printf remote > marker.txt");
		expect(written).toMatchObject({ ok: true, exitCode: 0 });
		expect(readFileSync(join(secondHome, "srv/two/marker.txt"), "utf8")).toBe("remote");
		const results = await Promise.all([session.probe(alpha.id), session.probe(beta.id)]);
		expect(results.map((result) => result.ok)).toEqual([true, true]);
		await session.copy(beta.id, `${secondHome}/srv/two/marker.txt`, alpha.id, `${firstHome}/srv/one/copied.txt`);
		expect(readFileSync(join(firstHome, "srv/one/copied.txt"), "utf8")).toBe("remote");
		await session.use("local");
		expect(session.current().remote).toBe(false);
	} finally {
		session.close();
		first.process.kill();
		second.process.kill();
	}
}, 30_000);

test("trusts the host key ssh already trusts, from a hashed known_hosts entry", async () => {
	const { root, home, server, config } = await singleHost();
	const [type, key] = readFileSync(server.hostKey, "utf8").trim().split(/\s+/);
	writeFileSync(config.knownHosts, `[${address}]:${server.port} ${type} ${key}\n`);
	execFileSync("ssh-keygen", ["-q", "-H", "-f", config.knownHosts], { stdio: "ignore" });
	const logs: string[] = [];
	const session = new RemoteSession({
		cwd: root,
		identityFile: server.identity,
		knownHostsFile: join(root, "known_hosts"),
		sshConfigFile: config.file,
		log: (text) => logs.push(text),
	});
	try {
		const current = await session.use(`${userInfo().username}@${address}:${server.port}`, `${home}/srv/one`);
		expect(current.remote).toBe(true);
		expect(readFileSync(join(root, "known_hosts"), "utf8")).toContain(`${type} ${key}`);
		expect(logs.join("")).not.toContain("first-seen");
	} finally {
		session.close();
		server.process.kill();
	}
}, 30_000);

test("refuses a host whose key differs from the one ssh trusts", async () => {
	const { root, home, server, config } = await singleHost();
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, "impostor")]);
	const [type, key] = readFileSync(join(root, "impostor.pub"), "utf8").trim().split(/\s+/);
	writeFileSync(config.knownHosts, `[${address}]:${server.port} ${type} ${key}\n`);
	const session = new RemoteSession({
		cwd: root,
		identityFile: server.identity,
		knownHostsFile: join(root, "known_hosts"),
		sshConfigFile: config.file,
	});
	try {
		await expect(session.use(`${userInfo().username}@${address}:${server.port}`, `${home}/srv/one`)).rejects.toThrow(/changed.*ssh-keygen -R/);
		expect(readFileSync(join(root, "known_hosts"), "utf8")).not.toContain(readFileSync(server.hostKey, "utf8").split(/\s+/)[1]!);
		expect(session.current().remote).toBe(false);
	} finally {
		session.close();
		server.process.kill();
	}
}, 30_000);

test("keeps configured identity files when the same host is listed by a flag", async () => {
	const { root, server, config } = await singleHost();
	const target = `${userInfo().username}@${address}:${server.port}`;
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "remote-hosts.json"), JSON.stringify({
		hosts: [{ target, identityFile: "../one_client" }],
	}));
	const session = new RemoteSession({
		cwd: root,
		hostList: target,
		knownHostsFile: join(root, "known_hosts"),
		sshConfigFile: config.file,
	});
	try {
		expect(session.hosts.get(target)?.identityFile).toBe(server.identity);
		// session_start applies CLI flags after construction as well.
		session.configure({ initial: target, hostList: target });
		expect(session.hosts.get(target)?.identityFile).toBe(server.identity);
		await session.loadConfiguredHosts();
		expect(session.current()).toMatchObject({ id: target, remote: true });
	} finally {
		session.close();
		server.process.kill();
	}
}, 30_000);

test("explains authentication failure and allows a successful retry", async () => {
	const { root, server, config } = await singleHost();
	const wrongIdentity = join(root, "wrong_client");
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", wrongIdentity]);
	const target = `${userInfo().username}@${address}:${server.port}`;
	const session = new RemoteSession({
		cwd: root,
		initial: target,
		identityFile: wrongIdentity,
		knownHostsFile: join(root, "known_hosts"),
		sshConfigFile: config.file,
	});
	try {
		let failure: unknown;
		try {
			await session.loadConfiguredHosts();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const error = failure as Error;
		expect(error.message).toContain(`SSH authentication failed for ${target}`);
		expect(error.message).toContain("BatchMode=yes");
		expect(error.message).toContain(wrongIdentity);
		expect(error.message).toContain(`-F '${config.file}'`);
		expect(error.message).toContain("process running Pi");
		expect(error.cause).toBeInstanceOf(SshError);
		expect(session.unavailable?.target).toBe(target);
		expect(() => session.activeRemote()).toThrow("Execution is blocked");

		// The failed host remains addressable so authentication can be fixed and retried.
		session.hosts.get(target)!.identityFile = server.identity;
		expect((await session.use(target)).remote).toBe(true);
		expect(session.unavailable).toBeUndefined();
		expect(session.activeRemote()).toBeDefined();
	} finally {
		session.close();
		server.process.kill();
	}
}, 30_000);

test("startup authentication failure keeps the extension usable without falling back to local tools", async () => {
	const { root, server, config } = await singleHost();
	const wrongIdentity = join(root, "wrong_client");
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", wrongIdentity]);
	const target = `${userInfo().username}@${address}:${server.port}`;
	const { tools, commands, handlers, notifications, statuses, ctx } = loadExtension(
		{ remote: target, "remote-identity": wrongIdentity },
		{ knownHosts: join(root, "known_hosts"), sshConfig: config.file },
	);
	try {
		// The handler reports the problem, not an unhandled extension error.
		await handlers.get("session_start")!({}, ctx);
		expect(notifications.at(-1)).toMatchObject({ level: "error" });
		expect(notifications.at(-1)?.message).toContain("SSH authentication failed");
		expect(statuses.get("remote")).toContain("unavailable");
		const status = await tools.get("remote_host")!.execute("status", { action: "status" }, undefined, undefined, ctx);
		expect(JSON.parse(status.content[0]!.type === "text" ? status.content[0]!.text : "{}").unavailable.target).toBe(target);
		for (const name of ["read", "write", "edit", "bash", "ls", "find", "grep"]) {
			await expect(Promise.resolve().then(() => tools.get(name)!.execute("blocked", {}, undefined, undefined, ctx)))
				.rejects.toThrow("Execution is blocked");
		}
		expect(() => handlers.get("user_bash")!({}, ctx)).toThrow("Execution is blocked");
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await handlers.get("before_agent_start")!(event, ctx);
		expect(event.systemPromptOptions.sections.execution_host).toContain("NOT fallen back to local");
		// SSH stderr can contain server-supplied banners; don't promote it into the system prompt.
		expect(event.systemPromptOptions.sections.execution_host).not.toContain("Permission denied");

		await commands.get("remote")!.handler("use local", ctx);
		expect(statuses.get("remote")).toBeUndefined();
		// Tool-driven switches also refresh the footer, not just slash commands.
		statuses.set("remote", "stale");
		await tools.get("remote_host")!.execute("switch", { action: "use", host: "local" }, undefined, undefined, ctx);
		expect(statuses.get("remote")).toBeUndefined();
		expect(handlers.get("user_bash")!({}, ctx)).toBeUndefined();
		const read = await tools.get("read")!.execute("local", { path: config.file }, undefined, undefined, ctx);
		expect(read.content[0]!.type === "text" && read.content[0]!.text).toContain("UserKnownHostsFile");
		await handlers.get("before_agent_start")!(event, ctx);
		expect(event.systemPromptOptions.sections.execution_host).toContain("Active execution host: local");
		expect(event.systemPromptOptions.sections.execution_host).not.toContain("blocked");
	} finally {
		await handlers.get("session_shutdown")!({}, ctx);
		server.process.kill();
	}
}, 30_000);

test("tools, ! commands and the system prompt use the remote cwd, not Pi's local one", async () => {
	const { root, home, server, config } = await singleHost();
	// A port-less, hyphenated alias, as with Tailscale MagicDNS names.
	appendFileSync(config.file, `Host pi-test-box\n  HostName ${address}\n  Port ${server.port}\n`);
	const target = `${userInfo().username}@pi-test-box`;
	writeFileSync(join(home, "srv/one/note.txt"), "remote note");
	const { tools, commands, handlers, ctx } = loadExtension(
		{ remote: target, "remote-identity": server.identity },
		{ knownHosts: join(root, "known_hosts"), sshConfig: config.file },
		// Pi passes its local session directory to tools and `!` commands; it does not exist on the remote.
		join(root, "local-only"),
	);
	const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("");
	const pwd = async () => text(await tools.get("bash")!.execute("pwd", { command: "pwd -P" }, undefined, undefined, ctx)).trim();
	try {
		await handlers.get("session_start")!({}, ctx);
		// Without a cwd, the remote home is used once the connection reports it.
		expect(await pwd()).toBe(realpathSync(home));

		await commands.get("remote")!.handler(`use ${target}:~/srv/one`, ctx);
		expect(await pwd()).toBe(realpathSync(join(home, "srv/one")));
		const read = await tools.get("read")!.execute("read", { path: "note.txt" }, undefined, undefined, ctx);
		expect(text(read)).toContain("remote note");
		await tools.get("write")!.execute("write", { path: "~/srv/one/written.txt", content: "via tilde" }, undefined, undefined, ctx);
		expect(readFileSync(join(home, "srv/one/written.txt"), "utf8")).toBe("via tilde");

		const { operations } = handlers.get("user_bash")!({}, ctx) as { operations: BashOperations };
		const output: string[] = [];
		await operations.exec("pwd -P", ctx.cwd, { onData: (data) => output.push(data.toString()) });
		expect(output.join("").trim()).toBe(realpathSync(join(home, "srv/one")));

		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await handlers.get("before_agent_start")!(event, ctx);
		expect(event.systemPromptOptions.sections.cwd).toBe(join(home, "srv/one"));
		expect(event.systemPromptOptions.sections.execution_host).toContain(`Working directory: ${join(home, "srv/one")}`);

		// The absolute-path form, and a directory that does not exist yet.
		await commands.get("remote")!.handler(`use ${target}${home}/srv/new`, ctx);
		expect(await pwd()).toBe(realpathSync(join(home, "srv/new")));
	} finally {
		await handlers.get("session_shutdown")!({}, ctx);
		server.process.kill();
	}
}, 30_000);

/** Loads the extension against a minimal Pi API whose context reports `cwd` as Pi's local session directory. */
function loadExtension(flags: Record<string, string>, files: { knownHosts: string; sshConfig: string }, cwd?: string) {
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	// Event payloads differ by event name; the real extension supplies the typed handlers.
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		hasUI: true,
		...(cwd ? { cwd } : {}),
		sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			theme: { fg: (_color: string, value: string) => value },
		},
	} as unknown as ExtensionCommandContext & ExtensionToolContext;
	const previousKnownHosts = process.env.PI_REMOTE_KNOWN_HOSTS;
	const previousSshConfig = process.env.PI_REMOTE_SSH_CONFIG;
	try {
		process.env.PI_REMOTE_KNOWN_HOSTS = files.knownHosts;
		process.env.PI_REMOTE_SSH_CONFIG = files.sshConfig;
		remoteExtension({
			registerFlag: () => {},
			getFlag: (name: string) => flags[name],
			registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
			registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
			on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		} as unknown as ExtensionAPI);
	} finally {
		if (previousKnownHosts === undefined) delete process.env.PI_REMOTE_KNOWN_HOSTS;
		else process.env.PI_REMOTE_KNOWN_HOSTS = previousKnownHosts;
		if (previousSshConfig === undefined) delete process.env.PI_REMOTE_SSH_CONFIG;
		else process.env.PI_REMOTE_SSH_CONFIG = previousSshConfig;
	}
	return { tools, commands, handlers, notifications, statuses, ctx };
}

async function singleHost() {
	const sshd = execFileSync("sh", ["-c", "command -v sshd"], { encoding: "utf8" }).trim();
	const root = mkdtempSync(join(tmpdir(), "pi-remote-e2e-"));
	roots.push(root);
	const home = join(root, "one");
	return { root, home, server: await sshServer(root, "one", home, sshd), config: sshConfig(root) };
}

/** An ssh_config whose known-hosts files are the test's own, standing in for ~/.ssh/config and ~/.ssh/known_hosts. */
function sshConfig(root: string) {
	const file = join(root, "ssh_config");
	const knownHosts = join(root, "openssh_known_hosts");
	writeFileSync(file, `UserKnownHostsFile ${knownHosts}\nGlobalKnownHostsFile none\n`);
	return { file, knownHosts };
}

async function sshServer(root: string, name: string, home: string, sshd: string) {
	mkdirSync(join(home, "srv", name), { recursive: true });
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, `${name}_host`)]);
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, `${name}_client`)]);
	writeFileSync(join(root, `${name}_authorized`), readFileSync(join(root, `${name}_client.pub`)));
	const port = await freePort();
	const sshdDefaults = execFileSync(sshd, ["-T", "-f", "/dev/null", "-h", join(root, `${name}_host`)], { encoding: "utf8" });
	writeFileSync(join(root, `${name}_sshd_config`), [
		`Port ${port}`,
		`ListenAddress ${address}`,
		`HostKey ${join(root, `${name}_host`)}`,
		`AuthorizedKeysFile ${join(root, `${name}_authorized`)}`,
		`PidFile ${join(root, `${name}_sshd.pid`)}`,
		"PasswordAuthentication no",
		"KbdInteractiveAuthentication no",
		"StrictModes no",
		// New OpenSSH versions otherwise rate-limit the deliberate authentication failures in these tests.
		...(sshdDefaults.includes("persourcepenalties ") ? ["PerSourcePenalties no"] : []),
		`SetEnv HOME=${home}`,
		"",
	].join("\n"));
	const process = spawn(sshd, ["-D", "-e", "-f", join(root, `${name}_sshd_config`)], { stdio: "ignore" });
	await waitForPort(port);
	return { port, process, identity: join(root, `${name}_client`), hostKey: join(root, `${name}_host.pub`) };
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, address, () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("no port"));
			server.close(() => resolve(address.port));
		});
	});
}

async function waitForPort(port: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await new Promise<void>((resolve, reject) => {
				const socket = createServer().listen(port, address);
				socket.once("listening", () => socket.close(() => reject(new Error("closed"))));
				socket.once("error", () => resolve());
			});
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(`port ${port} did not open`);
}
