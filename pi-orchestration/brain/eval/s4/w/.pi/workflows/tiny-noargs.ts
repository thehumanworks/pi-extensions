import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "tiny-noargs",
  description: "One agent writes one sentence about bees.",
  budget: { maxAgents: 1 },
  async run(ctx) {
    return ctx.agent("Write one short sentence about bees.", { label: "sentence", tools: [] });
  },
});
