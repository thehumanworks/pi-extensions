#!/usr/bin/env node
// Stands in for `pi --mode rpc`: answers commands on stdin with events on stdout and appends
// the exchanged messages to the --session file, as Pi would. Records its start in FAKE_PI_LOG.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
if (process.env.FAKE_PI_MODE === "crash") { process.stderr.write("fake pi refused to start\n"); process.exit(3); }

const sessionFile = args[args.indexOf("--session") + 1];
const emit = record => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (command, data) => emit({ id: command.id, type: "response", command: command.type, success: true, data });
let lastId = null, nextId = 0;
const persist = message => {
  const id = (++nextId).toString(16).padStart(8, "0");
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id, parentId: lastId, timestamp: new Date().toISOString(), message })}\n`);
  lastId = id;
};
const sleep = ms => new Promise(done => setTimeout(done, ms));

let running = false, aborted = false;
const waiting = new Map();
emit({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "pi-bot", statusText: "bot: fake" });

async function run(text) {
  running = true; aborted = false;
  emit({ type: "agent_start" });
  const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  emit({ type: "message_start", message: user }); emit({ type: "message_end", message: user }); persist(user);
  if (text.includes("approve")) {
    emit({ type: "extension_ui_request", id: "req-1", method: "confirm", title: "Send the email?", message: "To: team@example.com" });
    const answer = await new Promise(resolve => waiting.set("req-1", resolve));
    emit({ type: "extension_ui_request", id: "n-1", method: "notify", message: answer.confirmed ? "Sent." : "Not sent.", notifyType: "info" });
  }
  if (text.includes("slow")) { for (let i = 0; i < 50 && !aborted; i++) await sleep(100); if (aborted) return settle(); }
  const assistant = { role: "assistant", content: [], api: "fake", provider: "fake", model: "m1", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } }, stopReason: "stop", timestamp: Date.now() };
  emit({ type: "message_start", message: assistant });
  for (const delta of ["Hello", " from", " fake pi."]) emit({ type: "message_update", usage: assistant.usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "pwd" } });
  emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", args: { command: "pwd" }, result: { content: [{ type: "text", text: process.cwd() }] }, isError: false, durationMs: 3 });
  const toolResult = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: process.cwd() }], isError: false, timestamp: Date.now() };
  assistant.content = [{ type: "thinking", thinking: "quick" }, { type: "text", text: `Hello from fake pi. You said: ${text}` }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "pwd" } }];
  emit({ type: "message_end", message: assistant }); persist(assistant);
  emit({ type: "message_end", message: toolResult }); persist(toolResult);
  settle();
}

function settle() {
  running = false;
  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled", aborted });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(command) {
  switch (command.type) {
    case "get_state": return respond(command, { model: { provider: "fake", id: "m1" }, thinkingLevel: "low", isStreaming: running, sessionFile, sessionId: "fake" });
    case "prompt":
      if (running && !command.streamingBehavior) return emit({ id: command.id, type: "response", command: "prompt", success: false, error: "Agent is busy; pass streamingBehavior." });
      respond(command, { disposition: running ? "queued" : "started" });
      if (!running) void run(command.message);
      return;
    case "abort": aborted = true; respond(command, {}); return;
    case "extension_ui_response": waiting.get(command.id)?.(command); waiting.delete(command.id); return;
    default: return emit({ id: command.id, type: "response", command: command.type, success: false, error: `fake pi does not implement ${command.type}` });
  }
}
