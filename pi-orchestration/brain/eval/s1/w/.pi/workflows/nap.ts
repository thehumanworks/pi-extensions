import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "nap",
  description: "Sleeps a few seconds, no agents.",
  async run(ctx) {
    ctx.phase("Nap");
    await ctx.sleep(6000);
    return "rested";
  },
});
