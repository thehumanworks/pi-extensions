import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "norun",
  description: "No run function.",
  args: Type.Object({ topic: Type.String() }),
});
