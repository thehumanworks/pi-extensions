import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Harness, createRegistry, type ConversationId, type EntryRecord, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { openBot } from "../src/runtime.js";
import { resolveSource } from "../src/paths.js";
import { readHistory, type HistoryReader } from "../src/history.js";
import { durableEntry } from "../src/events.js";
import type { BotHistoryEntry, BotHistoryPage, BotHistoryQuery, BotToolResult } from "../src/types.js";
import { fixture, scripted } from "./helpers.js";

const unpack = (result: BotToolResult): BotHistoryPage => JSON.parse((result.content[0] as { text: string }).text);
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("one home retains memory and recalls chats across workspaces, threads and process cwd changes", async t => {
  const f = await fixture({ maintenance: true, builtinTools: ["write"] }); t.after(f.cleanup);
  const other = join(f.root, "other-workspace"); await mkdir(other);
  const originalCwd = process.cwd(); t.after(() => process.chdir(originalCwd));
  const first = scripted([
    answer([
      call("bot_write", { area: "memory", path: "MEMORY.md", content: "Shared preference: concise reports." }),
      call("write", { path: "work.txt", content: "workspace A" }),
    ], { stopReason: "toolUse" }),
    answer("Nebula agreement: release on Friday."),
  ]);
  process.chdir(f.cwd);
  let bot = await openBot(f.source, { models: first.models, agentDir: f.agentDir }); t.after(() => bot.close());
  const a = await bot.run("Remember the Nebula release agreement.");
  assert.equal(a.status, "completed", a.error);
  const home = bot.stateDir;
  await bot.close();
  process.chdir(other);
  const second = scripted([
    ctx => {
      const prompt = JSON.stringify(ctx.messages);
      assert(prompt.includes(f.source)); assert(prompt.includes(home)); assert(prompt.includes(other));
      assert.match(prompt, /Shared preference: concise reports/);
      assert.match(prompt, /across ALL workspaces and threads/);
      assert(!prompt.includes("release on Friday"), "other threads should be recalled on demand, not blindly merged");
      return answer(call("bot_history", { action: "search", query: "nebula" }), { stopReason: "toolUse" });
    },
    ctx => {
      const result = ctx.messages.findLast(message => message.role === "toolResult");
      assert.match(JSON.stringify(result), /release on Friday/);
      assert(JSON.stringify(result).includes(a.sessionId)); assert(JSON.stringify(result).includes(f.cwd));
      return answer(call("write", { path: "work.txt", content: "workspace B" }), { stopReason: "toolUse" });
    },
    answer("Recalled the Friday agreement from the other thread."),
  ]);
  bot = await openBot(f.source, { models: second.models, agentDir: f.agentDir });
  assert.equal(bot.stateDir, home);
  const b = await bot.run("What release date did we agree in the other workspace?");
  assert.equal(b.status, "completed", b.error); assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(b.cwd, other);
  assert.equal(await readFile(join(f.cwd, "work.txt"), "utf8"), "workspace A");
  assert.equal(await readFile(join(other, "work.txt"), "utf8"), "workspace B");
  assert.equal(await readFile(join(home, "MEMORY.md"), "utf8"), "Shared preference: concise reports.");
  await assert.rejects(readFile(join(other, ".bot", "MEMORY.md")), { code: "ENOENT" });
  const sessions = unpack(await bot.callTool("bot_history", { action: "list" }));
  assert.deepEqual(sessions.items.map(item => item.sessionId), [b.sessionId, a.sessionId]);
  const transcript = unpack(await bot.callTool("bot_history", { action: "read", session: a.sessionId }));
  assert.match(JSON.stringify(transcript), /Remember the Nebula/); assert.match(JSON.stringify(transcript), /release on Friday/);
  assert.match(JSON.stringify(transcript), /tool call bot_write/);
  const current = unpack(await bot.callTool("bot_history", { action: "read", session: b.sessionId }));
  assert(!JSON.stringify(current).includes("release on Friday"), "do not recursively index recalled tool results");
});

test("history pagination, literal search, full entry recovery, validation and bot isolation", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const long = "Prefix [literal]. " + "İ".repeat(7000) + " tail marker";
  const { models } = scripted([answer(long), answer("Second [LITERAL] chat")]);
  let bot = await openBot(f.source, { models, agentDir: f.agentDir, cwd: f.cwd }); t.after(() => bot.close());
  const a = await bot.run("First question"); const b = await bot.run("Second question", { cwd: f.root });
  const recall = async (args: BotHistoryQuery) => unpack(await bot.callTool("bot_history", args));
  const first = await recall({ action: "list", limit: 1 }); assert.equal(first.items[0]!.sessionId, b.sessionId); assert(first.nextCursor);
  await bot.close(); bot = await openBot(f.source, { models, agentDir: f.agentDir, cwd: f.root });
  const last = await recall({ action: "list", limit: 1, cursor: first.nextCursor });
  assert.equal(last.items[0]!.sessionId, a.sessionId); assert.equal(last.nextCursor, undefined);
  const found: BotHistoryEntry[] = []; let cursor: string | undefined;
  do {
    const page = await recall({ action: "search", query: "[literal]", limit: 1, ...(cursor ? { cursor } : {}) });
    found.push(...page.items as BotHistoryEntry[]); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(found.map(item => item.sessionId), [b.sessionId, a.sessionId]);
  const entry = found.find(item => item.sessionId === a.sessionId)!;
  let full = ""; let offset = 0;
  while (true) {
    const page = await recall({ action: "read", session: a.sessionId, entryId: entry.entryId, offset });
    const chunk = page.items[0] as BotHistoryEntry;
    assert.equal(chunk.offset, offset); assert(chunk.text.length <= 2000); full += chunk.text;
    if (chunk.nextOffset === undefined) break;
    offset = chunk.nextOffset;
  }
  assert.equal(full, `[assistant]\n${long}`);
  const tail = (await recall({ action: "search", query: "tail marker", session: a.sessionId })).items[0] as BotHistoryEntry;
  assert(tail.offset > 6000); assert.match(tail.text, /tail marker/);
  assert.deepEqual((await recall({ action: "search", query: "definitely not present" })).items, []);
  await assert.rejects(recall({ action: "search", query: "changed", cursor: first.nextCursor }), code("INVALID_INPUT"));
  await assert.rejects(recall({ action: "list", cursor: "garbage" }), code("INVALID_INPUT"));
  await assert.rejects(recall({ action: "search", query: "  " }), code("INVALID_INPUT"));
  await assert.rejects(recall({ action: "read" }), code("INVALID_INPUT"));
  await assert.rejects(recall({ action: "read", session: a.sessionId, offset: 10 }), code("INVALID_INPUT"));
  await assert.rejects(recall({ action: "read", session: "dconv:999999" }), code("NOT_FOUND"));
  await assert.rejects(recall({ action: "read", session: b.sessionId, entryId: entry.entryId }), code("NOT_FOUND"));
  await assert.rejects(recall({ action: "read", session: a.sessionId, entryId: entry.entryId, offset: 90000 }), code("INVALID_INPUT"));
  await assert.rejects(recall({ action: "list", limit: 0 }), code("INVALID_INPUT"));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(bot.callTool("bot_history", { action: "list" }, { signal: abort.signal }));
  await bot.close();
  // An explicitly selected different home is intentionally isolated, never silently merged.
  bot = await openBot(f.source, { models, agentDir: f.agentDir, stateDir: join(f.root, "separate-state") });
  assert.deepEqual((await recall({ action: "list" })).items, []);
  await bot.close();
  bot = await openBot(f.source, { models, agentDir: f.agentDir, ephemeral: true });
  assert.deepEqual((await recall({ action: "list" })).items, []);
  const other = await fixture(); t.after(other.cleanup);
  const peer = await openBot(other.source, { models, agentDir: other.agentDir }); t.after(() => peer.close());
  assert.deepEqual(unpack(await peer.callTool("bot_history", { action: "list" })).items, []);
});

test("recall reads persisted history outside the active context without needing memory-write tools", async t => {
  const f = await fixture({ tools: ["bot_history"] }); t.after(f.cleanup);
  const { models } = scripted([answer("Original decision: amber.")]);
  let bot = await openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  const run = await bot.run("Record our decision"); const state = bot.stateDir; await bot.close();
  // Simulate a context boundary in the durable harness: old entries stay in storage.
  const harness = await Harness.open(await openNodeSqliteStorage(join(state, "runtime.sqlite")), { models, registry: createRegistry() }, C);
  try {
    const conversation = (await harness.conversation(Number(run.sessionId.slice(6)) as ConversationId, C))!;
    await conversation.reset("A fresh context", C);
    const view = await conversation.viewState(C);
    try { assert(!JSON.stringify(view.value.entries).includes("Original decision")); } finally { view.dispose(); }
  } finally { await harness.close(C); }
  bot = await openBot(f.source, { models, agentDir: f.agentDir, cwd: f.root });
  const recalled = unpack(await bot.callTool("bot_history", { action: "search", query: "Original decision" }));
  assert.equal(recalled.items.length, 1); assert.match((recalled.items[0] as BotHistoryEntry).text, /amber/);
  await assert.rejects(bot.callTool("bot_write", { area: "memory", path: "MEMORY.md", content: "x" }), /not enabled/);
});

test("bounded scans continue through empty search pages and omit system/thinking content", async () => {
  const entries = Array.from({ length: 510 }, (_, index) => ({ id: index + 1, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "private needle" }, { type: "text", text: index === 0 ? "public needle" : "ordinary" }] }] })) as unknown as EntryRecord[];
  entries.push({ id: 511, conversationId: 1, kind: "pi.system", model: [{ role: "system", content: "system needle" }] } as unknown as EntryRecord);
  let scans = 0;
  const storage: HistoryReader = async (_session, query, limit) => {
    scans++; const values = entries.filter(entry => query.maxEntryId === undefined || entry.id <= query.maxEntryId).reverse();
    return { items: values.slice(0, limit).map(durableEntry), hasMore: values.length > limit };
  };
  const sessions = [{ sessionId: "dconv:1", cwd: "/work", createdAt: "now", updatedAt: "now" }];
  const signal = new AbortController().signal;
  const first = await readHistory(storage, sessions, "/home/bot", { action: "search", query: "needle" }, signal);
  assert.equal(scans, 10); assert.deepEqual(first.items, []); assert(first.nextCursor);
  const last = await readHistory(storage, sessions, "/home/bot", { action: "search", query: "needle", cursor: first.nextCursor }, signal);
  assert.equal(last.items.length, 1); assert.match((last.items[0] as BotHistoryEntry).text, /public needle/);
  assert(!JSON.stringify(last).includes("private needle")); assert.equal(last.nextCursor, undefined);
  await assert.rejects(readHistory(storage, sessions, "/different/home", { action: "search", query: "needle", cursor: first.nextCursor }, signal), code("INVALID_INPUT"));
});

test("byte-limited pages resume before the unconsumed entry without losing matches", async () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "match " + "\u0000".repeat(2000) }] })) as unknown as EntryRecord[];
  const storage: HistoryReader = async (_session, query, limit) => {
    const values = entries.filter(entry => query.maxEntryId === undefined || entry.id <= query.maxEntryId).reverse();
    return { items: values.slice(0, limit).map(durableEntry), hasMore: values.length > limit };
  };
  const sessions = [{ sessionId: "dconv:1", cwd: "/work", createdAt: "now", updatedAt: "now" }];
  const seen: number[] = []; let cursor: string | undefined;
  do {
    const page = await readHistory(storage, sessions, "/bot", { action: "search", query: "match", limit: 20, ...(cursor ? { cursor } : {}) }, new AbortController().signal);
    assert(Buffer.byteLength(JSON.stringify(page)) < 25_000);
    assert(page.items.length < 12);
    seen.push(...page.items.map(item => (item as BotHistoryEntry).entryId)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, entries.map(entry => entry.id).reverse());
});

test("bare roster names cannot be shadowed by caller cwd; explicit paths and symlinks keep identity", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const roster = join(f.root, "roster"); await mkdir(roster);
  await symlink(f.source, join(roster, "tester"), "dir");
  await mkdir(join(f.cwd, "tester"));
  const cwd = process.cwd(), oldHome = process.env.PI_BOT_HOME;
  t.after(() => { process.chdir(cwd); if (oldHome === undefined) delete process.env.PI_BOT_HOME; else process.env.PI_BOT_HOME = oldHome; });
  process.env.PI_BOT_HOME = roster;
  process.chdir(f.cwd);
  assert.equal(await resolveSource("tester"), f.source);
  assert.equal(await resolveSource("./tester"), join(f.cwd, "tester"));
  assert.equal(await resolveSource(join(roster, "tester", "BOT.md")), f.source);
  process.chdir(f.root);
  assert.equal(await resolveSource("tester"), f.source);
  process.chdir(f.source);
  assert.equal(await resolveSource("BOT.md"), f.source);
  await assert.rejects(resolveSource("missing"), code("NOT_FOUND"));
});
