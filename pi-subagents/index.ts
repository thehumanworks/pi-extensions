import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LeadBridge } from "./src/bridge.ts";
import { Board } from "./src/board.ts";
import { delegateParameters, resolveWorkerConfig, scopedModelChoices } from "./src/delegation.ts";
import { Scheduler } from "./src/scheduler.ts";
import { runWorker } from "./src/worker.ts";

const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  details: {},
});
const noticeType = "pi-subagents-update";
const commandDescription =
  "Show worker states or set limits: /subagents limits <max-concurrency> <max-depth>";
const busyRetryMs = 50;
const dispatchRetryMs = 1000;

function noticesFor(jobs: ReturnType<Board["summaries"]>, recorded: Set<string>) {
  return jobs.flatMap((j) => {
    if (!(
      j.state === "failed" ||
      j.state === "blocked" ||
      (j.state === "done" && (!j.parent || j.notifyLead))
    ))
      return [];
    const key = j.id + ":" + j.revision;
    if (recorded.has(key)) return [];
    return [
      {
        customType: noticeType,
        content:
          "Worker " +
          j.id +
          " " +
          j.state +
          ": " +
          j.note.slice(0, 1200) +
          "\nUse subagent_status for the full record.",
        display: true,
        details: { key },
      },
    ];
  });
}

export default function (pi: ExtensionAPI) {
  let scheduler: Scheduler | undefined;
  const recorded = new Set<string>();
  let pending: ReturnType<typeof noticesFor> = [];
  let inFlight: string | undefined;
  let noticeWake: NodeJS.Timeout | undefined;
  let noticeDispatch: { command: string; args: string; retryMs: number } | undefined;
  let passive = false;
  let closing = false;
  const bridge = new LeadBridge(pi);
  function directory(ctx: ExtensionContext) {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Subagents require a persistent lead session (not --no-session).");
    return join(getAgentDir(), "subagents", createHash("sha256").update(file).digest("hex"));
  }
  function readReceipts(ctx: ExtensionContext) {
    // A requested turn is not a receipt. Only entries on the active branch count.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom_message" || entry.customType !== noticeType) continue;
      const key = (entry.details as { key?: string } | undefined)?.key;
      if (key) recorded.add(key);
    }
    pending = pending.filter((m) => !recorded.has(m.details.key));
    if (inFlight && recorded.has(inFlight)) inFlight = undefined;
  }
  function cancelNoticeWake() {
    clearTimeout(noticeWake);
    noticeWake = undefined;
  }
  function wakeNotices(ctx: ExtensionContext, delay = 0) {
    if (closing || noticeWake || (!pending.length && !inFlight && !noticeDispatch)) return;
    noticeWake = setTimeout(() => {
      noticeWake = undefined;
      flushNotices(ctx);
    }, delay);
  }
  function flushNotices(ctx: ExtensionContext) {
    if (closing || (!pending.length && !inFlight && !noticeDispatch)) return;
    if (!ctx.isIdle()) {
      // Tree navigation can be cancelled without emitting another event.
      wakeNotices(ctx, busyRetryMs);
      return;
    }
    readReceipts(ctx);
    if (!pending.length || passive || inFlight) {
      // A start that returned to idle without a receipt failed. Keep the
      // result, but do not repeatedly start a model turn for it.
      noticeDispatch = undefined;
      inFlight = undefined;
      if (pending.length) deliver(ctx, false);
      return;
    }
    if (!noticeDispatch) {
      // isIdle() can be true inside another extension's agent_settled hook.
      // Defer a guarded command rather than a turn that would survive an abort.
      const commands = pi
        .getCommands()
        .filter(
          (c) =>
            c.source === "extension" &&
            /^subagents(?::\d+)?$/.test(c.name) &&
            c.description === commandDescription,
        );
      if (commands.length !== 1) {
        deliver(ctx, false);
        return;
      }
      noticeDispatch = {
        command: commands[0]!.name,
        args: "deliver-notices " + randomUUID(),
        retryMs: dispatchRetryMs,
      };
    }
    // A preceding deferred action may fail and drop the command. Retry the
    // SAME token: a slow but healthy hook is never mistaken for a lost notice.
    const ticket = noticeDispatch;
    pi.sendUserMessage(`/${ticket.command} ${ticket.args}`, { expandPromptTemplates: true });
    if (noticeDispatch === ticket) {
      wakeNotices(ctx, ticket.retryMs);
      ticket.retryMs = Math.min(ticket.retryMs * 2, 30000);
    }
  }
  function deliver(ctx: ExtensionContext, triggerTurn: boolean) {
    if (closing) return;
    if (!ctx.isIdle()) {
      wakeNotices(ctx, busyRetryMs);
      return;
    }
    readReceipts(ctx);
    // Batch notices into one lead turn, or append them all after an abort.
    for (const [i, message] of pending.entries()) {
      if (closing || !ctx.isIdle()) break;
      const trigger = triggerTurn && !passive && i === pending.length - 1;
      if (trigger) inFlight = message.details.key;
      pi.sendMessage(message, { triggerTurn: trigger });
    }
    readReceipts(ctx);
    wakeNotices(ctx, busyRetryMs);
  }
  function open(ctx: ExtensionContext) {
    if (scheduler) return scheduler;
    const board = new Board(directory(ctx));
    const update = () => {
      const jobs = board.summaries();
      const counts = jobs.reduce<Record<string, number>>((c, j) => {
        c[j.state] = (c[j.state] ?? 0) + 1;
        return c;
      }, {});
      ctx.ui.setStatus(
        "pi-subagents",
        "Workers: " +
          Object.entries(counts)
            .map(([k, v]) => v + " " + k)
            .join(", "),
      );
      pending = noticesFor(jobs, recorded);
      // A later settlement hook can finish as soon as the footer reports done.
      // Register our deferred action in this same callback, not on a timer.
      if (!noticeDispatch) flushNotices(ctx);
    };
    scheduler = new Scheduler(
      board,
      (j, s) => runWorker(pi, ctx, board, j, s, bridge),
      update,
      (e) => ctx.ui.notify("Subagent board: " + String(e), "error"),
    );
    scheduler.wake();
    return scheduler;
  }
  pi.on("session_start", (_e, ctx) => {
    cancelNoticeWake();
    recorded.clear();
    closing = passive = false;
    pending = [];
    inFlight = noticeDispatch = undefined;
    if (ctx.sessionManager.getSessionFile() && existsSync(join(directory(ctx), "board.sqlite"))) open(ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    passive = event.aborted;
    // Print mode can exit as soon as the settling prompt returns. Register
    // delivery now so Pi waits for it, not on the next timer tick.
    if (scheduler) pending = noticesFor(scheduler.board.summaries(), recorded);
    cancelNoticeWake();
    flushNotices(ctx);
  });
  pi.on("session_before_tree", (_event, ctx) => {
    // A user navigating to an earlier message is not requesting old notices
    // again. Remember receipts on the outgoing branch before Pi changes it.
    if (scheduler) readReceipts(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    const models = scopedModelChoices(ctx.scopedModels ?? []);
    const jobs = scheduler?.board.summaries() ?? [];
    const active = jobs.filter((j) => j.state !== "done" && j.state !== "failed");
    const status = active
      .slice(0, 12)
      .map((j) => j.id + " " + j.state)
      .join(", ");
    return {
      systemPrompt:
        event.systemPrompt +
        "\nSubagents inherit this session's tools except subagent management. Include necessary context when delegating. Wait for completion or blocker messages instead of polling." +
        (models ? "\nScoped worker models: " + models : "") +
        (status ? "\nWorker board (" + active.length + " unfinished): " + status : ""),
    };
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    // The board commit can precede the scheduler's next status callback.
    // If Pi is already exiting, save the receipt without starting a turn.
    if (scheduler && ctx.isIdle()) {
      pending = noticesFor(scheduler.board.summaries(), recorded);
      deliver(ctx, false);
    }
    closing = true;
    cancelNoticeWake();
    inFlight = noticeDispatch = undefined;
    pending = [];
    await scheduler?.close();
    scheduler = undefined;
    ctx.ui.setStatus("pi-subagents", undefined);
  });
  pi.registerTool({
    name: "subagent_delegate",
    label: "Delegate",
    description:
      "Queue an independent assignment and return immediately. Give all needed context. You receive completion and blocker messages; do not poll.",
    parameters: delegateParameters,
    prepareLoadout: (loadout) => bridge.capture(loadout),
    async execute(_id, params, _s, _u, ctx) {
      if (bridge.bind(params, ctx)) return reply("");
      const config = resolveWorkerConfig(params, ctx, pi.getSettings());
      const s = open(ctx);
      const j = s.board.add(params.task, config);
      s.wake();
      return reply({ id: j.id, state: j.state });
    },
  });
  pi.registerTool({
    name: "subagent_status",
    label: "Worker status",
    description: "List task states or read a worker's full result or blocker by id.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, { id }, _s, _u, ctx) {
      const b = open(ctx).board;
      if (!id) return reply(b.summaries());
      const { history: _history, entries: _entries, ...record } = b.get(id);
      return reply(record);
    },
  });
  pi.registerTool({
    name: "subagent_resume",
    label: "Resume worker",
    description:
      "Answer a blocker or retry a failed worker. If effects are uncertain, inspect first; supply verified state and instructions.",
    parameters: Type.Object({ id: Type.String(), input: Type.String({ minLength: 1 }) }),
    async execute(_id, { id, input }, _s, _u, ctx) {
      const s = open(ctx);
      s.board.resume(id, input);
      s.wake();
      return reply({ id, state: "queued" });
    },
  });
  pi.registerCommand("subagents", {
    description: commandDescription,
    handler: async (args, ctx) => {
      if (args.startsWith("deliver-notices ")) {
        if (args === noticeDispatch?.args) {
          noticeDispatch = undefined;
          cancelNoticeWake();
          deliver(ctx, true);
          // Pi awaits the command before it drains later deferred prompts, but
          // pi.sendMessage itself returns void. Hold this command until the turn
          // is no longer busy so those prompts are not rejected as concurrent.
          if (!closing && !ctx.isIdle()) {
            await ctx.waitForIdle();
            // Embedders need not bind waitForIdle (the SDK default is a no-op).
            while (!closing && !ctx.isIdle())
              await new Promise<void>((resolve) => setTimeout(resolve, busyRetryMs));
          }
        }
        return;
      }
      const s = open(ctx);
      if (args.trim()) {
        const m = /^limits\s+(\d+)\s+(\d+)$/.exec(args.trim());
        if (!m) throw new Error("Usage: /subagents limits <max-concurrency> <max-depth>");
        s.board.configure({ concurrency: Number(m[1]), depth: Number(m[2]) });
        s.wake();
      }
      ctx.ui.notify(
        [
          JSON.stringify(s.board.limits()),
          ...s.board.summaries().map((j) => j.state + " " + j.id + " " + j.task),
        ].join("\n"),
        "info",
      );
    },
  });
}
