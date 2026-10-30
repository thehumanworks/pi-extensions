import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "pair",
  description: "Two agents each write one fact about a topic, in parallel.",
  args: Type.Object({ topic: Type.String() }),
  budget: { maxAgents: 2 },
  async run(ctx) {
    ctx.phase("Facts");
    const facts = await ctx.parallel(
      ["history", "science"].map(angle => () =>
        ctx.agent(`Give one short ${angle} fact about ${ctx.args.topic}. One sentence, no preamble.`, { label: angle, tools: [] })),
    );
    return { topic: ctx.args.topic, facts };
  },
});
