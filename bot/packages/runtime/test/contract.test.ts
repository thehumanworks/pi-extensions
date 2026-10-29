import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { fixture, scripted, echoTool, eventually } from "./helpers.js";
import { openBot } from "../src/runtime.js";
import { serve } from "../src/server.js";
import { connectBot } from "../src/client.js";
import { createReplyPreview } from "../src/reply.js";
import { createChatRenderer } from "../src/render.js";
import { durableEvent, nativeEvent, publicEntry, nativeTranscript } from "../src/events.js";
import type { BotEvent, BotHistoryEntry, BotHistoryPage, BotToolResult } from "../src/types.js";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

function unpack(result: BotToolResult): BotHistoryPage {
  assert(!result.isError, JSON.stringify(result));
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse((result.content[0] as { text: string }).text);
}

for (const inherit of ["global", "none"] as const) test(`${inherit}: real executor emits the same bot-owned transcript and live event contract`, async t => {
  const f = await fixture({ inherit }, { "tools/echo.ts": echoTool("checked") }); t.after(f.cleanup);
  const { models } = scripted([
    answer([{ type: "text", text: "Checking the result." }, call("echo", { n: 7 })], { stopReason: "toolUse" }),
    answer("Verified the result successfully."),
  ], 100);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const preview = createReplyPreview(); const events: BotEvent[] = [];
  let stdout = "", stderr = "", sawActivity = false, sawPartial = false;
  const renderer = createChatRenderer({ stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } }, color: { stdout: false, stderr: false } });
  renderer.begin(false);
  const result = await bot.run("Check it", { onEvent: event => {
    events.push(event); preview.apply(event); renderer.onEvent(event);
    if (event.type !== "run_settled" && preview.text) sawPartial = true;
    if (preview.activity.includes("echo")) sawActivity = true;
  } });
  await eventually(async () => events, list => list.some(event => event.type === "run_settled"));
  assert.equal(result.status, "completed", result.error);
  assert(sawPartial, "answer text must be visible before the terminal record"); assert(sawActivity);
  renderer.finish(result);
  assert.match(stdout, /Verified the result successfully\./); assert.match(stderr, /echo/); assert.match(stderr, /checked:7/);
  assert.equal(stdout.split("Verified the result successfully.").length - 1, 1);
  assert(events.every(event => event.sessionId === result.sessionId && event.runId === result.runId));
  const messages = events.filter(event => event.type === "message_end");
  assert(messages.length >= 2);
  for (const event of messages) {
    const entry = event.data.entry;
    assert(Number.isSafeInteger(entry.id) && entry.id > 0, JSON.stringify(entry));
    assert.deepEqual(Object.keys(entry).sort(), ["id", "kind", "model"]); assert.equal(entry.kind, "message");
    const page = unpack(await bot.callTool("bot_history", { action: "read", session: result.sessionId, entryId: entry.id }));
    if (entry.model.some(message => message.content.some(block => block.type === "text" && block.text))) assert(page.items.length > 0);
  }
  const end = events.find(event => event.type === "tool_execution_end");
  assert(end?.type === "tool_execution_end"); assert.equal(end.data.isError, false); assert.match(end.data.summary ?? "", /checked:7/);
  assert.doesNotMatch(JSON.stringify(events), /assistantMessageEvent|nativeEntries|thinkingSignature|toolsAdded|"pi\.agent"|"api":"/);
  const attached: BotEvent[] = [];
  const stop = await bot.watch(result.sessionId, event => attached.push(event)); t.after(stop);
  const snapshot = attached[0]; assert(snapshot.type === "snapshot"); assert.equal(snapshot.data.run?.status, "completed");
  const reconnected = createReplyPreview(); let restored = "", notices = "";
  const display = createChatRenderer({ stdout: { write: s => { restored += s; } }, stderr: { write: s => { notices += s; } }, color: { stdout: false, stderr: false } });
  display.begin(false);
  for (const event of [snapshot, snapshot, { type: "message_update", runId: result.runId, data: { changes: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "stale partial" }] } }] } } satisfies BotEvent]) {
    reconnected.apply(event); display.onEvent(event);
  }
  display.finish(result);
  assert.equal(reconnected.text, result.output);
  assert.equal(restored.split(result.output).length - 1, 1); assert.doesNotMatch(restored, /stale partial/);
  assert.equal(notices.split("✓ completed").length - 1, 1);
});

test("native history works across workspaces and restarts, with stable entry IDs, bounded excerpts and no private metadata", async t => {
  const f = await fixture({ inherit: "global" }); t.after(f.cleanup);
  const other = join(f.root, "other"); await mkdir(other);
  const long = "Nebula: release Friday. " + "İ".repeat(5000) + " final marker";
  let bot = await openBot(f.source, { ...f, models: scripted([answer([{ type: "thinking", thinking: "private reasoning marker" }, { type: "text", text: long }])]).models });
  t.after(() => bot.close());
  const first = await bot.run("Remember Nebula."); assert.equal(first.status, "completed", first.error);
  const initial = unpack(await bot.callTool("bot_history", { action: "search", query: "Nebula" }));
  const found = (initial.items as BotHistoryEntry[]).find(entry => entry.text.startsWith("[assistant]"))!;
  assert(found); assert(found.nextOffset);
  await bot.close();
  const { models } = scripted([
    ctx => {
      assert(JSON.stringify(ctx.messages).includes(other));
      assert.doesNotMatch(JSON.stringify(ctx.messages), /release Friday/);
      return answer(call("bot_history", { action: "search", query: "Nebula" }), { stopReason: "toolUse" });
    },
    ctx => { assert.match(JSON.stringify(ctx.messages), /release Friday/); return answer("I recalled our agreement."); },
  ]);
  bot = await openBot(f.source, { ...f, cwd: other, models });
  const second = await bot.run("What did we agree in the other chat?"); assert.equal(second.status, "completed", second.error);
  assert.notEqual(second.sessionId, first.sessionId);
  let full = "", offset = 0;
  while (true) {
    const page = unpack(await bot.callTool("bot_history", { action: "read", session: first.sessionId, entryId: found.entryId, offset }));
    const entry = page.items[0] as BotHistoryEntry;
    assert.equal(entry.entryId, found.entryId); assert.equal(entry.cwd, f.cwd); assert(entry.text.length <= 2000);
    full += entry.text; if (entry.nextOffset === undefined) break; offset = entry.nextOffset;
  }
  assert.equal(full, `[assistant]\n${long}`);
  const listed = unpack(await bot.callTool("bot_history", { action: "list", limit: 1 }));
  assert.equal(listed.items[0].sessionId, second.sessionId); assert(listed.nextCursor);
  const next = unpack(await bot.callTool("bot_history", { action: "list", limit: 1, cursor: listed.nextCursor }));
  assert.equal(next.items[0].sessionId, first.sessionId);
  assert.doesNotMatch(JSON.stringify([listed, next]), /nativeEntries|reasoning|model_change|release Friday/);
  assert.deepEqual(unpack(await bot.callTool("bot_history", { action: "search", query: "private reasoning marker" })).items, []);
  const current = unpack(await bot.callTool("bot_history", { action: "read", session: second.sessionId }));
  assert.doesNotMatch(JSON.stringify(current), /release Friday/, "recalled tool results must not recursively enter recall");
  const peer = await fixture({ inherit: "global" }); t.after(peer.cleanup);
  const otherHome = await openBot(peer.source, { models, agentDir: f.agentDir, ephemeral: true });
  try { assert.deepEqual(unpack(await otherHome.callTool("bot_history", { action: "list" })).items, []); } finally { await otherHome.close(); }
});

for (const inherit of ["global", "none"] as const) test(`${inherit}: reconnect restores a running tool and queued observers never relabel another run`, async t => {
  const f = await fixture({ inherit }); t.after(f.cleanup);
  const release = join(f.root, "release"); await mkdir(join(f.source, "tools"));
  await writeFile(join(f.source, "tools/pause.ts"), `import {Type} from 'typebox'; import {existsSync} from 'node:fs';
export default {name:'pause',description:'Wait for inspection',parameters:Type.Object({path:Type.String()}),execute:async(args,ctx)=>{
 while(!existsSync(args.path)){ctx.signal.throwIfAborted();await new Promise(r=>setTimeout(r,10));}
 return {content:[{type:'text',text:'inspection finished'}]};}};`);
  const { models } = scripted([answer(call("pause", { path: release }), { stopReason: "toolUse" }), answer("First completed"), answer("Second completed")]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const firstEvents: BotEvent[] = [], secondEvents: BotEvent[] = [];
  const first = await bot.submit("Pause", { onEvent: e => firstEvents.push(e) });
  await eventually(async () => firstEvents, events => events.some(event => event.type === "tool_execution_start"));
  const second = await bot.submit("Next", { session: first.sessionId, onEvent: e => secondEvents.push(e) });
  const watched: BotEvent[] = [];
  const stop = await bot.watch(first.sessionId, e => watched.push(e)); t.after(stop);
  const snapshot = watched[0]; assert.equal(snapshot.type, "snapshot"); if (snapshot.type !== "snapshot") return;
  assert.equal(snapshot.data.run?.runId, first.runId);
  assert(snapshot.data.tools.some(tool => tool.toolName === "pause" && tool.status === "running"));
  assert.doesNotMatch(JSON.stringify(snapshot), /nativeEntries|systemPrompt|toolsAdded/);
  await writeFile(release, "go");
  await eventually(() => bot.getRun(second.runId), run => run.status === "completed");
  await eventually(async () => secondEvents, events => events.some(event => event.type === "run_settled"));
  assert(firstEvents.every(event => event.runId === first.runId)); assert(secondEvents.every(event => event.runId === second.runId));
  assert.doesNotMatch(JSON.stringify(secondEvents), /inspection finished|First completed/);
  assert(watched.some(event => event.type === "run_settled" && event.runId === first.runId));
});

test("HTTP native streams and history expose the same canonical contract without leaking runtime metadata", async t => {
  const f = await fixture({ inherit: "global" }, { "tools/echo.ts": echoTool("http") }); t.after(f.cleanup);
  const { models } = scripted([answer(call("echo", { n: 3 }), { stopReason: "toolUse" }), answer("HTTP answer")]);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const server = await serve(f.source, { bot, port: 0 }); t.after(() => server.close());
  const client = connectBot(server.url); t.after(() => client.close());
  const events: BotEvent[] = [];
  const run = await client.run("Check via HTTP", { onEvent: event => events.push(event) });
  assert.equal(run.status, "completed", run.error); assert.equal(events[0].type, "run_accepted"); assert.equal(events.at(-1)?.type, "run_settled");
  assert(events.some(event => event.type === "tool_execution_end" && event.data.summary?.includes("http:3")));
  assert(events.some(event => event.type === "message_end" && JSON.stringify(event.data).includes("HTTP answer")));
  const history = unpack(await client.callTool("bot_history", { action: "search", query: "HTTP answer" }));
  assert.equal(history.items[0]?.sessionId, run.sessionId);
  assert.doesNotMatch(JSON.stringify(events), /assistantMessageEvent|nativeEntries|thinkingSignature/);
});

for (const inherit of ["global", "none"] as const) test(`${inherit}: reconnect during generation restores actual partial text`, async t => {
  const f = await fixture({ inherit }); t.after(f.cleanup);
  const output = "A deliberately slow reply with enough words to inspect while it is still being generated. ".repeat(3);
  const { models } = scripted([answer(output)], 30);
  const bot = await openBot(f.source, { ...f, models }); t.after(() => bot.close());
  const streamed = createReplyPreview();
  const run = await bot.submit("Stream slowly", { onEvent: event => { streamed.apply(event); } });
  await eventually(async () => streamed.text, text => text.length > 0 && text.length < output.length);
  let snapshot: BotEvent | undefined;
  const stop = await bot.watch(run.sessionId, event => { if (event.type === "snapshot") snapshot = event; }); t.after(stop);
  assert(snapshot?.type === "snapshot");
  const partial = snapshot.data.generation?.message.content.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
  assert(partial.length > 0 && partial.length < output.length, partial);
  assert(output.startsWith(partial));
  const preview = createReplyPreview(); preview.apply(snapshot); assert.equal(preview.text, partial.trim());
  await bot.cancel(run.runId);
  assert.equal((await bot.getRun(run.runId)).status, "cancelled");
});

test("retry, compaction and durable tool snapshots expose real activity through the canonical schema", () => {
  assert.deepEqual(nativeEvent({ type: "auto_retry_start", attempt: 2, errorMessage: "rate limited", internal: "hidden" }, []), { type: "auto_retry_start", data: { attempt: 2, errorMessage: "rate limited" } });
  assert.deepEqual(nativeEvent({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" }, []), { type: "auto_retry_end", data: { success: false, errorMessage: "Retry cancelled" } });
  assert.deepEqual(nativeEvent({ type: "compaction_end", errorMessage: "Could not compact" }, []), { type: "compaction_end", data: { error: "Could not compact" } });
  const event = durableEvent({ type: "snapshot", entries: [{ id: 4, model: [{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "notes.md" } }] }] }], tools: [{ callId: "call", name: "read", status: "running", output: "reading" }], nestedTools: [], agent: { systemPrompt: "private" } });
  assert(event?.type === "snapshot");
  assert.deepEqual(event.data.tools, [{ toolCallId: "call", toolName: "read", args: { path: "notes.md" }, status: "running", summary: "reading" }]);
  assert.doesNotMatch(JSON.stringify(event), /systemPrompt|private/);
});

test("projection keeps the output schema independent of both engines' private session and provider fields", () => {
  const raw = { role: "assistant", content: [{ type: "text", text: "answer", textSignature: "secret" }, { type: "thinking", thinking: "hidden", redacted: true, thinkingSignature: "secret" }, { type: "image", data: "secret", mimeType: "image/png" }], api: "secret", responseId: "secret", usage: { secret: true } };
  const projected = publicEntry(3, [raw, { role: "system", content: "secret" }]);
  assert.deepEqual(projected, { id: 3, kind: "message", model: [{ role: "assistant", content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "", redacted: true }, { type: "image", mimeType: "image/png" }] }] });
  assert.deepEqual(durableEvent({ type: "message_end", entry: { id: 3, model: [raw], private: "secret" } }), { type: "message_end", data: { entry: projected } });
  assert.equal(durableEvent({ type: "agent_changed", agent: { private: "secret" } }), undefined);
  assert.equal(nativeEvent({ type: "agent_settled", private: "secret" }, []), undefined);
  const entries = [{ type: "session" }, { type: "message", message: raw }, { type: "compaction", summary: "compact", firstKeptEntryId: "later" }] as unknown as FileEntry[];
  assert.equal(nativeTranscript(entries)[1].id, 2);
  assert.match(JSON.stringify(nativeTranscript(entries)), /answer/); assert.doesNotMatch(JSON.stringify(nativeTranscript(entries)), /secret/);
});
