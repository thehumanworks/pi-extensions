import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ModelRegistry, SessionManager, initTheme, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import extension from "../../index.ts";
import { completions, parseArgs, registerRecallCommand } from "../command/command.ts";
import { context, project, workspace } from "../testing.ts";
import { handleSummaryCommand, parseSummaryArgs } from "./command.ts";
import { SummaryService } from "./service.ts";
import { conversationSource, SUMMARY_TOOL } from "./source.ts";
import { type StoredSummary, SummaryStore } from "./store.ts";
import { createSummaryTool, registerSummaryActivity } from "./tool.ts";

const usage: Usage = { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (text = "# Summary\nDecided to build it.\n\n## Citations\n{}") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage,
} as AssistantMessage);

function modelRegistry(complete: (context: Context, signal?: AbortSignal) => Promise<AssistantMessage> = async () => reply()) {
  const calls: Context[] = [];
  return {
    calls,
    registry: {
      find: () => ({ provider: "vercel-ai-gateway", id: "inception/mercury-3", maxTokens: 32000, contextWindow: 128000 }),
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, input: Context, options: { signal?: AbortSignal }) => {
        calls.push(input);
        return complete(input, options.signal);
      },
    } as unknown as ModelRegistry,
  };
}

async function setup(texts = ["Build the feature"]) {
  const p = await project();
  const sm = p.session(texts);
  const model = modelRegistry();
  const ctx = { ...context(sm), modelRegistry: model.registry };
  const store = new SummaryStore(await mkdtemp(join(tmpdir(), "recall-summaries-")));
  return { p, sm, model, ctx, store, service: new SummaryService(store) };
}

function assistant(sm: SessionManager, text: string, calls: { name: string; id: string }[] = []) {
  return sm.appendMessage({
    ...reply(text), api: "test", provider: "test", model: "test", timestamp: Date.now(),
    content: [...(text ? [{ type: "text" as const, text }] : []), ...calls.map((call) => ({ type: "toolCall" as const, ...call, arguments: {} }))],
  });
}
function result(sm: SessionManager, name: string, id: string) {
  return sm.appendMessage({ role: "toolResult", toolName: name, toolCallId: id, content: [{ type: "text", text: "Saved summary" }], isError: false, timestamp: Date.now() });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fakePi(sm?: SessionManager) {
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const commands = new Map<string, any>();
  const tools: any[] = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand(name: string, definition: any) { commands.set(name, definition); },
    registerTool(tool: any) { tools.push(tool); },
    appendEntry(customType: string, data: any) { sm?.appendCustomEntry(customType, data); },
  } as unknown as ExtensionAPI;
  return { pi, commands, tools, async emit(name: string, event: any, ctx?: any) {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  } };
}

describe("summary generation and checkpoints", () => {
  test("first request, stored provenance, restart, no-change rejection, and one new message", async () => {
    const { p, sm, ctx, service, store, model } = await setup();
    const first = await service.create(ctx, { requestedBy: "user" });
    expect(first.usage).toEqual(usage);
    expect(first.summary).toMatchObject({ project: p.cwd, scope: { kind: "session", sessionId: sm.getSessionId() },
      requesterSessionId: sm.getSessionId(), requestedBy: "user", model: { id: "inception/mercury-3" } });
    expect(first.summary.sources[0]!.messageIds).toEqual([sm.getLeafId()!]);
    expect(await new SummaryStore(store.root).get(first.summary.id)).toEqual(first.summary);
    const restarted = new SummaryService(new SummaryStore(store.root));
    await expect(restarted.create(ctx)).rejects.toThrow("No new conversation messages");
    expect(model.calls).toHaveLength(1);
    const newId = p.user(sm, "Also add tests");
    const second = await restarted.create(ctx);
    expect(second.summary.sources[0]!.messageIds).toContain(newId);
    await expect(service.create(ctx)).rejects.toThrow("No new conversation messages");
    expect(model.calls).toHaveLength(2);
    expect((await stat(join(store.projectDir(p.cwd), `${first.summary.id}.json`))).mode & 0o777).toBe(0o600);
  });

  test("unsaved in-memory sessions can be summarised without relying on session persistence", async () => {
    const { ctx, service, store, p } = await setup([]);
    const memory = SessionManager.inMemory(p.cwd);
    const id = memory.appendMessage({ role: "user", content: "Not written to a session file", timestamp: 1 });
    const live = { ...ctx, sessionManager: memory };
    const { summary } = await service.create(live);
    expect(summary.sources[0]!.messageIds).toEqual([id]);
    expect(memory.getSessionFile()).toBeUndefined();
    expect(await new SummaryStore(store.root).get(summary.id)).toEqual(summary);
    expect((await service.list(live)).summaries).toHaveLength(1);
  });

  test("empty history and summary-only history never call the model", async () => {
    const { sm, p, ctx, service, model } = await setup([]);
    await expect(service.create(ctx)).rejects.toThrow("No conversation messages");
    p.user(sm, "Summarise this");
    assistant(sm, "I will summarise", [{ name: SUMMARY_TOOL, id: "summary1" }]);
    await expect(service.create(ctx)).rejects.toThrow("No conversation messages");
    expect(model.calls).toHaveLength(0);
  });

  test("requests, results, narration, custom summaries and compaction do not unlock another request", async () => {
    const { sm, p, ctx, service, model } = await setup();
    const old = sm.getLeafId()!;
    await service.create(ctx);
    for (const action of ["create", "list", "read"]) {
      p.user(sm, `Please ${action} a summary`);
      assistant(sm, "Preparing it", [{ name: SUMMARY_TOOL, id: action }]);
      result(sm, SUMMARY_TOOL, action);
      assistant(sm, "Here is your summary");
    }
    sm.appendCustomMessageEntry("pi-recall/summary", "Saved text", true);
    sm.appendCompaction("A compaction summary", old, 500);
    await expect(service.create(ctx)).rejects.toThrow("No new conversation messages");
    expect(model.calls).toHaveLength(1);
    const newId = p.user(sm, "The API must also return source references");
    await service.create(ctx);
    expect(conversationSource(sm).messageIds).toEqual([old, newId]);
  });

  test("mixed turns preserve work, but post-summary narration is not new conversation", async () => {
    const { sm, ctx, service, model } = await setup();
    const workId = assistant(sm, "Implemented the change", [{ name: "edit", id: "edit1" }]);
    result(sm, "edit", "edit1");
    assistant(sm, "Now summarising", [{ name: SUMMARY_TOOL, id: "sum" }]);
    const first = await service.create(ctx);
    expect(first.summary.sources[0]!.messageIds).toContain(workId);
    result(sm, SUMMARY_TOOL, "sum");
    assistant(sm, "The summary is saved");
    await expect(service.create(ctx)).rejects.toThrow("No new conversation messages");
    expect(model.calls).toHaveLength(1);
  });

  test("a new assistant message without summary activity is eligible", async () => {
    const { sm, ctx, service } = await setup();
    await service.create(ctx);
    const id = assistant(sm, "The tests passed");
    expect((await service.create(ctx)).summary.sources[0]!.messageIds).toContain(id);
  });

  test("only snapshot messages are covered when new messages arrive during the model call", async () => {
    const { sm, p, ctx, service } = await setup();
    const started = deferred<void>();
    const finish = deferred<AssistantMessage>();
    ctx.modelRegistry = modelRegistry(async () => { started.resolve(); return finish.promise; }).registry;
    const pending = service.create(ctx);
    await started.promise;
    const during = p.user(sm, "Arrived during generation");
    finish.resolve(reply());
    expect((await pending).summary.sources[0]!.messageIds).not.toContain(during);
    ctx.modelRegistry = modelRegistry().registry;
    expect((await service.create(ctx)).summary.sources[0]!.messageIds).toContain(during);
  });

  test("branch revisits do not recycle covered messages", async () => {
    const { sm, p, ctx, service } = await setup();
    const root = sm.getLeafId()!;
    const a = p.user(sm, "Branch A");
    await service.create(ctx);
    sm.branch(root);
    p.user(sm, "Branch B");
    await service.create(ctx);
    sm.branch(a);
    await expect(service.create(ctx)).rejects.toThrow("No new conversation messages");
  });

  test("model errors, empty replies, truncation, abort and write errors do not advance the checkpoint", async () => {
    const { ctx, store, service, p } = await setup();
    for (const response of [reply(""), { ...reply(), stopReason: "error" as const, errorMessage: "provider failed" }, { ...reply(), stopReason: "length" as const }]) {
      ctx.modelRegistry = modelRegistry(async () => response).registry;
      await expect(service.create(ctx)).rejects.toThrow();
      expect(await store.records()).toHaveLength(0);
    }
    const abort = new AbortController();
    ctx.modelRegistry = modelRegistry(async () => { abort.abort(); return reply(); }).registry;
    await expect(service.create(ctx, { signal: abort.signal })).rejects.toThrow();
    expect(await store.records()).toHaveLength(0);
    const save = store.save;
    store.save = async () => { throw new Error("disk full"); };
    ctx.modelRegistry = modelRegistry().registry;
    await expect(service.create(ctx)).rejects.toThrow("disk full");
    store.save = save;
    await service.create(ctx);
    expect(await store.records(p.cwd)).toHaveLength(1);
    expect((await readdir(store.projectDir(p.cwd))).every((file) => file.endsWith(".json"))).toBe(true);
  });

  test("corrupt stored records fail closed instead of permitting regeneration", async () => {
    const { ctx, service, store, p, model } = await setup();
    const { summary } = await service.create(ctx);
    await writeFile(join(store.projectDir(p.cwd), `${summary.id}.json`), "{}");
    await expect(service.create(ctx)).rejects.toThrow("Invalid saved summary");
    expect(model.calls).toHaveLength(1);
  });
});

describe("scope and browsing", () => {
  for (const shared of [false, true]) {
    test(`defaults to current session; project crosses only this project's sessions (shared=${shared})`, async () => {
      const w = await workspace({ shared });
      const p = await w.project("app");
      const other = await w.project("other");
      const old = p.session(["Earlier decision"]);
      const current = p.session(["Current decision"]);
      const foreign = other.session(["Must not be sent"]);
      await mkdir(join(p.cwd, CONFIG_DIR_NAME), { recursive: true });
      await writeFile(join(p.cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ recallConfig: [other.cwd] }));
      const model = modelRegistry();
      const ctx = { ...context(current), modelRegistry: model.registry };
      const service = new SummaryService(new SummaryStore(join(w.root, "summaries")));
      const one = await service.create(ctx);
      expect(one.summary.sources.map((s) => s.sessionId)).toEqual([current.getSessionId()]);
      const all = await service.create(ctx, { scope: "project" });
      expect(all.summary.sources.map((s) => s.sessionId).sort()).toEqual([old.getSessionId(), current.getSessionId()].sort());
      const prompt = String(model.calls[1]!.messages[0]!.content);
      expect(prompt).toContain(`${old.getSessionId()}/${old.getLeafId()}`);
      expect(prompt).toContain(`${current.getSessionId()}/${current.getLeafId()}`);
      expect(prompt).not.toContain("Must not be sent");
      await expect(service.create(ctx, { sessionId: foreign.getSessionId() })).rejects.toThrow("current project");
      const historic = await service.create(ctx, { sessionId: old.getSessionId() });
      expect(historic.summary.requesterSessionId).toBe(current.getSessionId());
      expect(historic.summary.scope).toEqual({ kind: "session", sessionId: old.getSessionId() });
      expect((await service.list(ctx)).summaries).toHaveLength(3);
      expect((await service.list(ctx, { sessionId: old.getSessionId() })).summaries).toHaveLength(0);
      await expect(service.create(ctx, { scope: "project" })).rejects.toThrow("No new");
      p.user(old, "New decision in another session");
      await service.create(ctx, { scope: "project" });
    });
  }

  test("listing across projects survives deleted source files; read/list need no credentials", async () => {
    const { service, p, sm, ctx, model } = await setup();
    const first = (await service.create(ctx)).summary;
    const newSession = p.session();
    const emptyCtx = { ...context(newSession), modelRegistry: undefined as unknown as ModelRegistry };
    expect((await service.list(emptyCtx)).summaries).toHaveLength(0);
    expect((await service.list(emptyCtx, { scope: "project" })).summaries.map((s) => s.id)).toEqual([first.id]);
    const q = await project();
    const qsm = q.session(["Other project decision"]);
    const second = (await service.create({ ...context(qsm), modelRegistry: model.registry })).summary;
    await rm(sm.getSessionFile()!);
    await rm(qsm.getSessionFile()!);
    expect((await service.list(emptyCtx, { scope: "all" })).summaries).toHaveLength(2);
    expect((await service.list(emptyCtx, { scope: "project", project: q.cwd })).summaries.map((s) => s.id)).toEqual([second.id]);
    expect(await service.store.get(first.id)).toEqual(first);
    const tool = createSummaryTool(service);
    expect((await tool.execute("read", { action: "read", id: second.id }, undefined, undefined, emptyCtx)).usage).toBeUndefined();
    expect(model.calls).toHaveLength(2);
  });

  test("stable pagination, bound cursors and invalid combinations", async () => {
    const { p, sm, ctx, service } = await setup();
    await service.create(ctx);
    p.user(sm, "Second");
    await service.create(ctx);
    const first = await service.list(ctx, { limit: 1 });
    expect(first.next).toBeString();
    p.user(sm, "Third");
    await service.create(ctx);
    const second = await service.list(ctx, { limit: 1, cursor: first.next! });
    expect(second.summaries[0]!.id).not.toBe(first.summaries[0]!.id);
    expect(second.next).toBeNull();
    await expect(service.list(ctx, { scope: "project", cursor: first.next! })).rejects.toThrow("cursor");
    await expect(service.list(ctx, { cursor: "garbage" })).rejects.toThrow("cursor");
    await expect(service.list(ctx, { limit: 0 })).rejects.toThrow("limit");
    await expect(service.list(ctx, { scope: "all", project: p.cwd })).rejects.toThrow("project");
    await expect(service.list(ctx, { scope: "project", sessionId: sm.getSessionId() })).rejects.toThrow("sessionId");
    await expect(service.create(ctx, { scope: "project", sessionId: sm.getSessionId() })).rejects.toThrow("sessionId");
    await expect(service.store.get("../../secrets")).rejects.toThrow("complete summary id");
  });
});

describe("concurrency and lifecycle", () => {
  test("one in-flight request across service instances, scopes and requesters; no queuing", async () => {
    const { ctx, service, store, p } = await setup();
    const started = deferred<void>();
    const finish = deferred<AssistantMessage>();
    ctx.modelRegistry = modelRegistry(async () => { started.resolve(); return finish.promise; }).registry;
    const first = service.create(ctx);
    await started.promise;
    const competing = new SummaryService(new SummaryStore(store.root));
    const otherSession = { ...context(p.session(["Another session"])), modelRegistry: modelRegistry().registry };
    await expect(competing.create(otherSession, { scope: "project" })).rejects.toThrow("already being generated");
    expect((await competing.list(ctx)).summaries).toHaveLength(0);
    finish.resolve(reply());
    await first;
    await expect(competing.create(ctx)).rejects.toThrow("No new");
  });

  test("project lock excludes another OS process", async () => {
    const { store, p } = await setup();
    await store.exclusive(p.cwd, undefined, async () => {
      const modulePath = new URL("./store.ts", import.meta.url).pathname;
      const script = `import {SummaryStore} from ${JSON.stringify(modulePath)}; const s=new SummaryStore(${JSON.stringify(store.root)}); try { await s.exclusive(${JSON.stringify(p.cwd)},undefined,async()=>{}); process.exit(1); } catch(e) { console.log(e.message); }`;
      const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stdout).text()).toContain("already being generated");
    });
    await store.exclusive(p.cwd, undefined, async () => {});
  });

  test("different projects can generate concurrently and stale locks from crashed processes recover", async () => {
    const { store, p, service, ctx } = await setup();
    const q = await project();
    const otherCtx = { ...context(q.session(["Other work"])), modelRegistry: modelRegistry().registry };
    await store.exclusive(p.cwd, undefined, async () => {
      expect((await service.create(otherCtx)).summary.project).toBe(q.cwd);
    });
    const stale = `${store.projectDir(p.cwd)}.lock`;
    await mkdir(stale);
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);
    await service.create(ctx);
    expect(await store.records()).toHaveLength(2);
  });

  test("shutdown cancels work, waits for cleanup, and does not store a late provider response", async () => {
    const { ctx, service, store } = await setup();
    const started = deferred<void>();
    const finish = deferred<AssistantMessage>();
    ctx.modelRegistry = modelRegistry(async () => { started.resolve(); return finish.promise; }).registry;
    const pending = service.create(ctx);
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await started.promise;
    const shuttingDown = service.shutdown();
    finish.resolve(reply());
    expect(String(await outcome)).toContain("Session closed");
    await shuttingDown;
    expect(await store.records()).toHaveLength(0);
    ctx.modelRegistry = modelRegistry().registry;
    await new SummaryService(store).create(ctx);
  });
});

describe("tool and slash command wiring", () => {
  test("extension registers recall_summary and /recall", () => {
    const f = fakePi();
    extension(f.pi);
    expect(f.tools.map((tool) => tool.name)).toContain(SUMMARY_TOOL);
    expect(f.commands.has("recall")).toBe(true);
  });

  test("tool validates arguments, returns schema-matching data and accounts for nested model usage once", async () => {
    const { ctx, service, model } = await setup();
    const tool = createSummaryTool(service);
    const created = await tool.execute("create", { action: "create" }, undefined, undefined, ctx);
    expect(created.usage).toEqual(usage);
    expect(Check(tool.outputSchema!, created.structuredContent)).toBe(true);
    const id = (created.structuredContent as unknown as { summary: StoredSummary }).summary.id;
    const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
    expect(Check(tool.outputSchema!, listed.structuredContent)).toBe(true);
    const read = await tool.execute("read", { action: "read", id }, undefined, undefined, ctx);
    expect(Check(tool.outputSchema!, read.structuredContent)).toBe(true);
    expect(read.usage).toBeUndefined();
    for (const params of [{ action: "create" as const, project: "all" }, { action: "create" as const, scope: "all" as const }, { action: "read" as const }, { action: "list" as const, id }]) {
      await expect(tool.execute("bad", params, undefined, undefined, ctx)).rejects.toThrow();
    }
    expect(model.calls).toHaveLength(1);
  });

  test("nested summary calls are excluded before the parent result is persisted, and after reload", async () => {
    const { p, sm, ctx, service, model } = await setup();
    await service.create(ctx);
    p.user(sm, "Summarise again using codemode");
    assistant(sm, "Preparing summary", [{ name: "codemode", id: "outer" }]);
    const f = fakePi(sm);
    registerSummaryActivity(f.pi, service);
    await f.emit("tool_call", { toolName: "codemode", toolCallId: "outer" }, ctx);
    await f.emit("tool_call", { toolName: SUMMARY_TOOL, toolCallId: "outer/1", parentToolCallId: "outer" }, ctx);
    await expect(service.create(ctx)).rejects.toThrow("No new");
    result(sm, "codemode", "outer");
    assistant(sm, "No changes to summarise");
    const reloaded = SessionManager.open(sm.getSessionFile()!);
    await expect(new SummaryService(service.store).create({ ...ctx, sessionManager: reloaded })).rejects.toThrow("No new");
    expect(model.calls).toHaveLength(1);
  });

  test("nested records from a completed wrapper also identify summary-only turns", async () => {
    const { sm, p } = await setup();
    const original = sm.getLeafId()!;
    p.user(sm, "Read a summary");
    assistant(sm, "", [{ name: "codemode", id: "outer" }]);
    sm.appendMessage({ role: "toolResult", toolName: "codemode", toolCallId: "outer", content: [], isError: false, timestamp: 0,
      nestedCalls: { complete: true, calls: [{ id: "outer/1", name: SUMMARY_TOOL, status: "ok" }] } });
    assistant(sm, "Here is the stored summary");
    expect(conversationSource(sm).messageIds).toEqual([original]);
  });

  test("duplicate entry ids in two source sessions remain distinct in prompts and checkpoints", async () => {
    const { p, sm, ctx, service, model } = await setup();
    const older = p.session(["A second session"]);
    const sameId = older.getLeafId()!;
    const originalBranch = sm.getBranch.bind(sm);
    sm.getBranch = () => originalBranch().map((entry) => entry.type === "message" ? { ...entry, id: sameId } : entry);
    const { summary } = await service.create(ctx, { scope: "project" });
    expect(summary.sources.every((source) => source.messageIds.includes(sameId))).toBe(true);
    const prompt = String(model.calls[0]!.messages[0]!.content);
    expect(prompt).toContain(`${sm.getSessionId()}/${sameId}`);
    expect(prompt).toContain(`${older.getSessionId()}/${sameId}`);
  });

  test("slash parser and autocomplete expose generation, listing and reading", async () => {
    expect(parseArgs("summary list all")).toEqual({ kind: "summary", args: "list all" });
    expect(parseSummaryArgs("")).toEqual({ action: "create", options: {} });
    expect(parseSummaryArgs("create project")).toEqual({ action: "create", options: { scope: "project" } });
    expect(parseSummaryArgs("create sid")).toEqual({ action: "create", options: { sessionId: "sid" } });
    expect(parseSummaryArgs("list session sid")).toEqual({ action: "list", options: { scope: "session", sessionId: "sid" } });
    expect(parseSummaryArgs("list project /a path/app")).toEqual({ action: "list", options: { scope: "project", project: "/a path/app" } });
    expect(parseSummaryArgs("read abc")).toEqual({ action: "read", id: "abc" });
    for (const invalid of ["create all", "read", "list all extra", "create a b", "unknown"]) expect(() => parseSummaryArgs(invalid)).toThrow();
    expect((await completions(undefined, "summary l"))!.map((item) => item.value)).toContain("summary list all");
  });

  test("/recall summary list routes without opening the history browser", async () => {
    const { ctx, service } = await setup();
    const f = fakePi();
    registerRecallCommand(f.pi, undefined, service);
    const notices: string[] = [];
    const commandCtx = { ...ctx, mode: "tui", ui: { notify: (text: string) => notices.push(text), custom: () => { throw new Error("Should not open history"); } } } as unknown as ExtensionCommandContext;
    await f.commands.get("recall").handler("summary list", commandCtx);
    expect(notices).toEqual(["No saved summaries for this scope"]);
  });

  test("Escape in the command loader aborts generation and leaves the scope retryable", async () => {
    initTheme("dark", false);
    const { ctx, service, store } = await setup();
    const started = deferred<void>();
    ctx.modelRegistry = modelRegistry(async (_input, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      started.resolve();
    })).registry;
    const commandCtx = { ...ctx, ui: {
      custom: (factory: any) => new Promise((resolve) => {
        const loader = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (result: unknown) => { loader.dispose(); resolve(result); });
        void started.promise.then(() => loader.handleInput("\u001b"));
      }),
    } } as unknown as ExtensionCommandContext;
    await expect(handleSummaryCommand("", commandCtx, service)).rejects.toThrow();
    expect(await store.records()).toHaveLength(0);
    ctx.modelRegistry = modelRegistry().registry;
    await service.create(ctx);
  });

  test("slash creation uses the same service guard and stores user origin without appending conversation", async () => {
    initTheme("dark", false);
    const { ctx, sm, service } = await setup();
    const originalEntries = sm.getEntries().length;
    let screens = 0;
    const commandCtx = { ...ctx, ui: {
      custom: async (factory: any) => {
        screens++;
        if (screens > 1) return undefined; // Saved summary viewer.
        return new Promise((resolve) => {
          const loader = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (result: unknown) => { loader.dispose(); resolve(result); });
        });
      },
    } } as unknown as ExtensionCommandContext;
    await handleSummaryCommand("", commandCtx, service);
    expect(screens).toBe(2);
    expect((await service.store.records())[0]!.requestedBy).toBe("user");
    expect(sm.getEntries()).toHaveLength(originalEntries);
    await expect(service.create(ctx)).rejects.toThrow("No new");
  });
});
