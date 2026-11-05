// Leader–worker: one planner decomposes the task, workers execute in parallel, a reviewer verifies.
// Shape: agent → parallel(agents) → agent. The deterministic script holds the plan; agents do the thinking.
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/asx";

const TASK = Type.Object({
  id: Type.String(),
  title: Type.String(),
  instructions: Type.String({ description: "Self-contained instructions for one worker" }),
  files: Type.Array(Type.String()),
});

const REVIEW = Type.Object({
  approved: Type.Boolean(),
  issues: Type.Array(Type.Object({ taskId: Type.String(), problem: Type.String() })),
});

export default defineWorkflow({
  name: "leader-worker",
  description: "Plan a change, implement it with parallel workers in isolated worktrees, review and report the branches without merging them. Use for a multi-file change that splits into independent parts; pass { goal }.",
  args: Type.Object({ goal: Type.String(), maxWorkers: Type.Optional(Type.Integer({ minimum: 1, default: 4 })) }),
  budget: { maxCostUsd: 5 },

  run: async (ctx) => {
    const maxWorkers = ctx.args.maxWorkers ?? 4;
    ctx.phase("Plan");
    const plan = await ctx.agent(
      `Decompose this goal into at most ${maxWorkers} independent tasks that touch disjoint files:\n${ctx.args.goal}`,
      {
        thinkingLevel: "high", tools: ["read", "bash"], label: "plan",
        // Enforce the authored fan-out in the result schema, not only in the planner's prompt.
        schema: Type.Object({ tasks: Type.Array(TASK, { maxItems: maxWorkers }) }),
      },
    );

    ctx.phase("Implement");
    const outcomes = await ctx.parallel(
      plan.tasks.map((task, index) => () =>
        ctx.agent(`${task.instructions}\n\nOnly touch: ${task.files.join(", ")}. Run the relevant tests before you finish.`, {
          isolation: "worktree",
          retries: 2,
          label: `worker-${index}`,
        }),
      ),
    );

    // Failed workers are null by default; completed workers expose their deterministic branch names.
    const done = outcomes.flatMap((summary, i) =>
      summary ? [{ task: plan.tasks[i], branch: `asx/${ctx.runId}/worker-${i}`, summary }] : [],
    );
    ctx.log(`${done.length}/${plan.tasks.length} workers finished`);

    ctx.phase("Review");
    const review = await ctx.agent(
      `Review these branches for the goal "${ctx.args.goal}". For each, check out the branch in a temporary worktree, run tests, and report.\n` +
        JSON.stringify(done, null, 2),
      { tools: ["read", "bash"], instructions: "You only read and run tests; never edit files.", label: "review", schema: REVIEW },
    );

    return { plan, done, review };
  },
});
