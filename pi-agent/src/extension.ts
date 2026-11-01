import { existsSync } from "node:fs";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AgentDefinitionError, loadAgentDefinition, type AgentFile } from "./agent.ts";
import { discoverAgents, type DiscoverAgentsOptions, type DiscoveredAgent } from "./discovery.ts";
import { ensureAgentHome, homeOwner } from "./homes.ts";
import { resolveAgentModel } from "./model.ts";
import {
  AGENT_ENTRY_TYPE,
  createAgentSessionFile,
  defaultSessionDir,
  readAgentMarker,
  scratchSessionDir,
  type AgentSessionMarker,
} from "./session.ts";
import { activeTools, toolPolicy, unmatchedTools, type ToolPolicy } from "./tools.ts";
import { projectAgentsTrusted } from "./trust.ts";

// Starting an agent replaces the session with a new one rooted in the agent's home. The session
// then runs with the agent's Markdown body in place of Pi's base prompt, as `SYSTEM.md` would,
// and with the agent's tools and model.

const STATUS_KEY = "pi-agent";

// Frontmatter fields Claude Code honours that this package does not apply yet.
const UNSUPPORTED_FIELDS = ["permissionMode", "maxTurns", "skills", "mcpServers", "hooks", "memory", "background", "isolation"] as const;

// Applied when a session's agent cannot be loaded: it may have been restricted, so nothing is granted.
const DENY_ALL: ToolPolicy = { allows: () => false, restricted: true, warnings: [] };

type Prompt = { text: string; images?: ImageContent[] };

/** The context `withSession` receives for the replacement session. */
type ReplacedSessionContext = Parameters<NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>>[0];

type ActiveAgent = { marker: AgentSessionMarker; file?: AgentFile; policy: ToolPolicy };

/** `--agent` cannot change the cwd Pi starts in, so the startup session switches before its first prompt. */
type StartupSwitch = {
  name: string;
  begun: boolean;
  /** The prompt that arrived before the switch, sent to the agent's session instead. */
  prompt?: Prompt;
  /** The agent's session, once the switch has happened. */
  next?: ReplacedSessionContext;
  /** The agent could not start; later prompts are refused rather than answered by Pi's default agent. */
  failed?: boolean;
  done: Promise<void>;
  finish: () => void;
};

export default function piAgent(pi: ExtensionAPI) {
  let active: ActiveAgent | undefined;
  let startup: StartupSwitch | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  // Completions have no context, so they use the latest session's.
  let lookup: DiscoverAgentsOptions = { cwd: process.cwd(), projectTrusted: false };

  const discoveryFor = (ctx: ExtensionContext): DiscoverAgentsOptions => {
    const trust = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), defaultProjectTrust: pi.getSettings().defaultProjectTrust };
    return { cwd: ctx.cwd, projectTrusted: projectAgentsTrusted(trust) };
  };
  const agentsFor = (ctx: ExtensionContext) => discoverAgents(discoveryFor(ctx));

  pi.registerFlag("agent", {
    type: "string",
    description: "Start as the named agent, in a new session in the agent's home",
  });

  pi.registerCommand("agent", {
    description: "List agents, or start a new session as one: /agent <name> [prompt]",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null;
      const items = discoverAgents(lookup)
        .agents.filter((agent) => agent.definition.name.startsWith(prefix))
        .map((agent) => ({ value: agent.definition.name, label: agent.definition.name, description: agent.definition.description }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const name = trimmed.split(/\s+/, 1)[0] ?? "";
      if (!name) return listAgents(ctx);

      const pending = startup?.begun && startup.name === name && !startup.next ? startup : undefined;
      const typed = trimmed.slice(name.length).trim();
      const prompt = pending ? pending.prompt : typed ? { text: typed } : undefined;
      try {
        const next = await startAgentSession(ctx, name, prompt, (replaced) => {
          if (pending) pending.next = replaced;
        });
        if (!next && pending) failStartup(ctx, pending);
      } catch (error) {
        if (pending) failStartup(ctx, pending);
        throw error;
      } finally {
        pending?.finish();
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    lookup = discoveryFor(ctx);
    active = undefined;
    let marker = readAgentMarker(ctx.sessionManager.getBranch());
    // /new in an agent session keeps the agent's home as cwd and starts the agent's next session.
    if (!marker && event.reason === "new") {
      const previous = event.previousSessionFile;
      marker = previous && existsSync(previous) ? readPreviousMarker(previous) : ownerMarker(ctx, agentsFor(ctx).agents);
      if (marker) pi.appendEntry(AGENT_ENTRY_TYPE, marker);
    }

    const requested = event.reason === "startup" ? flagValue(pi.getFlag("agent")) : undefined;
    if (marker) {
      if (requested && requested !== marker.name) {
        report(ctx, "warning", `This session belongs to agent "${marker.name}"; ignoring --agent ${requested}`);
      }
      active = await activate(ctx, marker);
    } else if (requested) {
      beginStartup(ctx, requested);
    }
    ctx.ui.setStatus(STATUS_KEY, active ? `agent: ${active.marker.name}` : undefined);
  });

  pi.on("session_shutdown", () => {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
  });

  pi.on("input", async (event, ctx) => {
    const pending = startup;
    if (!pending) return { action: "continue" };
    const prompt = { text: event.text, images: event.images };
    if (!pending.begun) {
      pending.prompt = prompt;
      switchAtStartup();
      await pending.done;
      // The prompt went to the agent's session, or nowhere when the agent could not start.
      return { action: "handled" };
    }
    // The prompt arrived during the switch; it belongs to the agent's session.
    await pending.done;
    const next = pending.next;
    if (next) {
      await next.sendUserMessage(content(prompt), { expandPromptTemplates: true, deliverAs: next.isIdle() ? undefined : "followUp" });
    } else if (pending.failed) {
      report(ctx, "error", `--agent ${pending.name} did not start; the prompt was not sent`);
    }
    return { action: "handled" };
  });

  pi.on("before_agent_start", (event) => {
    if (!active) return;
    if (active.file) event.systemPromptOptions.customPrompt = active.file.prompt;
    // Tools registered since the session started, such as MCP tools, follow the agent's policy too.
    applyTools(active);
  });

  // Declaring tools is not enough: codemode and tool_search reach tools that are not declared.
  pi.on("tool_call", (event) => {
    if (!active?.policy.restricted || active.policy.allows(event.toolName)) return;
    return { block: true, reason: `Agent "${active.marker.name}" is not allowed to use ${event.toolName}` };
  });

  async function startAgentSession(
    ctx: ExtensionCommandContext,
    name: string,
    prompt: Prompt | undefined,
    onSession: (next: ReplacedSessionContext) => void,
  ): Promise<ReplacedSessionContext | undefined> {
    const options = discoveryFor(ctx);
    const { agents } = discoverAgents(options);
    const agent = agents.find((candidate) => candidate.definition.name === name);
    if (!agent) {
      report(ctx, "error", `No agent named "${name}". ${untrustedHint(options, name) ?? available(agents)}`);
      return undefined;
    }

    const home = ensureAgentHome(name);
    const sessionFile = createAgentSessionFile({ name, file: agent.filePath, home }, agentSessionDir(ctx));
    // Claude Code prepends initialPrompt to the user's prompt and processes commands and skills in it.
    const first = joinPrompts(agent.definition.initialPrompt, prompt);
    let replaced: ReplacedSessionContext | undefined;
    const result = await ctx.switchSession(sessionFile, {
      withSession: async (next) => {
        replaced = next;
        onSession(next);
        if (!first) return;
        const sent = next.sendUserMessage(content(first), { expandPromptTemplates: true });
        // Print and JSON modes read the answer once the prompt that started the switch returns.
        if (!next.hasUI) return sent;
        sent.catch((error: unknown) => next.ui.notify(`Agent "${name}": ${error instanceof Error ? error.message : String(error)}`, "error"));
      },
    });
    return result.cancelled ? undefined : replaced;
  }

  async function activate(ctx: ExtensionContext, marker: AgentSessionMarker): Promise<ActiveAgent> {
    const file = loadMarkedAgent(marker, () => agentsFor(ctx).agents);
    const warn = (message: string) => report(ctx, "warning", `Agent "${marker.name}": ${message}`);
    if (!file) {
      const agent = { marker, policy: DENY_ALL };
      applyTools(agent);
      warn("its definition cannot be loaded, so its tools are disabled. Fix the definition and run /reload");
      return agent;
    }
    const { definition } = file;
    const policy = toolPolicy(definition);
    const agent = { marker, file, policy };
    applyTools(agent);
    policy.warnings.forEach(warn);
    const unmatched = unmatchedTools(definition, pi.getAllTools());
    if (unmatched.length > 0) warn(`no tool matches ${unmatched.map((entry) => `"${entry}"`).join(", ")}`);

    // A new agent session takes the agent's model; a resumed one keeps the model Pi restored.
    const fresh = !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
    if (fresh) {
      const choice = resolveAgentModel(definition, ctx.modelRegistry);
      if (choice.warning) warn(choice.warning);
      if (choice.model && !(await selectModel(ctx, choice.model))) {
        warn(`no credentials for ${choice.model.provider}/${choice.model.id}`);
      }
      if (choice.thinkingLevel) pi.setThinkingLevel(choice.thinkingLevel);
    }

    const ignored = UNSUPPORTED_FIELDS.filter((field) => definition[field] !== undefined);
    if (ignored.length > 0) warn(`Pi ignores ${ignored.join(", ")}`);
    return agent;
  }

  async function selectModel(ctx: ExtensionContext, model: Parameters<ExtensionAPI["setModel"]>[0]): Promise<boolean> {
    if (await pi.setModel(model)) return true;
    // setModel reads a credential snapshot Pi refreshes in the background, which may not yet
    // include a provider an extension registered for this session. Check the provider now.
    await ctx.modelRegistry.refresh({ providers: [model.provider], allowNetwork: false });
    return pi.setModel(model);
  }

  function applyTools({ file, policy }: ActiveAgent) {
    if (!policy.restricted) return;
    const current = pi.getActiveTools();
    const next = file ? activeTools(file.definition, policy, pi.getAllTools(), current) : [];
    if (next.length !== current.length || next.some((name, index) => name !== current[index])) pi.setActiveTools(next);
  }

  function beginStartup(ctx: ExtensionContext, name: string) {
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    startup = { name, begun: false, done, finish };
    // Interactive and RPC sessions switch right away; print and JSON modes wait for their prompt.
    if (ctx.mode === "tui" || ctx.mode === "rpc") startupTimer = setTimeout(switchAtStartup, 0);
  }

  function switchAtStartup() {
    if (!startup || startup.begun) return;
    startup.begun = true;
    // Only commands can replace the session, so the switch runs through /agent.
    pi.sendUserMessage(`/agent ${startup.name}`, { expandPromptTemplates: true });
  }

  function failStartup(ctx: ExtensionContext, pending: StartupSwitch) {
    // Interactive users see the error and go on in this session, which is plainly not the agent's.
    if (ctx.mode === "tui") {
      startup = undefined;
      return;
    }
    // Headless callers must not get answers from Pi's default agent instead of the one they named.
    pending.failed = true;
    if (!ctx.hasUI) process.exitCode = 1;
    if (pending.prompt) report(ctx, "error", `--agent ${pending.name}: the prompt was not sent`);
  }

  function listAgents(ctx: ExtensionContext) {
    const options = discoveryFor(ctx);
    const { agents, diagnostics } = discoverAgents(options);
    const lines = agents.map((agent) => `${agent.definition.name} (${agent.scope}): ${agent.definition.description}`);
    for (const diagnostic of diagnostics) lines.push(`${diagnostic.type}: ${diagnostic.path}: ${diagnostic.message}`);
    const hidden = options.projectTrusted ? 0 : discoverAgents({ ...options, projectTrusted: true }).agents.filter((a) => a.scope === "project").length;
    if (hidden > 0) lines.push(`${hidden} project agent(s) in .pi/agents load only in trusted projects; run /trust or pass --approve`);
    report(ctx, "info", lines.length > 0 ? lines.join("\n") : "No agents found. Add definitions to ~/.pi/agent/agents/ or .pi/agents/.");
  }
}

/** The user's session directory if it isn't Pi's default, which is per cwd; a scratch directory if Pi keeps no sessions. */
function agentSessionDir(ctx: ExtensionContext): string | undefined {
  if (!ctx.sessionManager.getSessionFile()) return scratchSessionDir();
  const current = ctx.sessionManager.getSessionDir();
  return current === defaultSessionDir(ctx.cwd) ? undefined : current;
}

/** The marked definition file, or the agent of that name if the file moved. */
function loadMarkedAgent(marker: AgentSessionMarker, discover: () => readonly DiscoveredAgent[]): AgentFile | undefined {
  try {
    const file = loadAgentDefinition(marker.file);
    if (file?.definition.name === marker.name) return file;
  } catch (error) {
    if (!(error instanceof AgentDefinitionError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return discover().find((agent) => agent.definition.name === marker.name);
}

function readPreviousMarker(sessionFile: string): AgentSessionMarker | undefined {
  try {
    return readAgentMarker(SessionManager.open(sessionFile).getBranch());
  } catch {
    return undefined;
  }
}

/** Pi writes a session only once it has a message, so a second /new finds no previous file; the home names the agent. */
function ownerMarker(ctx: ExtensionContext, agents: readonly DiscoveredAgent[]): AgentSessionMarker | undefined {
  const name = homeOwner(ctx.cwd);
  const agent = agents.find((candidate) => candidate.definition.name === name);
  return agent && name ? { name, file: agent.filePath, home: ctx.cwd } : undefined;
}

/** Explains a missing agent that an untrusted project defines. */
function untrustedHint(options: DiscoverAgentsOptions, name: string): string | undefined {
  if (options.projectTrusted) return undefined;
  const hidden = discoverAgents({ ...options, projectTrusted: true }).agents.find(
    (agent) => agent.scope === "project" && agent.definition.name === name,
  );
  return hidden && `${hidden.filePath} defines it, but project agents load only in trusted projects; run /trust or pass --approve.`;
}

function joinPrompts(initialPrompt: string | undefined, prompt: Prompt | undefined): Prompt | undefined {
  const text = [initialPrompt?.trim(), prompt?.text].filter(Boolean).join("\n\n");
  if (!text && !prompt?.images?.length) return undefined;
  return { text, images: prompt?.images };
}

function content(prompt: Prompt): string | (TextContent | ImageContent)[] {
  if (!prompt.images?.length) return prompt.text;
  return [{ type: "text", text: prompt.text }, ...prompt.images];
}

function available(agents: readonly DiscoveredAgent[]): string {
  if (agents.length === 0) return "No agents are defined.";
  return `Available: ${agents.map((agent) => agent.definition.name).join(", ")}`;
}

function flagValue(value: boolean | string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function report(ctx: ExtensionContext, type: "info" | "warning" | "error", message: string) {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.error(type === "info" ? message : `pi-agent ${type}: ${message}`);
}
