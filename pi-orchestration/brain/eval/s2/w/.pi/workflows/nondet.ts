import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";
import { readFileSync } from "node:fs";

export default defineWorkflow({
  name: "nondet",
  description: "Uses Date.now, Math.random and fs outside step.",
  args: Type.Object({ topic: Type.String() }),
  async run(ctx) {
    const t = ctx.now();
    const r = ctx.random();
    const s = await ctx.step("read-readme", async ({ cwd }) => readFileSync(`${cwd}/MISSING.md`, "utf8"));
    return ctx.agent(`hello ${ctx.args.topic} ${t} ${r} ${s.length}`, { tools: [] });
  },
});
