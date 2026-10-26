#!/usr/bin/env node
// Stands in for `pi --mode json`: records how it was started and replies according to FAKE_PI_MODE.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ args, cwd: process.cwd(), depth: process.env.PI_BOT_DEPTH })}\n`);
const mode = process.env.FAKE_PI_MODE ?? "ok";
const emit = record => process.stdout.write(`${JSON.stringify(record)}\n`);
const assistant = (content, extra = {}) => ({
  type: "message_end",
  message: { role: "assistant", content, provider: "fake", model: "m1", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } }, ...extra },
});

if (args.includes("--help")) { console.log("pi help"); process.exit(0); }
emit({ type: "session", version: 3, id: process.env.FAKE_PI_SESSION ?? "s-1", timestamp: new Date().toISOString(), cwd: process.cwd() });
if (mode === "sleep") setTimeout(() => {}, 60_000);
else if (mode === "error") {
  process.stderr.write("provider exploded\n");
  emit(assistant([], { stopReason: "error", errorMessage: "Rate limited" }));
  process.exit(1);
} else {
  emit(assistant([{ type: "text", text: "Looking." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }]));
  emit({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "file body" }] } });
  emit(assistant([{ type: "text", text: `Done: ${args.at(-1)}` }]));
}
