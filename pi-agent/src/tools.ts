import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { newDefinition } from "./definitions.ts";
import type { AgentStore } from "./store.ts";
import type { AgentRuntime } from "./runtime.ts";
import type { LoopStore, Schedule } from "./loops.ts";
import type { DraftWorkflow } from "./drafts.ts";

export interface Services { store: AgentStore; runtime: AgentRuntime; loops: LoopStore; drafts?: DraftWorkflow }
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data });
const actions = <T extends string[]>(...values: T) => Type.Union(values.map(v => Type.Literal(v)));
const required = (value: string | undefined, field: string) => { if (!value) throw new Error(`${field} is required.`); return value; };

export function registerAgentTools(pi: ExtensionAPI, services: Services, self?: string, chain: string[] = []): void {
  const { store, runtime, loops } = services;
  pi.registerTool({
    name: "agent_manage", label: "Agents",
    description: "List, show, create or propose edits to specialized agents. Definitions are Markdown with YAML frontmatter and a system-prompt body. Existing-definition edits ALWAYS await human /agent approve; there is no model approval or agent deletion action. Omitted tools/skills allow all; [] means none. Agents keep one home and persistent conversation.",
    parameters: Type.Object({
      action: actions("list", "show", "create", "edit"), name: Type.Optional(Type.String()),
      definition: Type.Optional(Type.String({ description: "Complete Markdown definition, preserving foreign frontmatter." })),
      description: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), home: Type.Optional(Type.String()),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const cwd = ctx.isProjectTrusted() ? ctx.cwd : undefined;
      if (args.action === "list") return result(await store.list(cwd));
      const name = required(args.name ?? self, "name");
      if ((args.action === "create" || args.action === "edit") && await services.drafts?.current()) {
        throw new Error("A creation review is open. Use agent_draft propose to iterate; only the human's /agent accept can create it.");
      }
      if (args.action === "create") {
        const source = args.definition ?? newDefinition(name, required(args.description, "description"), args.prompt ?? args.description!, args.home ?? join(store.homes, name));
        return result(await store.create(name, source));
      }
      await store.ensure(name, cwd);
      if (args.action === "show") return result({ definition: await store.source(name), pending: await store.candidate(name) });
      const candidate = await store.propose(name, required(args.definition, "definition"));
      return result({ status: "awaiting-human-approval", name, revision: candidate.revision, command: `/agent approve ${name}` });
    },
  });
  pi.registerTool({
    name: "agent_run", label: "Run agent",
    description: "Send a self-contained task to another agent through Pi's SDK. Runs in its permanent home and resumes its own native conversation, not this conversation. Include absolute paths for work elsewhere. Concurrent runs of the same agent fail busy; cycles are rejected. Cancellation cannot undo tool effects.",
    parameters: Type.Object({ name: Type.String(), task: Type.String({ minLength: 1 }) }),
    async execute(_id, args, signal, onUpdate, ctx) {
      const run = await runtime.run(args.name, args.task, {
        cwd: ctx.isProjectTrusted() ? ctx.cwd : undefined, signal, chain,
        onEvent: event => {
          if (event.type === "tool_execution_start") onUpdate?.(result({ agent: args.name, tool: event.toolName }));
        },
      });
      const output = run.output.length > 24_000 ? run.output.slice(0, 24_000) + `\n[Truncated; full native transcript: ${run.sessionFile}]` : run.output;
      return { ...result({ ...run, output }), usage: run.usage };
    },
  });
  pi.registerTool({
    name: "agent_loop", label: "Agent loops",
    description: "List, schedule, pause, resume or remove recurring agent tasks. Runs autonomously in the agent's home while a Pi process with pi-agent is running. Uses native history. Missed ticks coalesce; interrupted work is not replayed. Removing a loop does NOT delete an agent.",
    parameters: Type.Object({
      action: actions("list", "put", "pause", "resume", "remove"), agent: Type.Optional(Type.String()), name: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()), everyMs: Type.Optional(Type.Integer({ minimum: 1000 })),
      cron: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (args.action === "list") return result((await loops.list()).filter(l => !args.agent || l.agent === args.agent));
      const agent = required(args.agent ?? self, "agent");
      const name = required(args.name, "name");
      await store.ensure(agent, ctx.isProjectTrusted() ? ctx.cwd : undefined);
      if (args.action === "put") {
        if ((args.everyMs === undefined) === (args.cron === undefined)) throw new Error("Specify exactly one of everyMs or cron.");
        if (args.everyMs !== undefined && args.timezone !== undefined) throw new Error("timezone applies only to cron schedules.");
        const schedule: Schedule = args.everyMs !== undefined ? { everyMs: args.everyMs } : { cron: args.cron!, timezone: args.timezone };
        return result(await loops.put(agent, name, required(args.task, "task"), schedule));
      }
      if (args.action === "remove") await loops.remove(agent, name);
      else await loops.setEnabled(agent, name, args.action === "resume");
      return result({ agent, name, action: args.action });
    },
  });
}
