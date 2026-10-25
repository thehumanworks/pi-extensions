import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { RemoteSession } from "./session.ts";

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
	host: Type.Optional(Type.String({ description: "local or user@host[:port][/absolute/cwd]" })),
	hosts: Type.Optional(Type.Array(Type.String(), { description: "Hosts for probe or exec" })),
	cwd: Type.Optional(Type.String({ description: "Absolute remote working directory when switching" })),
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

export default function remoteExtension(pi: ExtensionAPI) {
	pi.registerFlag("remote", { type: "string", description: "Initial execution host: user@host[:port][/cwd]" });
	pi.registerFlag("remote-hosts", { type: "string", description: "Comma-separated remote hosts available to the agent" });
	pi.registerFlag("remote-identity", { type: "string", description: "SSH private key for remote hosts" });
	pi.registerFlag("remote-trust-new", { type: "boolean", description: "Trust a remote host key on its first connection" });

	const session = new RemoteSession({
		cwd: process.cwd(),
		identityFile: process.env.PI_REMOTE_IDENTITY,
		knownHostsFile: process.env.PI_REMOTE_KNOWN_HOSTS,
		sshConfigFile: process.env.PI_REMOTE_SSH_CONFIG,
		trustUnknownHostKeys: pi.getFlag("remote-trust-new") === true || process.env.PI_REMOTE_TRUST_NEW === "1",
		log: (text) => process.stderr.write(text),
	});

	const toolCwd = () => session.current().cwd;
	const operationsFor = <T>(create: (env: NonNullable<ReturnType<RemoteSession["activeEnv"]>>) => T): T | undefined => {
		const env = session.activeEnv();
		return env ? create(env) : undefined;
	};

	pi.registerTool({
		...createReadToolDefinition(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) =>
			createReadToolDefinition(toolCwd(), { operations: operationsFor(createRemoteReadOperations) }).execute(id, params, signal, onUpdate, ctx),
	});
	pi.registerTool({
		...createWriteToolDefinition(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) =>
			createWriteToolDefinition(toolCwd(), { operations: operationsFor(createRemoteWriteOperations) }).execute(id, params, signal, onUpdate, ctx),
	});
	pi.registerTool({
		...createEditToolDefinition(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) =>
			createEditToolDefinition(toolCwd(), { operations: operationsFor(createRemoteEditOperations) }).execute(id, params, signal, onUpdate, ctx),
	});
	pi.registerTool({
		...createBashToolDefinition(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) =>
			createBashToolDefinition(toolCwd(), { operations: operationsFor(createRemoteBashOperations) }).execute(id, params, signal, onUpdate, ctx),
	});
	pi.registerTool({
		...createLsToolDefinition(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) =>
			createLsToolDefinition(toolCwd(), { operations: operationsFor(createRemoteLsOperations) }).execute(id, params, signal, onUpdate, ctx),
	});
	pi.registerTool({
		...createFindToolDefinition(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) =>
			createFindToolDefinition(toolCwd(), { operations: operationsFor(createRemoteFindOperations) }).execute(id, params, signal, onUpdate, ctx),
	});
	pi.registerTool({
		...createGrepToolDefinition(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) =>
			createGrepToolDefinition(toolCwd(), { operations: operationsFor(createRemoteGrepOperations) }).execute(id, params, signal, onUpdate, ctx),
	});

	pi.registerTool({
		name: "remote_host",
		label: "remote host",
		description: "Inspect or change the host where read, write, edit, bash, ls, find, and grep execute. Use local for this machine. Hosts added here remain available for later calls.",
		parameters: remoteHostSchema,
		async execute(_id, params) {
			switch (params.action) {
				case "status":
					return textResult(JSON.stringify({ current: session.current(), hosts: session.list() }, null, 2), session.current());
				case "use":
				case "switch": {
					if (!params.host) throw new Error("host is required");
					const current = await session.use(params.host, params.cwd);
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
			ctx.ui.notify(`Execution host: ${current.id}${current.remote ? ` (${current.cwd})` : ""}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		session.configure({
			initial: flag(pi, "remote"),
			hostList: flag(pi, "remote-hosts"),
			identityFile: flag(pi, "remote-identity") ?? process.env.PI_REMOTE_IDENTITY,
		});
		await session.loadConfiguredHosts();
		renderStatus(ctx);
	});
	pi.on("session_shutdown", async () => session.close());
	pi.on("user_bash", () => {
		const operations = operationsFor(createRemoteBashOperations);
		return operations ? { operations } : undefined;
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
			`Active execution host: ${current.id}`,
			`Working directory: ${current.cwd}`,
			`Available hosts: ${available}`,
			"Built-in file and shell tools follow the active host. Call remote_host to switch hosts, probe them, run one command on many hosts, or copy files between them.",
		].join("\n");
	});

	function renderStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const current = session.current();
		ctx.ui.setStatus("remote", current.remote ? ctx.ui.theme.fg("accent", `remote ${current.id}`) : undefined);
	}
}

export { remoteExtension };
