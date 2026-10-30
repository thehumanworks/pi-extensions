import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "gate",
  description: "Waits for a human approval signal, then reports it.",
  args: Type.Object({ plan: Type.String() }),
  async run(ctx) {
    ctx.phase("Approval");
    const decision = await ctx.signal("approve-plan", {
      schema: Type.Object({ ok: Type.Boolean(), note: Type.Optional(Type.String()) }),
      prompt: `Approve the plan "${ctx.args.plan}"? Send {"ok": true|false, "note"?: string}.`,
    });
    ctx.log("decision received", decision);
    return { plan: ctx.args.plan, decision };
  },
});
