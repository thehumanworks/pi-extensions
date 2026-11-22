import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LeadBridge } from "./src/bridge.ts";
import { Board } from "./src/board.ts";
import { Scheduler } from "./src/scheduler.ts";
import { runWorker } from "./src/worker.ts";

const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  details: {},
});
const noticeType = "pi-subagents-update";

export default function (pi: ExtensionAPI) {
  let scheduler: Scheduler | undefined;
  const sent = new Set<string>();
  const bridge = new LeadBridge(pi);
  function directory(ctx: ExtensionContext) {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Subagents require a persistent lead session (not --no-session).");
    return join(getAgentDir(), "subagents", createHash("sha256").update(file).digest("hex"));
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
      for (const j of jobs) {
        if (!(j.state === "failed" || j.state === "blocked" || (j.state === "done" && !j.parent))) continue;
        const key = j.id + ":" + j.revision;
        if (sent.has(key)) continue;
        pi.sendMessage(
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
          { triggerTurn: true, deliverAs: "followUp" },
        );
        sent.add(key);
      }
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
    sent.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom_message" && entry.customType === noticeType) {
        const details = entry.details as { key?: string } | undefined;
        if (details?.key) sent.add(details.key);
      }
    }
    if (ctx.sessionManager.getSessionFile() && existsSync(join(directory(ctx), "board.sqlite"))) open(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
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
        (status ? "\nWorker board (" + active.length + " unfinished): " + status : ""),
    };
  });
  pi.on("session_shutdown", async (_e, ctx) => {
    await scheduler?.close();
    scheduler = undefined;
    ctx.ui.setStatus("pi-subagents", undefined);
  });
  pi.registerTool({
    name: "subagent_delegate",
    label: "Delegate",
    description:
      "Queue an independent assignment and return immediately. Give all needed context. You receive completion and blocker messages; do not poll.",
    parameters: Type.Object({ task: Type.String({ minLength: 1 }) }),
    prepareLoadout: (loadout) => bridge.capture(loadout),
    async execute(_id, params, _s, _u, ctx) {
      if (bridge.bind(params, ctx)) return reply("");
      const { task } = params;
      if (!ctx.model) throw new Error("Select a Pi model first.");
      const s = open(ctx);
      const j = s.board.add(task, ctx.model.provider, ctx.model.id);
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
    description: "Show worker states or set limits: /subagents limits <max-concurrency> <max-depth>",
    handler: async (args, ctx) => {
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
