import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "tiny",
  description: "One agent writes one sentence about a topic.",
  args: Type.Object({ topic: Type.String() }),
  budget: { maxAgents: 1 },
  async run(ctx) {
    return ctx.agent(`Write one short sentence about ${ctx.args.topic}.`, { label: "sentence", tools: [] });
  },
});
