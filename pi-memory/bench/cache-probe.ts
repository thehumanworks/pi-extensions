import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test-only instrumentation: no headers or credentials are recorded. */
export default function cacheProbe(pi: ExtensionAPI): void {
  let started = 0, turn = 0, firstText = false;
  const log = (data: unknown) => appendFileSync(process.env.PI_CACHE_METRICS!, JSON.stringify(data) + "\n", { mode: 0o600 });
  pi.on("before_provider_request", event => {
    const payload = event.payload as Record<string, any>;
    turn++; started = Date.now(); firstText = false;
    const suffix = process.env.PI_CACHE_ARM === "prefix-breaking-control" ? `-${turn}` : "";
    const marker = `Cache measurement partition ${process.env.PI_CACHE_PARTITION}${suffix}. This identifier has no task meaning.`;
    payload.input.unshift({ role: "developer", content: [{ type: "input_text", text: marker }] });
    payload.max_output_tokens = 256;
    log({ event: "request", turn, at: started, payload });
  });
  pi.on("provider_stream_event", event => {
    const data = event.data as any;
    if (!firstText && data.type === "response.output_text.delta") { firstText = true; log({ event: "first-text", turn, latencyMs: Date.now() - started }); }
    if (data.type === "response.completed" || data.type === "response.failed" || data.type === "response.incomplete") {
      log({ event: "response", turn, latencyMs: Date.now() - started, status: data.response?.status, usage: data.response?.usage, responseId: data.response?.id, model: data.response?.model });
    }
  });
}
