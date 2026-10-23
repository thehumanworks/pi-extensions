import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const ADVISOR_DESCRIPTION =
  "Use an advisor for difficult decisions. Format: <provider>/<modelId>, or off.";
const SYSTEM_PROMPT = `You are an independent advisor to another AI assistant. Analyze the supplied question and context, challenge assumptions, identify risks and alternatives, and give a concise, actionable recommendation. State uncertainty and missing information explicitly. You have no tools or access to the assistant's conversation or files beyond the supplied context. Do not claim to have inspected or verified anything you were not given. Your advice does not authorize actions or override the user's instructions.`;

function parseSelection(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("advisorModel must be a string in provider/modelId format, or off.");
  const selection = value.trim();
  if (selection === "off") return undefined;
  // Model IDs (notably OpenRouter's) can contain additional slashes.
  if (!/^[^/\s\p{Cc}]+\/[^\s\p{Cc}]+$/u.test(selection) || selection.endsWith("/")) {
    throw new Error("Invalid advisor model. Use <provider>/<modelId>, or off.");
  }
  return selection;
}

function resolveModel(selection: string, ctx: ExtensionContext) {
  const slash = selection.indexOf("/");
  const model = ctx.modelRegistry.find(selection.slice(0, slash), selection.slice(slash + 1));
  if (!model) throw new Error(`Advisor model not found: ${selection}. Configure it in Pi before selecting it.`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`No authentication configured for advisor ${selection}. Use /login or configure its provider credentials.`);
  }
  return model;
}

// Pi exposes settings reads but no arbitrary settings setter. Merge only our
// key, refuse malformed files, and replace atomically rather than truncating.
async function saveSelection(selection: string | undefined): Promise<void> {
  const directory = getAgentDir();
  const path = join(directory, "settings.json");
  await withFileMutationQueue(path, async () => {
    mkdirSync(directory, { recursive: true });
    // Use the same lock directory as Pi's settings writer. Do not remove an
    // existing lock, including a stale one: another process may own it.
    const lock = `${path}.lock`;
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("settings.json is locked by another writer; try again shortly.");
      }
      throw error;
    }
    // Keep the locked transaction synchronous and short (no network/await).
    try {
      let target = path;
      let exists = false;
      try {
        lstatSync(path);
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Follow existing symlinks, and fail rather than replacing dangling ones.
      if (exists) target = realpathSync(path);
      const mode = exists ? statSync(target).mode & 0o777 : 0o600;
      const parsed: unknown = exists ? JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, "")) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("settings.json must contain a JSON object");
      }
      const temporary = join(dirname(target), `.advisor-settings-${randomUUID()}.tmp`);
      let created = false;
      try {
        writeFileSync(temporary, `${JSON.stringify({ ...parsed, advisorModel: selection ?? "off" }, null, 2)}\n`, { flag: "wx", mode });
        created = true;
        chmodSync(temporary, mode);
        renameSync(temporary, target);
        created = false;
      } finally {
        if (created) unlinkSync(temporary);
      }
    } finally {
      rmdirSync(lock);
    }
  });
}

export default function (pi: ExtensionAPI) {
  let selection: string | undefined;
  let configurationError: string | undefined;
  // Commands override startup sources for this runtime, including new sessions.
  let commandOverride: string | undefined;

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };
  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") {
      ctx.ui.setStatus("advisor", configurationError ? "Advisor: configuration error" : selection ? `Advisor: ${selection} (enabled)` : undefined);
    }
  };

  // Always register, even when unconfigured, so /advisor and --advisor work.
  pi.registerFlag("advisor", { description: ADVISOR_DESCRIPTION, type: "string" });
  pi.on("session_start", (_event, ctx) => {
    selection = undefined;
    configurationError = undefined;
    try {
      const settings = pi.getSettings() as { advisorModel?: unknown };
      selection = parseSelection(commandOverride ?? pi.getFlag("advisor") ?? process.env.PI_ADVISOR_MODEL ?? settings.advisorModel);
      if (selection) resolveModel(selection, ctx);
    } catch (error) {
      configurationError = error instanceof Error ? error.message : String(error);
      notify(ctx, configurationError, "error");
    }
    updateStatus(ctx);
  });

  pi.registerCommand("advisor", {
    description: `${ADVISOR_DESCRIPTION} /advisor [provider/modelId | off | status]. Saves the user default.`,
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value || value === "status") {
        notify(ctx, configurationError ?? (selection ? `Advisor enabled: ${selection}` : "Advisor is off."), configurationError ? "error" : "info");
        return;
      }
      try {
        const next = parseSelection(value);
        if (next) resolveModel(next, ctx);
        await saveSelection(next);
        commandOverride = next ?? "off";
        selection = next;
        configurationError = undefined;
        updateStatus(ctx);
        notify(ctx, `${next ? `Advisor enabled: ${next}.` : "Advisor is off."} Saved advisorModel in ${join(getAgentDir(), "settings.json")}. Startup flags, environment variables, and project settings can override this default after reload.`);
      } catch (error) {
        notify(ctx, `Could not set advisor: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "ask_advisor",
    label: "Ask advisor",
    description: "Ask the configured advisor for a second opinion on a complex task or a decision where confidence is low. Supply a self-contained question and any relevant context; the advisor cannot see this conversation or use tools. Sends supplied text to the configured model provider. Requires --advisor, PI_ADVISOR_MODEL, settings.advisorModel, or /advisor.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 16000, description: "The question or decision to evaluate." }),
      context: Type.Optional(Type.String({ maxLength: 48000, description: "Relevant facts, constraints, code, alternatives, and your proposed approach. Omit secrets." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!params.question.trim()) throw new Error("Advisor question must not be empty.");
      if (configurationError) throw new Error(configurationError);
      if (!selection) throw new Error("No advisor configured. Use /advisor <provider>/<modelId> or --advisor <provider>/<modelId>.");
      // Snapshot the selection: changing it during a request affects future calls.
      const selected = selection;
      const model = resolveModel(selected, ctx);
      const response = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `Question:\n${params.question.trim()}${params.context ? `\n\nContext:\n${params.context}` : ""}`,
          timestamp: Date.now(),
        }],
      }, {
        signal,
        maxTokens: Math.min(4096, model.maxTokens),
        reasoning: "medium",
        cacheRetention: "none",
        sessionId: randomUUID(),
      }).result();
      signal?.throwIfAborted();
      const advice = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
      const failed = response.stopReason !== "stop" || !advice;
      return {
        content: [{ type: "text", text: failed
          ? `Advisor ${selected} failed: ${response.errorMessage || `response ended with ${response.stopReason}${advice ? "" : " and no advice"}`}`
          : advice }],
        details: { model: selected, stopReason: response.stopReason },
        usage: response.usage,
        // Preserve usage even on provider errors or incomplete responses.
        ...(failed ? { isError: true } : {}),
      };
    },
  });
}
