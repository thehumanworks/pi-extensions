// Loop-until-dry + adversarial verify (the Claude Code "deep research" quality pattern):
// keep spawning finders until K consecutive rounds surface nothing new; verify each fresh finding with
// three skeptics using different lenses; keep a finding only if a majority survive.
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";
import { untilDry } from "@nothumanwork/pi-orchestration/recipes";

const BUGS = Type.Object({ bugs: Type.Array(Type.Object({ file: Type.String(), line: Type.Integer(), desc: Type.String() })) });
const VERDICT = Type.Object({ real: Type.Boolean(), reason: Type.String() });
type Bug = { file: string; line: number; desc: string };

export default defineWorkflow({
  name: "bug-hunt",
  description: "Find bugs in a directory until finders run dry; adversarially verify each finding",
  args: Type.Object({ dir: Type.String() }),
  agents: { finder: { tools: ["read", "bash"] }, skeptic: { tools: ["read", "bash"], thinkingLevel: "medium" } },

  run: async (ctx) => {
    const lenses = ["concurrency", "error handling", "input validation", "resource leaks"];

    ctx.phase("Find");
    const found = await untilDry<Bug>(
      ctx,
      async (seen, round) => {
        const rounds = await ctx.parallel(
          lenses.map((lens) => () =>
            ctx.agent(`Round ${round}. Find bugs in ${ctx.args.dir} through the ${lens} lens. Already known (skip): ${[...seen].join("; ")}`, {
              agentType: "finder",
              label: `find:${lens}:${round}`,
              phase: "Find",
              schema: BUGS,
            }),
          ),
        );
        return rounds.filter(Boolean).flatMap((r) => r!.bugs);
      },
      { keyOf: (b) => `${b.file}:${b.line}`, consecutiveEmpty: 2, maxRounds: 6 },
    );

    ctx.phase("Verify");
    const verdicts = await ctx.parallel(
      found.map((bug) => async () => {
        const votes = await ctx.parallel(
          ["correctness", "security", "reproduce it"].map((lens) => () =>
            ctx.agent(`Is this a real bug? Judge via the "${lens}" lens and try to refute it.\n${JSON.stringify(bug)}`, {
              agentType: "skeptic",
              label: `verify:${bug.file}:${bug.line}:${lens}`,
              phase: "Verify",
              schema: VERDICT,
            }),
          ),
        );
        return { bug, real: votes.filter(Boolean).filter((v) => v!.real).length >= 2 };
      }),
    );

    const confirmed = verdicts.filter(Boolean).filter((v) => v!.real).map((v) => v!.bug);
    ctx.log(`${confirmed.length} confirmed of ${found.length} found`);
    return confirmed;
  },
});
