import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "typeerr",
  description: "Misnamed ctx method and option.",
  args: Type.Object({ topic: Type.String() }),
  async run(ctx) {
    const a = await ctx.agent(`List the names of the tools you can call, comma-separated, nothing else. ${ctx.args.topic}`, { tools: [] });
    return a;
  },
});
