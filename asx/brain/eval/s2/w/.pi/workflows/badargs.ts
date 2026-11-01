import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "badargs",
  description: "Args schema is a plain object, not TypeBox.",
  args: { topic: "string" },
  async run(ctx) {
    return ctx.agent(`hello ${ctx.args.topic}`, { tools: [] });
  },
});
