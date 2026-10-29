import type { AccountInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError, type UsageSnapshot } from "../types.ts";
import { normalizeClaudeUsage } from "./claude-normalize.ts";

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
export const CLAUDE_CODE_LOGIN_HINT = "Sign in with Claude Code (claude auth login), then retry /usage claude.";
type UsageSession = Pick<Query, "accountInfo" | typeof USAGE_METHOD | "close">;
export type StartUsageSession = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => UsageSession;

/** Inspect the subscription, not API billing or a gateway. Preserve Code's
 * CLAUDE_CONFIG_DIR and explicit OAuth token; never substitute another account. */
export function claudeUsageEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  for (const key of Object.keys(child)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_")) delete child[key];
  }
  return { ...child, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
}

/** Keep stdin open for SDK control requests without ever submitting a prompt. */
async function* noPrompts(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export async function fetchClaudeCodeUsage(signal: AbortSignal, options: {
  start?: StartUsageSession;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
} = {}): Promise<UsageSnapshot> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let session: UsageSession | undefined;
  let cwd: string | undefined;
  let closed = false;
  const stop = () => {
    controller.abort();
    if (session && !closed) {
      closed = true;
      try { session.close(); } catch { /* No raw SDK errors in logs/UI. */ }
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    // Root entry inlines its runtime dependencies. /core needs extra MCP peers.
    // Pin this SDK version because the structured usage method is experimental.
    const start: StartUsageSession = options.start ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
    signal.throwIfAborted();
    cwd = await mkdtemp(join(tmpdir(), "pi-usage-claude-"));
    signal.throwIfAborted();
    session = start({
      prompt: noPrompts(controller.signal),
      options: {
        cwd,
        env: claudeUsageEnvironment(options.env ?? process.env),
        abortController: controller,
        persistSession: false,
        settingSources: [],
        settings: { disableAllHooks: true, autoMemoryEnabled: false },
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        stderr: () => {},
      },
    });
    const account: AccountInfo = await session.accountInfo();
    signal.throwIfAborted();
    if (account.apiProvider && account.apiProvider !== "firstParty") {
      throw new UsageError(`Claude Code is not using a Claude subscription. ${CLAUDE_CODE_LOGIN_HINT}`, "unavailable");
    }
    const report = await session[USAGE_METHOD]({ skipBehaviors: true });
    signal.throwIfAborted();
    if (!report.rate_limits_available) {
      throw new UsageError(`Claude subscription usage needs a login with profile access, not an API key or inference-only setup token. ${CLAUDE_CODE_LOGIN_HINT}`, "unavailable");
    }
    if (!report.rate_limits) {
      throw new UsageError("Claude Code could not retrieve subscription limits. Check Claude Code /usage and try again later.");
    }
    return normalizeClaudeUsage(report.rate_limits, {
      account: account.email || "Claude Code subscription (identity not reported)",
      plan: report.subscription_type ?? account.subscriptionType,
      source: "Claude Code login (Agent SDK; also used by pi-claude-bridge)",
    }, options.now?.() ?? Date.now());
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Could not read usage through the Claude Agent SDK. Ensure its optional platform package is installed. ${CLAUDE_CODE_LOGIN_HINT}`);
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
