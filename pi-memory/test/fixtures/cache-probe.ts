import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function cacheProbe(pi: ExtensionAPI): void {
  pi.on("before_provider_request", event => {
    if (process.env.PI_MEMORY_CACHE_PROBE) appendFileSync(process.env.PI_MEMORY_CACHE_PROBE, JSON.stringify(event.payload) + "\n", { mode: 0o600 });
  });
}
