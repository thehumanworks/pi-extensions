// Background agents: persistent conversations that outlive individual steps (and optionally the run).
// Use for a "watcher" that keeps running tests, a "scribe" that accumulates a changelog, or an interactive helper.
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "with-watcher",
  description: "Implement a feature while a background watcher re-runs the test suite and reports regressions",
  args: Type.Object({ feature: Type.String() }),

  run: async (ctx) => {
    // Started once; survives the parallel() barrier below. Stopped automatically at run end.
    const watcher = await ctx.spawn({
      name: "watcher",
      label: "test-watcher",
      tools: ["read", "bash"],
      instructions: "You are a test watcher. When asked, run the test suite and report ONLY new failures compared with your last run.",
      initialPrompt: "Run the test suite once to establish a baseline and reply 'baseline ready'.",
    });
    await watcher.wait();

    ctx.phase("Implement");
    const parts = await ctx.agent(`Split "${ctx.args.feature}" into 2-3 independent parts; return their instructions.`, {
      label: "split",
      schema: Type.Object({ parts: Type.Array(Type.String()) }),
    });

    // A failed part becomes null and shows in status; the watcher's test run below catches what it left broken.
    await ctx.parallel(parts.parts.map((p, i) => () => ctx.agent(p, { label: `part:${i}`, phase: "Implement" })), { failure: "null" });

    // Ask the watcher for a delta now that all parts have landed.
    await watcher.send("Re-run the suite and report new failures.", { whenBusy: "followUp" });
    const regressions = await watcher.wait();

    if (!/no new failures/i.test(regressions)) {
      ctx.phase("Fix");
      await ctx.agent(`Fix these regressions:\n${regressions}`, { label: "fix" });
    }

    // Optional: keep the watcher alive after the run for interactive use (`workflow steer <run> watcher "…"`).
    // const scribe = await ctx.spawn({ name: "scribe", detach: true, ... });

    return { regressions };
  },
});
