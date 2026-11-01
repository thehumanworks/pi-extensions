import { defineWorkflow } from "@nothumanwork/pi-orchestration";
import { randomUUID } from "node:crypto";

export default defineWorkflow({
  name: "rand",
  description: "Other nondeterminism.",
  async run(ctx) {
    const a = randomUUID();
    const b = crypto.randomUUID();
    const c = performance.now();
    const d = process.env.HOME;
    await new Promise(r => setTimeout(r, 10));
    return { a, b, c, d };
  },
});
