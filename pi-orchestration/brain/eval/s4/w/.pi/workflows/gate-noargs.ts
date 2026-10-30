import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "gate-noargs",
  description: "Waits for an approval signal, then reports it.",
  async run(ctx) {
    ctx.phase("Approval");
    const decision = await ctx.signal("approve-plan", {
      schema: Type.Object({ ok: Type.Boolean(), note: Type.Optional(Type.String()) }),
      prompt: "Approve the plan?",
    });
    return { decision };
  },
});
