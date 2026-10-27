import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestration } from "./src/extension.ts";

export default function orchestration(pi: ExtensionAPI): void {
  registerOrchestration(pi);
}
