import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { hostId, parseRemoteTarget } from "./hosts.ts";
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
});

test("local remains active until a remote host is selected", async () => {
	const session = new RemoteSession({ cwd: "/work" });
	expect(session.current()).toEqual({ id: "local", cwd: "/work", remote: false });
	expect(session.activeEnv()).toBeUndefined();
	session.close();
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
	writeFileSync(join(root, `${name}_sshd_config`), [
		`Port ${port}`,
		`ListenAddress ${address}`,
		`HostKey ${join(root, `${name}_host`)}`,
		`AuthorizedKeysFile ${join(root, `${name}_authorized`)}`,
		`PidFile ${join(root, `${name}_sshd.pid`)}`,
		"PasswordAuthentication no",
		"KbdInteractiveAuthentication no",
		"StrictModes no",
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
