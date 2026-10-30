import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

const wf = defineWorkflow({
  name: "noexport",
  description: "Forgot export default.",
  args: Type.Object({ topic: Type.String() }),
  async run(ctx) {
    return ctx.agent(`hello ${ctx.args.topic}`, { tools: [] });
  },
});
