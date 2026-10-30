import { Type } from "@sinclair/typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "sinclair",
  description: "Imports the old TypeBox package name.",
  args: Type.Object({ topic: Type.String() }),
  async run(ctx) {
    return ctx.agent(`hello ${ctx.args.topic}`, { tools: [] });
  },
});
