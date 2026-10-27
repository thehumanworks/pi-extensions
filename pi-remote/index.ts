import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { BashOperations, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createRemoteBashOperations,
	createRemoteEditOperations,
	createRemoteFindOperations,
	createRemoteGrepOperations,
	createRemoteLsOperations,
	createRemoteReadOperations,
	createRemoteWriteOperations,
} from "./operations.ts";
import { resolveRemotePath } from "./hosts.ts";
import { RemoteSession, type ConnectedRemote } from "./session.ts";

const remoteHostSchema = Type.Object({
	action: Type.Union([
		Type.Literal("status"),
		Type.Literal("use"),
		Type.Literal("switch"),
		Type.Literal("probe"),
		Type.Literal("exec"),
		Type.Literal("copy"),
		Type.Literal("forget"),
	]),
	host: Type.Optional(Type.String({ description: "local, user@host[:port][/absolute/cwd] or user@host[:port]:cwd" })),
	hosts: Type.Optional(Type.Array(Type.String(), { description: "Hosts for probe or exec" })),
	cwd: Type.Optional(Type.String({ description: "Remote working directory when switching; ~ and relative paths start at the remote home" })),
	command: Type.Optional(Type.String({ description: "Command for exec" })),
	timeoutSeconds: Type.Optional(Type.Number()),
	sourceHost: Type.Optional(Type.String()),
	sourcePath: Type.Optional(Type.String()),
	destinationHost: Type.Optional(Type.String()),
	destinationPath: Type.Optional(Type.String()),
});

function flag(pi: ExtensionAPI, name: string): string | undefined {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textResult(text: string, details: unknown = undefined) {
	return { content: [{ type: "text" as const, text }], details };
}

/** Pi's tools prefer `ctx.cwd`, the local session directory, over the cwd they were created with. */
function withCwd<T extends object>(ctx: T, cwd: string): T {
	return Object.create(ctx, { cwd: { value: cwd, enumerable: true } });
}

/** Pi expands `~` in tool paths to the local home. */
function withRemoteHome<T>(params: T, remote: ConnectedRemote): T {
	const path = (params as { path?: unknown } | undefined)?.path;
	if (typeof path !== "string" || (path !== "~" && !path.startsWith("~/"))) return params;
	return { ...params, path: resolveRemotePath(path, remote.platform.home, remote.platform.platform === "windows") };
}

/** `!` commands run in Pi's local session directory unless redirected to the remote cwd. */
function inRemoteCwd(operations: BashOperations, remote: ConnectedRemote): BashOperations {
	return { exec: (command, _cwd, options) => operations.exec(command, remote.cwd, options) };
}

export default function remoteExtension(pi: ExtensionAPI) {
	pi.registerFlag("remote", { type: "string", description: "Initial execution host: user@host[:port][/absolute/cwd] or user@host[:port]:cwd" });
	pi.registerFlag("remote-hosts", { type: "string", description: "Comma-separated remote hosts available to the agent" });
	pi.registerFlag("remote-identity", { type: "string", description: "SSH private key for remote hosts" });

	const session = new RemoteSession({
		cwd: process.cwd(),
		identityFile: process.env.PI_REMOTE_IDENTITY,
		knownHostsFile: process.env.PI_REMOTE_KNOWN_HOSTS,
		sshConfigFile: process.env.PI_REMOTE_SSH_CONFIG,
		log: (text) => process.stderr.write(text),
	});

	const registerRemoteTool = <TParams extends TSchema, TDetails, TOperations>(
		create: (cwd: string, options?: { operations?: TOperations }) => ToolDefinition<TParams, TDetails>,
		operations: (env: ConnectedRemote["env"]) => TOperations,
	) => pi.registerTool({
		...create(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) => {
			const remote = session.activeRemote();
			if (!remote) return create(session.localCwd).execute(id, params, signal, onUpdate, ctx);
			return create(remote.cwd, { operations: operations(remote.env) })
				.execute(id, withRemoteHome(params, remote), signal, onUpdate, withCwd(ctx, remote.cwd));
		},
	});
	registerRemoteTool(createReadToolDefinition, createRemoteReadOperations);
	registerRemoteTool(createWriteToolDefinition, createRemoteWriteOperations);
	registerRemoteTool(createEditToolDefinition, createRemoteEditOperations);
	registerRemoteTool(createBashToolDefinition, createRemoteBashOperations);
	registerRemoteTool(createLsToolDefinition, createRemoteLsOperations);
	registerRemoteTool(createFindToolDefinition, createRemoteFindOperations);
	registerRemoteTool(createGrepToolDefinition, createRemoteGrepOperations);

	pi.registerTool({
		name: "remote_host",
		label: "remote host",
		description: "Inspect or change the host where read, write, edit, bash, ls, find, and grep execute. Use local for this machine. Hosts added here remain available for later calls.",
		parameters: remoteHostSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "status":
					return textResult(JSON.stringify({ current: session.current(), hosts: session.list(), unavailable: session.unavailable }, null, 2), session.current());
				case "use":
				case "switch": {
					if (!params.host) throw new Error("host is required");
					const current = await session.use(params.host, params.cwd);
					renderStatus(ctx);
					return textResult(`Execution host is now ${current.id}${current.remote ? ` (${current.cwd})` : ""}`, current);
				}
				case "probe":
					return textResult(JSON.stringify(await Promise.all((params.hosts ?? [session.current().id]).map((host) => session.probe(host))), null, 2));
				case "exec": {
					if (!params.command) throw new Error("command is required");
					const hosts = params.hosts ?? [...session.hosts.keys()];
					return textResult(JSON.stringify(await Promise.all(hosts.map((host) => session.execOn(host, params.command!, params.timeoutSeconds))), null, 2));
				}
				case "copy": {
					if (!params.sourceHost || !params.sourcePath || !params.destinationHost || !params.destinationPath) {
						throw new Error("copy requires sourceHost, sourcePath, destinationHost, and destinationPath");
					}
					return textResult(await session.copy(params.sourceHost, params.sourcePath, params.destinationHost, params.destinationPath));
				}
				case "forget": {
					if (!params.host) throw new Error("host is required");
					await session.forget(params.host);
					renderStatus(ctx);
					return textResult(`Forgot trusted host key for ${params.host}`);
				}
			}
		},
	});

	pi.registerCommand("remote", {
		description: "Show or switch the execution host",
		handler: async (args, ctx) => {
			const [action = "status", host, ...cwdParts] = args.trim().split(/\s+/);
			if (action === "use" && host) await session.use(host, cwdParts.join(" ") || undefined);
			const current = session.current();
			renderStatus(ctx);
			if (session.unavailable) {
				ctx.ui.notify(`Remote host unavailable: ${session.unavailable.target}\n${session.unavailable.message}`, "error");
			} else {
				ctx.ui.notify(`Execution host: ${current.id}${current.remote ? ` (${current.cwd})` : ""}`, "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await session.loadConfiguredHosts({
				initial: flag(pi, "remote"),
				hostList: flag(pi, "remote-hosts"),
				identityFile: flag(pi, "remote-identity") ?? process.env.PI_REMOTE_IDENTITY,
			});
		} catch (error) {
			ctx.ui.notify(
				`${error instanceof Error ? error.message : String(error)}\n${session.unavailable
					? "File and shell tools are blocked. Retry with /remote use <host> or choose /remote use local."
					: "Use /remote to inspect or select an execution host."}`,
				"error",
			);
		}
		renderStatus(ctx);
	});
	pi.on("session_shutdown", async () => session.close());
	pi.on("user_bash", () => {
		const remote = session.activeRemote();
		return remote ? { operations: inRemoteCwd(createRemoteBashOperations(remote.env), remote) } : undefined;
	});
	if (process.env.PI_REMOTE_TEST_MAX_TOKENS) {
		const maxTokens = Number(process.env.PI_REMOTE_TEST_MAX_TOKENS);
		pi.on("before_provider_request", (event) => {
			if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) || !Number.isSafeInteger(maxTokens)) return;
			const payload = event.payload as Record<string, unknown>;
			if ("max_tokens" in payload) payload.max_tokens = maxTokens;
			if ("max_completion_tokens" in payload) payload.max_completion_tokens = maxTokens;
		});
	}
	pi.on("before_agent_start", async (event) => {
		const current = session.current();
		const available = session.list().map((host) => host.id).join(", ");
		event.systemPromptOptions.sections.execution_host = [
			...(session.unavailable ? [
				`Requested execution host is unavailable: ${session.unavailable.target}`,
				"Initial remote setup failed. Call remote_host status to inspect the error.",
				"Built-in file and shell tools are blocked; they have NOT fallen back to local execution. Tell the user and retry the requested host, or ask before switching to local.",
			] : [
				`Active execution host: ${current.id}`,
				`Working directory: ${current.cwd}`,
			]),
			`Available hosts: ${available}`,
			"Built-in file and shell tools follow the active host. Call remote_host to switch hosts, probe them, run one command on many hosts, or copy files between them.",
		].join("\n");
		// Pi's own <cwd> section names the local directory.
		if (current.remote) event.systemPromptOptions.sections.cwd = current.cwd;
	});

	function renderStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const current = session.current();
		ctx.ui.setStatus("remote", session.unavailable
			? ctx.ui.theme.fg("error", `remote unavailable: ${session.unavailable.target}`)
			: current.remote ? ctx.ui.theme.fg("accent", `remote ${current.id}`) : undefined);
	}
}

export { remoteExtension };
