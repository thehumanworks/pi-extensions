import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "facts",
  description: "Runs two agents in parallel to provide one short fact about a topic from history and science angles.",
  args: Type.Object({ topic: Type.String() }),
  budget: { maxAgents: 2 },
  async run(ctx) {
    ctx.phase("Gather Facts");
    const facts = await ctx.parallel(
      [
        { angle: "history", prompt: `Give one short interesting historical fact about ${ctx.args.topic}.` },
        { angle: "science", prompt: `Give one short interesting scientific fact about ${ctx.args.topic}.` },
      ].map(({ angle, prompt }) => () =>
        ctx.agent(prompt, { 
          label: angle, 
          tools: [] 
        })),
      { failure: "failFast" },
    );
    
    return {
      topic: ctx.args.topic,
      history: facts[0],
      science: facts[1],
    };
  },
});
