import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

function fixture() {
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const events: Record<string, any> = {};
  const messages: any[] = [];
  const notices: string[] = [];
  const pi = {
    registerCommand: (name: string, command: unknown) => { commands[name] = command; },
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    on: (name: string, handler: unknown) => { events[name] = handler; },
    sendUserMessage: (...args: unknown[]) => { messages.push(args); },
    sendMessage: (...args: unknown[]) => { messages.push(args); },
    getThinkingLevel: () => "off",
  };
  extension(pi as unknown as ExtensionAPI);
  const ctx = { ui: { notify: (message: string) => notices.push(message), confirm: async () => false },
    hasUI: true, model: { provider: "openai", id: "gpt-5" }, cwd: process.cwd() };
  return { commands, tools, events, messages, notices, ctx };
}

test("/loop asks the agent to preserve scope and does not execute the task", async () => {
  const f = fixture();
  await f.commands.loop.handler('5m check "my build"\nwithout editing files', f.ctx);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0][0], /Create ONE recurring schedule/);
  assert.match(f.messages[0][0], /without adding any requirements or scope/);
  assert.match(f.messages[0][0], /Frequency: 5m/);
  assert.deepEqual(f.messages[0][1], { deliverAs: "followUp", expandPromptTemplates: false });
  assert.ok(f.events.session_start);
  assert.ok(f.tools.loop);
});
test("help and malformed intervals do not ask the agent or start workers", async () => {
  const f = fixture();
  await f.commands.loop.handler("", f.ctx);
  await f.commands.loop.handler("0s run", f.ctx);
  await f.commands.loop.handler("pause", f.ctx);
  assert.equal(f.messages.length, 0);
  assert.match(f.notices[0], /\/loop <frequency>/);
  assert.match(f.notices[1], /one second/);
  assert.match(f.notices[2], /Usage/);
});
test("tool validates required parameters and honors declined confirmation", async () => {
  const f = fixture();
  await assert.rejects(f.tools.loop.execute("call", { action: "create" }, undefined, undefined, f.ctx), /requires frequency/);
  await assert.rejects(f.tools.loop.execute("call", { action: "show" }, undefined, undefined, f.ctx), /requires a schedule ID/);
  await assert.rejects(f.tools.loop.execute("call", { action: "create", frequency: "1d", prompt: "Check builds." },
    undefined, undefined, f.ctx), /cancelled/);
});
test("headless creation is explicitly opt-in", async () => {
  const f = fixture();
  const old = process.env.PI_LOOP_ALLOW_UNATTENDED;
  delete process.env.PI_LOOP_ALLOW_UNATTENDED;
  try {
    await assert.rejects(f.tools.loop.execute("call", { action: "create", frequency: "1d", prompt: "Check builds." },
      undefined, undefined, { ...f.ctx, hasUI: false }), /PI_LOOP_ALLOW_UNATTENDED/);
  } finally { if (old !== undefined) process.env.PI_LOOP_ALLOW_UNATTENDED = old; }
});
