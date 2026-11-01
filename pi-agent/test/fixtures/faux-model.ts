import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// A scripted model for tests that run the real Pi CLI. FAUX_SCRIPT is a JSON array of steps, one
// per model call: { "tool": name, "args": {...} } calls a tool, { "text": "..." } answers. Each
// call appends what the request held to FAUX_LOG as one JSON line. The step is the number of
// logged calls, so the script continues across the extension reloads a session switch causes.
//
// The fixture also registers `vault`, a tool reachable only from codemode, for tool-policy tests.

type Step = { tool: string; args?: Parameters<typeof fauxToolCall>[1] } | { text: string };

type Message = { role: string; content?: unknown; sections?: Record<string, string | null>; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };

export default function fauxModel(pi: ExtensionAPI) {
  const script: Step[] = JSON.parse(process.env.FAUX_SCRIPT ?? "[]");
  const log = process.env.FAUX_LOG;
  if (!log) throw new Error("FAUX_LOG is required");
  const faux = fauxProvider({ tokensPerSecond: 1_000_000, models: [{ id: "faux-1" }, { id: "faux-2", reasoning: true }] });
  const respond = (context: { messages: Message[] }, _options: unknown, _state: unknown, model: { id: string }) => {
    const index = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
    appendFileSync(log, `${JSON.stringify({ model: model.id, ...describe(context.messages) })}\n`);
    const step = script[index];
    if (!step) return fauxAssistantMessage(`unscripted call ${index}`);
    if ("text" in step) return fauxAssistantMessage(fauxText(step.text));
    return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 50 }, () => respond as never));
  pi.registerProvider(faux.provider as never);

  pi.registerTool({
    name: "vault",
    label: "Vault",
    description: "Returns a secret.",
    parameters: Type.Object({}),
    exposure: "codemode",
    execute: async () => ({ content: [{ type: "text", text: "vault-secret" }], details: {} }),
  });
}

/** The system prompt and tools the transcript's system messages add up to, and the last message's text. */
function describe(messages: Message[]) {
  let base = "";
  const sections: Record<string, string> = {};
  const tools = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const text = textOf(message.content);
    if (!base) base = text;
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete sections[name];
      else sections[name] = value;
    }
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  const last = messages.filter((message) => message.role !== "system").at(-1);
  return {
    system: [base, ...Object.values(sections)].join("\n\n"),
    tools: [...tools].sort(),
    last: last ? { role: last.role, text: textOf(last.content) } : undefined,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
}
