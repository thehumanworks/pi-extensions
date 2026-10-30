import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "facts", // kebab-case; run it by this name
  description: "Generate two short facts about a topic from different angles (history and science).",
  args: Type.Object({ topic: Type.String() }), // checked before the run starts
  budget: { maxAgents: 2 }, // a cap; the code below decides how many agents run
  async run(ctx) {
    ctx.phase("Generate Facts");
    const facts = await ctx.parallel(
      [
        { angle: "history", prompt: `Give one short historical fact about ${ctx.args.topic}. Be concise.` },
        { angle: "science", prompt: `Give one short scientific fact about ${ctx.args.topic}. Be concise.` },
      ].map(({ angle, prompt }) => () =>
        ctx.agent(prompt, { label: angle, tools: [] })),
      { failure: "failFast" }, // the default, "null", turns a failed branch into null and carries on
    );
    return {
      topic: ctx.args.topic,
      history: facts[0],
      science: facts[1],
    };
  },
});
