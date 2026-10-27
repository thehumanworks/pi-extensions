// Leader–worker: one planner decomposes the task, workers execute in parallel, a reviewer verifies.
// Shape: agent → parallel(agents) → agent. The deterministic script holds the plan; agents do the thinking.
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

const PLAN = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.String(),
      title: Type.String(),
      instructions: Type.String({ description: "Self-contained instructions for one worker" }),
      files: Type.Array(Type.String()),
    }),
  ),
});

const REVIEW = Type.Object({
  approved: Type.Boolean(),
  issues: Type.Array(Type.Object({ taskId: Type.String(), problem: Type.String() })),
});

export default defineWorkflow({
  name: "leader-worker",
  description: "Plan a change, implement it with parallel workers in isolated worktrees, review and report the branches without merging them. Use for a multi-file change that splits into independent parts; pass { goal }.",
  args: Type.Object({ goal: Type.String(), maxWorkers: Type.Optional(Type.Integer({ minimum: 1, default: 4 })) }),
  agents: {
    leader: { thinkingLevel: "high", tools: ["read", "bash"] },
    worker: { isolation: "worktree", retries: 2 },
    reviewer: { tools: ["read", "bash"], instructions: "You only read and run tests; never edit files." },
  },
  budget: { maxAgents: 20, maxCostUsd: 5 },

  run: async (ctx) => {
    ctx.phase("Plan");
    const plan = await ctx.agent(
      `Decompose this goal into at most ${ctx.args.maxWorkers ?? 4} independent tasks that touch disjoint files:\n${ctx.args.goal}`,
      { agentType: "leader", label: "plan", schema: PLAN },
    );

    ctx.phase("Implement");
    const outcomes = await ctx.parallel(
      plan.tasks.map((task, index) => () =>
        ctx.agent(`${task.instructions}\n\nOnly touch: ${task.files.join(", ")}. Run the relevant tests before you finish.`, {
          agentType: "worker",
          label: `worker-${index}`,
          phase: "Implement",
        }),
      ),
      // "null" (the default) records a failed worker as null and lets the others finish; status lists the failure.
      { failure: "null" },
    );

    // Worktree branches are deterministic: orch/<runId>/<label>, so the reviewer can be pointed at them by name.
    const done = outcomes.flatMap((summary, i) =>
      summary ? [{ task: plan.tasks[i], branch: `orch/${ctx.runId}/worker-${i}`, summary }] : [],
    );
    ctx.log(`${done.length}/${plan.tasks.length} workers finished`);

    ctx.phase("Review");
    const review = await ctx.agent(
      `Review these branches for the goal "${ctx.args.goal}". For each, check out the branch in a temporary worktree, run tests, and report.\n` +
        JSON.stringify(done, null, 2),
      { agentType: "reviewer", label: "review", schema: REVIEW },
    );

    return { plan, done, review };
  },
});
