import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "badargs2",
  description: "Args schema is a string, not an object.",
  args: Type.String(),
  async run(ctx) {
    return ctx.agent(`hello ${ctx.args}`, { tools: [] });
  },
});
