// Best-of-N: generate N independent attempts (different models/temperatures/angles), judge, keep the winner.
// Two selection modes: a judge agent (LLM) or a deterministic scorer (e.g. tests passed).
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";
import { bestOf } from "@nothumanwork/pi-orchestration/recipes";

const ATTEMPT = Type.Object({
  approach: Type.String(),
  patch: Type.String({ description: "unified diff" }),
  testsPassed: Type.Boolean(),
  testOutput: Type.String(),
});

export default defineWorkflow({
  name: "best-of-n-fix",
  description: "Try N independent fixes for a failing test in separate worktrees; report the passing candidate that reads best; return its patch without applying it",
  args: Type.Object({ failingTest: Type.String(), n: Type.Optional(Type.Integer({ minimum: 2, maximum: 8, default: 4 })) }),
  agents: {
    fixer: { isolation: "worktree", budget: { maxTurns: 40 } },
    judge: { thinkingLevel: "high", tools: ["read"] },
  },

  run: async (ctx) => {
    const n = ctx.args.n ?? 4;
    const angles = ["minimal change", "root-cause refactor", "defensive validation", "rewrite the function", "exercise edge cases without changing tests"];

    ctx.phase("Attempt");
    const { winner, winnerIndex, candidates } = await bestOf(
      ctx,
      n,
      (i) =>
        ctx.agent(
          `Make test "${ctx.args.failingTest}" pass. Preferred angle: ${angles[i % angles.length]}. Finish by running the test and reporting the diff.`,
          { agentType: "fixer", label: `attempt-${i}`, schema: ATTEMPT },
        ),
      {
        // Stage 1 is deterministic: only passing attempts are judged. Stage 2 is a judge agent.
        judge: async (cands) => {
          const passing = cands.flatMap((c, i) => (c && c.testsPassed ? [{ c, i }] : []));
          if (passing.length === 0) throw new Error("No attempt passed the test");
          if (passing.length === 1) return passing[0].i;
          const verdict = await ctx.agent(
            `Pick the best patch (smallest, clearest, least risky). Reply with the index.\n` +
              passing.map((x) => `[${x.i}] ${x.c.approach}\n${x.c.patch}`).join("\n\n"),
            { agentType: "judge", label: "judge", schema: Type.Object({ index: Type.Integer() }) },
          );
          return verdict.index;
        },
      },
    );

    ctx.log(`winner: attempt ${winnerIndex} of ${candidates.length}`);
    return { winner, winnerIndex };
  },
});
