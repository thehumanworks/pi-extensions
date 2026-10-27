// Composition: a workflow invokes other workflows (by catalog name or path) as journaled child runs.
// The child shares the parent's concurrency cap and budget and shows up as its own run with parentRunId.
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "ship-feature",
  description: "Prepare implementation branches, audit the current checkout, then gate a release dry run",
  args: Type.Object({ goal: Type.String(), version: Type.String() }),
  // ctx.workflow() is the only way to open another workflow; agents inside a run cannot launch one.
  // Recursion is capped by the worker setting maxDepth (default 1), so this root may call children but they may not.
  budget: { maxAgents: 80, maxCostUsd: 25 },

  run: async (ctx) => {
    ctx.phase("Implement");
    await ctx.workflow<{ done: unknown[] }>("leader-worker", { goal: ctx.args.goal });

    // Implementation branches are reported for review; merge them before using this as a shipping workflow.
    ctx.phase("Audit current checkout");
    const bugs = await ctx.workflow<unknown[]>("bug-hunt", { dir: "src" });
    if (bugs.length > 0) {
      // Do not release with an unfixed bug: one failed fix stops the others and fails the run.
      await ctx.parallel(bugs.map((b, i) => () => ctx.agent(`Fix this confirmed bug: ${JSON.stringify(b)}`, { label: `fix:${i}`, phase: "Harden" })), { failure: "failFast" });
    }

    ctx.phase("Release");
    return ctx.workflow("release-with-approval", { version: ctx.args.version });
  },
});
