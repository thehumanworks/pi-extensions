import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "syntax",
  description: "Broken on purpose.",
  args: Type.Object({ topic: Type.String() }),
  async run(ctx) {
    const x = await ctx.agent(`hello ${ctx.args.topic}`, { tools: [] };
    return x;
  },
});
