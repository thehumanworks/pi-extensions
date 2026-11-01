import { createAgentSession, DefaultResourceLoader, getAgentDir, type ModelRuntime, SessionManager } from "pi-workflow-runtime";
import type { ThinkingLevel } from "../index.ts";
import { WorkflowError } from "../errors.ts";

/** One agent run as a full pi coding-agent session: pi's tools, the user's extensions, MCP servers, skills and context files. */
export interface PiSessionRequest {
  runId: string;
  key: string;
  label?: string;
  prompt: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  /** Appended to pi's system prompt. */
  instructions?: string;
  /** pi's --tools allowlist; undefined means every tool. */
  tools?: string[];
  /** pi's --exclude-tools denylist. */
  excludeTools?: string[];
  timeoutMs: number;
  signal: AbortSignal;
  log(message: string): void;
}

export interface PiSessionResult {
  /** The last assistant message's text. */
  output: string;
  /** pi session transcript; open with `pi --session <file>`. */
  sessionFile?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export type PiSessionRunner = (request: PiSessionRequest) => Promise<PiSessionResult>;

export interface PiSessionRunnerOptions {
  /** Load no extensions, skills, prompt templates, themes or context files, and keep the transcript in memory. For tests. */
  isolated?: boolean;
}

/** The default runner: `createAgentSession` from the pi coding agent, in this worker process. */
export function createPiSessionRunner(modelRuntime: ModelRuntime, options: PiSessionRunnerOptions = {}): PiSessionRunner {
  return async request => {
    const model = modelRuntime.getModel(request.model.provider, request.model.modelId);
    if (!model) throw new WorkflowError("unknown_model", `Worker cannot resolve model ${request.model.provider}/${request.model.modelId}.`, request.key);
    const context = `You are the agent for step ${request.key}${request.label ? ` (${request.label})` : ""} of asx run ${request.runId}. ` +
      "Your final reply is consumed by a program or by the next stage: make it complete and self-contained. Do not start asx or workflow runs.";
    const loader = new DefaultResourceLoader({
      cwd: request.cwd, agentDir: getAgentDir(),
      appendSystemPrompt: [context, ...(request.instructions ? [request.instructions] : [])],
      ...(options.isolated ? { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } : {}),
    });
    await loader.reload();
    request.signal.throwIfAborted();
    const { session } = await createAgentSession({
      cwd: request.cwd, modelRuntime, model, thinkingLevel: request.thinkingLevel,
      tools: request.tools, excludeTools: request.excludeTools?.length ? request.excludeTools : undefined,
      sessionManager: options.isolated ? SessionManager.inMemory(request.cwd) : SessionManager.create(request.cwd),
      resourceLoader: loader,
    });
    let current = "";
    let output = "";
    const unsubscribe = session.subscribe(event => {
      switch (event.type) {
        case "message_start": if (event.message.role === "assistant") current = ""; break;
        case "message_update": if (event.assistantMessageEvent.type === "text_delta") current += event.assistantMessageEvent.delta; break;
        case "message_end": if (event.message.role === "assistant" && current) output = current; break;
        case "tool_execution_start": request.log(`tool ${event.toolName}`); break;
      }
    });
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    const onAbort = () => { void session.abort(); };
    signal.addEventListener("abort", onAbort, { once: true });
    let error: string | undefined;
    let stats: ReturnType<typeof session.getSessionStats>;
    const sessionFile = session.sessionFile;
    try {
      request.log(`pi session ${sessionFile ?? "(in memory)"} · ${request.model.provider}/${request.model.modelId}`);
      await session.prompt(request.prompt, { expandPromptTemplates: false });
      await session.agent.waitForIdle();
      error = session.agent.state.errorMessage;
      stats = session.getSessionStats();
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
    if (timeout.aborted) throw new WorkflowError("agent_timeout", `Agent ${request.key} exceeded timeoutMs=${request.timeoutMs}.`, request.key);
    request.signal.throwIfAborted();
    if (error) throw new WorkflowError("agent_failed", `Agent ${request.key} did not finish: ${error}`, request.key);
    return { output, sessionFile, usage: { inputTokens: stats.tokens.input, outputTokens: stats.tokens.output, costUsd: stats.cost } };
  };
}
