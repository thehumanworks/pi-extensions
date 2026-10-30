import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "clock",
  description: "Uses Date.now in control flow.",
  async run(ctx) {
    const t = Date.now();
    return `started ${t > 0}`;
  },
});
