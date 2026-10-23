import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureWorker, requestWorker, rpc } from "./dist/client.js";
import { loopPaths } from "./dist/paths.js";
import { intervalMs, parseLoop, type Request } from "./dist/protocol.js";

const HELP = `/loop <frequency> <task> — e.g. /loop 5m check whether the build passed
/loop list | show <id> | pause <id> | resume <id> | delete <id>
/loop start | stop — start/recover or stop the host worker (schedules remain stored)
Intervals: 30s, 5m, 2h, 1d, 1w. First run is after one interval.
Runs continue after Pi exits, with host file and shell access.`;

export default function loop(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await access(loopPaths().database);
    } catch { return; }
    try { await ensureWorker(); }
    catch (error) { ctx.ui.notify(`Loop recovery failed: ${String(error)}`, "warning"); }
  });

  pi.registerTool({
    name: "loop",
    label: "Loop",
    description: `Create and manage durable recurring Pi runs on this host. Create ONLY when the user requests a recurring task.
For create, convert the user's frequency to an interval (e.g. 5m) and rewrite only for clarity as a self-contained executable prompt.
Preserve the exact goal, constraints and scope. Do NOT invent notifications, fixes, extra checks, files, deadlines or success criteria.
Resolve references only from established conversation facts; ask if the goal or frequency is ambiguous.
Do not execute the task now. The first run occurs after one interval. Each run has a fresh conversation, saved cwd/model,
and read/write/edit/bash tools, NOT this session's history, extensions, MCP tools or permission hooks.
The worker outlives Pi; pause/delete aborts an in-flight run. list/show expose recent results and durable task state.`,
    parameters: Type.Object({
      action: Type.Union(["create", "list", "show", "pause", "resume", "delete"].map(value => Type.Literal(value))),
      frequency: Type.Optional(Type.String({ description: "For create: interval such as 5m, 2h, 1d." })),
      prompt: Type.Optional(Type.String({ description: "For create: self-contained task, tidied without any added scope." })),
      id: Type.Optional(Type.String({ description: "Schedule ID for show/pause/resume/delete." })),
    }),
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      let request: Request;
      if (args.action === "create") {
        if (!args.frequency || !args.prompt?.trim()) throw new Error("create requires frequency and prompt.");
        intervalMs(args.frequency);
        if (!ctx.model) throw new Error("Select a model before creating a loop.");
        if (ctx.hasUI) {
          const allowed = await ctx.ui.confirm(
            `Schedule every ${args.frequency} in ${ctx.cwd}?`,
            `${args.prompt}\n\nRuns unattended with shell/file access after this Pi session closes.\nModel: ${ctx.model.provider}/${ctx.model.id}`,
          );
          if (!allowed) throw new Error("Schedule creation cancelled.");
        } else if (process.env.PI_LOOP_ALLOW_UNATTENDED !== "1") {
          throw new Error("Creating persistent jobs without a confirmation UI requires PI_LOOP_ALLOW_UNATTENDED=1.");
        }
        request = {
          action: "create", requestId: `${ctx.sessionManager.getSessionId()}:${toolCallId}`,
          frequency: args.frequency, prompt: args.prompt, cwd: ctx.cwd,
          model: { provider: ctx.model.provider, modelId: ctx.model.id },
          thinkingLevel: pi.getThinkingLevel(),
        };
      } else if (args.action === "list") {
        request = { action: "list" };
      } else {
        if (!args.id) throw new Error(`${args.action} requires a schedule ID.`);
        request = { action: args.action, id: args.id };
      }
      // Once admitted by the worker, creation is durable even if this UI disconnects.
      signal?.throwIfAborted();
      const result = await requestWorker(request);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerCommand("loop", {
    description: "Schedule recurring host-side Pi runs, or list/show/pause/resume/delete them",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text || text === "help") { ctx.ui.notify(HELP, "info"); return; }
      try {
        const [action, id, ...rest] = text.split(/\s+/);
        if (action === "start") {
          if (id) throw new Error("Usage: /loop start");
          await ensureWorker();
          ctx.ui.notify("Loop worker started; durable jobs resumed.", "info");
        } else if (action === "stop") {
          if (id) throw new Error("Usage: /loop stop");
          await rpc({ action: "stop" });
          ctx.ui.notify("Loop worker stopping. Jobs remain stored; /loop start resumes them.", "info");
        } else if (["list", "show", "pause", "resume", "delete"].includes(action)) {
          if (rest.length || (action === "list" ? !!id : !id)) throw new Error(`Usage: /loop ${action}${action === "list" ? "" : " <id>"}`);
          const request = action === "list" ? { action: "list" } as const : { action, id } as Request;
          const result = await requestWorker(request);
          pi.sendMessage({ customType: "loop", content: JSON.stringify(result, null, 2), display: true, details: result });
        } else {
          const parsed = parseLoop(text);
          // Keep this request in the user's conversation; the model may resolve explicit references
          // before creating the fresh, standalone scheduled prompt.
          pi.sendUserMessage(
            `Create ONE recurring schedule using the loop tool. Do not perform the task now.\n` +
            `Frequency: ${parsed.frequency}\nUser task (quoted JSON): ${JSON.stringify(parsed.task)}\n` +
            `Tidy the task into a self-contained prompt without adding any requirements or scope. Preserve the goal and constraints. ` +
            `If clarification is necessary, ask instead of guessing. Show the saved schedule ID, interval and exact prompt afterwards.\n` +
            `Request marker: ${randomUUID()}`,
            { deliverAs: "followUp", expandPromptTemplates: false },
          );
        }
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
