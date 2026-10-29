import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type FileEntry, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, Models, ToolCall } from "@earendil-works/pi-ai";
import { composePrompt, invokeTool, type BotProject } from "./project.js";
import { loadPiExtensions, matches, mcpCredentials } from "./pi-internals.js";
import { BotError } from "./errors.js";
import type { ThinkingLevel, BotHistoryQuery, BotHistoryPage } from "./types.js";

export async function verifyPiEntries(project: BotProject): Promise<void> {
  for (const [file, expected] of Object.entries(project.extensionHashes)) {
    if (createHash("sha256").update(await readFile(file)).digest("hex") !== expected) throw new BotError("CONFLICT", `Pi extension changed after capability compilation: ${file}`);
  }
}
/** Factories may register capabilities, but Pi's contract forbids starting session resources here. */
export async function validatePiFactories(project: BotProject, cwd: string): Promise<void> {
  await verifyPiEntries(project);
  const loaded = await loadPiExtensions(project.extensionPaths, cwd, [], project.definition.excludeMcpServers);
  if (loaded.errors.length) throw new BotError("UNAVAILABLE", loaded.errors.map(error => `${error.path}: ${error.error}`).join("\n"));
  await verifyPiEntries(project);
}
export interface NativeSession {
  session: AgentSession;
  entries(): FileEntry[];
  callTool(name: string, input: unknown, signal: AbortSignal): ReturnType<ReturnType<AgentSession["extensionRunner"]["createToolContext"]>["executeTool"]>;
  tools(): Array<{ name: string; description: string; source: string }>;
  close(reason?: "reload" | "quit"): Promise<void>;
}
/** A real Pi session owns the whole model/tool pipeline, including nested MCP calls.
 * No model/tool events are emulated by the durable scheduler.
 */
export async function createNativeSession(options: {
  project: BotProject; cwd: string; sourceDir: string; stateDir: string; sessionId: string;
  models: Models; model: Model<Api>; thinking: ThinkingLevel; defaults: Record<string, any>;
  history: (query: BotHistoryQuery, signal: AbortSignal) => Promise<BotHistoryPage>;
  entries?: FileEntry[]; onBoundary: () => Promise<BotProject>; onDiagnostic: (message: string) => void; runId: () => string | undefined;
}): Promise<NativeSession> {
  const { cwd, sourceDir, stateDir, sessionId } = options;
  let project = options.project;
  let publish: (next: BotProject) => void = () => {};
  const modelRuntime = await ModelRuntime.create({ authPath: join(project.agentDir, "auth.json"), modelsPath: join(project.agentDir, "models.json"), modelsStorePath: join(project.agentDir, "models-store.json"), allowModelNetwork: false });
  // Host-supplied offline providers remain native providers, not stream-function shims.
  for (const provider of options.models.getProviders()) modelRuntime.registerNativeProvider(provider);
  await verifyPiEntries(project);
  const extensions = await loadPiExtensions(project.extensionPaths, cwd, [], project.definition.excludeMcpServers);
  if (extensions.errors.length) throw new BotError("UNAVAILABLE", extensions.errors.map(error => `${error.path}: ${error.error}`).join("\n"));
  await verifyPiEntries(project);
  const factories: ExtensionFactory[] = [];
  const hasTool = (name: string) => extensions.extensions.some(extension => extension.tools.has(name));
  const hasCommand = (name: string) => extensions.extensions.some(extension => extension.commands.has(name));
  const enabled = (name: string) => !project.disabledPiBuiltins.includes(name);
  // Pi registers codemode inactive. "on" is its loadout mode, not activation;
  // selection, an extension, or MCP must activate it (also with inherit: none).
  if (enabled("codemode") && !hasTool("codemode")) factories.push(createCodemodeExtension({ mode: "on" }));
  if (enabled("tool_search") && !hasTool("tool_search")) factories.push(createToolSearchExtension());
  if (enabled("mcp") && !hasCommand("mcp")) factories.push(createMcpExtension({
    loadConfig: () => project.mcpConfig,
    credentials: await mcpCredentials(project.agentDir), logPath: join(project.agentDir, "mcp.log"),
    // A bot may use user configuration, but its /mcp command must not rewrite it.
    updateConfig: () => { throw new Error("Change user MCP configuration through Pi, then reload the bot."); },
  }));
  // Load built-ins into the SAME runtime as user extensions (including registered MCP servers).
  const { appendPiFactories } = await import("./pi-internals.js");
  await appendPiFactories(extensions, cwd, factories);
  // This inactive orchestrator uses Pi's reachesTools readiness contract. Its nested
  // target still goes through the ordinary SDK validation, exposure and permission gates.
  // A unique name prevents collisions with authored extensions.
  const dispatcher = `pi_runtime_dispatch_${randomUUID().replaceAll("-", "")}`;
  const allowlist = project.definition.tools;
  const excluded = project.definition.excludeTools ?? [];
  // Bot-local tools win name collisions, while global lifecycle handlers remain installed.
  for (const extension of extensions.extensions) for (const tool of project.tools) if (tool.source !== "pi:builtin") extension.tools.delete(tool.name);
  await appendPiFactories(extensions, cwd, [pi => {
    pi.registerTool({
      name: dispatcher, label: "Bot runtime dispatch", description: "Host tool-call dispatch through Pi readiness and permission checks.",
      exposure: "deferred", parameters: Type.Object({ name: Type.String(), input: Type.Unknown() }),
      reachesTools: args => typeof args.name !== "string" ? [] : ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(args.name) ? "all" : [args.name],
      execute: async (_id, args, signal, _update, ctx) => {
        signal?.throwIfAborted();
        if (args.name === dispatcher) throw new Error("Recursive runtime dispatch is not allowed.");
        const outcome = await ctx.executeTool(args.name, args.input, { signal });
        // Pi accounts for nested usage itself; don't report it twice.
        const { usage: _usage, ...result } = outcome.result;
        return { ...result, isError: outcome.isError };
      },
    });
    let registered = new Set<string>();
    publish = next => {
      project = next;
      const tools = project.tools.filter(tool => tool.source !== "pi:builtin");
      for (const name of registered) if (!tools.some(tool => tool.name === name)) {
        const previous = pi.getAllTools().find(tool => tool.name === name);
        if (previous) pi.registerTool({ name, label: name, description: "Withdrawn bot tool", parameters: previous.parameters, exposure: "hidden", execute: async () => { throw new Error("Tool withdrawn"); } });
      }
      for (const tool of tools) pi.registerTool({
        name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
        execute: async (_id, args, signal) => {
          const result = await invokeTool(tool, args, { cwd, sourceDir, stateDir, sessionId, history: options.history, runId: options.runId(), signal: signal ?? new AbortController().signal });
          return { ...result, details: result.details };
        },
      });
      registered = new Set(tools.map(tool => tool.name));
    };
    publish(project);
    pi.on("tool_call", event => {
      if (event.toolName === dispatcher) return; // Infrastructure only; the target is checked on its nested call.
      if (matches(event.toolName, excluded) || (allowlist !== undefined && !matches(event.toolName, allowlist))) return { block: true, reason: "Tool excluded by BOT.md" };
    });
    pi.on("before_agent_start", async event => { event.systemPromptOptions.customPrompt = await composePrompt(project, cwd); });
    pi.on("turn_end", async () => {
      const revision = project.info.revision;
      const next = await options.onBoundary();
      if (next.info.revision !== revision) {
        publish(next);
        pi.sendMessage({ customType: "bot-capability-update", content: await composePrompt(next, cwd), display: false }, { deliverAs: "steer" });
      }
    });
  }]);
  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => project.prompt,
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => { throw new Error("Use bot.reload() at an idle boundary."); },
  };
  const settingsManager = SettingsManager.inMemory({ ...options.defaults, packages: [], extensions: [], skills: [], prompts: [], themes: [],
    defaultTools: project.initialTools, cacheWarming: "off",
  });
  const manager = SessionManager.inMemory(cwd, undefined, options.entries);
  let session: AgentSession | undefined;
  try {
    ({ session } = await createAgentSession({ cwd, agentDir: project.agentDir, modelRuntime,
      model: options.model as unknown as NonNullable<Parameters<typeof createAgentSession>[0]>["model"], thinkingLevel: options.thinking,
      resourceLoader, settingsManager, sessionManager: manager, tools: allowlist === undefined ? undefined : [...allowlist, dispatcher], excludeTools: excluded,
    }));
    session.extensionRunner.onError(error => options.onDiagnostic(`${error.extensionPath}: ${error.event}: ${error.error}`));
    await session.bindExtensions({ shutdownHandler: () => { void session!.abort(); }, uiContext: {
      ...session.extensionRunner.createContext().ui,
      notify: (message, level) => { if (level === "warning" || level === "error") options.onDiagnostic(message); },
    } });
    // Pi 1.4's nested-call runner expects an issuing assistant and obtains hook
    // cancellation from the session operation. Host calls are idle operations: supply
    // a transient issuer (never a SessionManager entry) and an operation-scoped signal.
    let directSignal: AbortSignal | undefined;
    const createContext = session.extensionRunner.createContext.bind(session.extensionRunner);
    session.extensionRunner.createContext = () => {
      const ctx = createContext();
      if (directSignal) Object.defineProperty(ctx, "signal", { get: () => directSignal, configurable: true });
      return ctx;
    };
    let closed = false;
    return { session, entries: () => [manager.getHeader()!, ...manager.getEntries()],
      async callTool(name, input, signal) {
        signal.throwIfAborted();
        if (closed || directSignal || !session!.isIdle) throw new BotError("UNAVAILABLE", "Native direct calls require an idle, open session.");
        const id = `bot-direct:${randomUUID()}`;
        const mcp = name.startsWith("mcp__") || ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name);
        const target = mcp ? dispatcher : name;
        const args = mcp ? { name, input } : input;
        directSignal = signal;
        session!.agent.state.messages = [...session!.agent.state.messages, {
          role: "assistant", content: [{ type: "toolCall", id, name: target, arguments: args as ToolCall["arguments"] }],
          api: options.model.api, provider: options.model.provider, model: options.model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: Date.now(),
        }];
        try {
          return await session!.extensionRunner.createToolContext(id, signal).executeTool(target, args, { signal });
        } finally {
          directSignal = undefined;
          session!.refreshContext(); // Restore canonical history, retaining legitimate extension entries.
        }
      },
      tools() {
        const reachable = new Set([...session!.getActiveToolNames(), ...session!.getCallableToolNames()]);
        return session!.getAllTools().filter(tool => tool.name !== dispatcher && reachable.has(tool.name) &&
          !matches(tool.name, excluded) && (allowlist === undefined || matches(tool.name, allowlist)))
          .map(tool => ({ name: tool.name, description: tool.description, source: project.tools.find(owned => owned.name === tool.name)?.source ?? tool.sourceInfo.path }));
      },
      async close(reason = "quit") {
        if (closed) return; closed = true;
        try { await session!.abort(); await session!.extensionRunner.emit({ type: "session_shutdown", reason }); }
        finally { session!.dispose(); }
      },
    };
  } catch (error) {
    if (session) { try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); } }
    throw error;
  }
}
