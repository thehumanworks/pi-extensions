import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export const workflow = defineWorkflow({
  name: "namedexport",
  description: "Named export instead of default.",
  args: Type.Object({ topic: Type.String() }),
  async run(ctx) {
    return ctx.agent(`hello ${ctx.args.topic}`, { tools: [] });
  },
});
