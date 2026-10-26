// Shared eval plumbing: the user's model credentials, isolated Pi sessions, and model calls.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	getAgentDir,
	ModelRuntime,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const BRIDGE = join(homedir(), ".pi/agent/npm/node_modules/pi-claude-bridge");
export const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

let runtime: Promise<{ modelRuntime: ModelRuntime; keepalive: AgentSession }> | undefined;

/** One runtime with the user's credentials and the Claude bridge provider loaded. */
export function models() {
	runtime ??= (async () => {
		const agentDir = getAgentDir();
		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		// Extension providers register while a session loads them; keep one idle session for the bridge.
		const keepalive = await session({ modelRuntime, cwd: process.cwd(), model: "openai/gpt-6-luna", bridge: true, tools: [] });
		return { modelRuntime, keepalive: keepalive.session };
	})();
	return runtime;
}

export function find(modelRuntime: ModelRuntime, selector: string): Model<Api> {
	const slash = selector.indexOf("/");
	const model = modelRuntime.getModel(selector.slice(0, slash), selector.slice(slash + 1));
	if (!model) throw new Error(`unknown model ${selector}`);
	return model;
}

export async function complete(selector: string, context: Context, options: SimpleStreamOptions = {}): Promise<AssistantMessage> {
	const { modelRuntime } = await models();
	return modelRuntime.completeSimple(find(modelRuntime, selector), context, options);
}

export interface SessionOptions {
	modelRuntime: ModelRuntime;
	cwd: string;
	model: string;
	thinking?: "off" | "low" | "medium";
	settings?: Record<string, unknown>;
	sessionManager?: SessionManager;
	extensions?: ExtensionFactory[];
	bridge?: boolean;
	tools?: string[];
}

/** An isolated Pi session: no discovered extensions, skills, prompts, or context files. */
export async function session(options: SessionOptions) {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3 }, ...options.settings } as never);
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: options.bridge ? [BRIDGE] : [],
		extensionFactories: options.extensions ?? [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		modelRuntime: options.modelRuntime,
		model: find(options.modelRuntime, options.model),
		thinkingLevel: options.thinking ?? "low",
		resourceLoader,
		settingsManager,
		sessionManager: options.sessionManager,
		tools: options.tools ?? TOOLS,
	});
	await session.bindExtensions({});
	return { session, settingsManager };
}

export const text = (message: AssistantMessage | undefined) =>
	(message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
