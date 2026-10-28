import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// For standalone checkouts, point PI_ADVISOR_SDK at Pi's installed dist/index.js.
const sdkPath = process.env.PI_ADVISOR_SDK || "@earendil-works/pi-coding-agent";
const sdk = await import(sdkPath);
const ai = await import(import.meta.resolve("@earendil-works/pi-ai", process.env.PI_ADVISOR_SDK || import.meta.url));
await mock.module("@earendil-works/pi-coding-agent", () => sdk);
await mock.module("@earendil-works/pi-ai", () => ai);
const advisor = (await import("./pi-advisor.ts")).default;

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text = "Consider the simpler option.", stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason, usage,
  api: "openai-completions", provider: "advisor-test", model: "test", timestamp: Date.now(),
});
let directory: string;
let oldDirectory: string | undefined;
let oldModel: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-advisor-test-"));
  oldDirectory = process.env.PI_CODING_AGENT_DIR;
  oldModel = process.env.PI_ADVISOR_MODEL;
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.PI_ADVISOR_MODEL;
});
afterEach(() => {
  if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDirectory;
  if (oldModel === undefined) delete process.env.PI_ADVISOR_MODEL;
  else process.env.PI_ADVISOR_MODEL = oldModel;
  rmSync(directory, { recursive: true, force: true });
});

function harness(settings: Record<string, unknown> = {}, flag?: string) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const flags = new Map<string, any>();
  const calls: any[] = [];
  const notifications: any[] = [];
  const statuses: any[] = [];
  let loaded = false;
  let authenticated = true;
  let known = true;
  let response: any = assistant();
  const ctx: any = {
    hasUI: true, mode: "tui", cwd: directory,
    ui: { notify: (...args: any[]) => notifications.push(args), setStatus: (...args: any[]) => statuses.push(args) },
    modelRegistry: {
      find: (provider: string, id: string) => known ? { provider, id, maxTokens: 2048 } : undefined,
      hasConfiguredAuth: () => authenticated,
      streamSimple: (...args: any[]) => {
        calls.push(args);
        return { result: async () => typeof response === "function" ? response(...args) : response };
      },
    },
  };
  advisor({
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerFlag: (name: string, definition: any) => flags.set(name, definition),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getSettings: () => { if (!loaded) throw new Error("Settings read before startup"); return settings; },
    getFlag: () => flag,
  } as any);
  loaded = true;
  return {
    ctx, calls, notifications, statuses, tools, flags, commands,
    start: () => handlers.get("session_start")?.({}, ctx),
    command: (args: string) => commands.get("advisor").handler(args, ctx),
    ask: (question = "Which approach?", context?: string, signal?: AbortSignal) => tools.get("ask_advisor").execute("call-1", { question, context }, signal, undefined, ctx),
    respond: (value: any) => { response = value; },
    auth: (value: boolean) => { authenticated = value; },
    known: (value: boolean) => { known = value; },
  };
}

test("registers flag, command, and valid tool schema even when unconfigured", async () => {
  const h = harness();
  h.start();
  expect(h.flags.get("advisor").type).toBe("string");
  expect(h.commands.has("advisor")).toBe(true);
  expect(h.tools.get("ask_advisor").parameters.required).toEqual(["question"]);
  expect(h.statuses.at(-1)).toEqual(["advisor", undefined]);
  await assert.rejects(h.ask(), /No advisor configured/);
});

describe("configuration precedence", () => {
  test("flag overrides environment and settings; model IDs may contain slashes", async () => {
    process.env.PI_ADVISOR_MODEL = "env/model";
    const h = harness({ advisorModel: "settings/model" }, "openrouter/vendor/model");
    h.start();
    await h.ask();
    expect(h.calls[0][0]).toMatchObject({ provider: "openrouter", id: "vendor/model" });
    expect(h.statuses.at(-1)[1]).toBe("Advisor: openrouter/vendor/model (enabled)");
  });
  test("environment overrides settings", async () => {
    process.env.PI_ADVISOR_MODEL = "env/model";
    const h = harness({ advisorModel: "settings/model" });
    h.start();
    expect((await h.ask()).details.model).toBe("env/model");
  });
  test("settings is the fallback and off disables lower priority sources", async () => {
    const h = harness({ advisorModel: "settings/model" });
    h.start();
    expect((await h.ask()).details.model).toBe("settings/model");
    const disabled = harness({ advisorModel: "settings/model" }, "off");
    disabled.start();
    await assert.rejects(disabled.ask(), /No advisor configured/);
  });
  test.each(["", "model", "/model", "provider/", "provider/model extra", "provider/\u001bmodel", 42])("rejects malformed configuration %j without falling back", async (value) => {
    const h = harness({ advisorModel: value });
    h.start();
    expect(h.statuses.at(-1)[1]).toContain("configuration error");
    await assert.rejects(h.ask());
    expect(h.calls).toHaveLength(0);
  });
});

test("commands parse the whole argument, preserve settings, and override startup until reload", async () => {
  const path = join(directory, "settings.json");
  writeFileSync(path, '\uFEFF{"theme":"dark","custom":{"keep":true}}');
  const h = harness({}, "old/model");
  h.start();
  await h.command("  openrouter/vendor/new-model  ");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark", custom: { keep: true }, advisorModel: "openrouter/vendor/new-model" });
  const reloaded = harness(sdk.SettingsManager.create(directory, directory).getSettings());
  reloaded.start();
  expect((await reloaded.ask()).details.model).toBe("openrouter/vendor/new-model");
  h.start();
  expect((await h.ask()).details.model).toBe("openrouter/vendor/new-model");
  await h.command("off");
  expect(JSON.parse(readFileSync(path, "utf8")).advisorModel).toBe("off");
  expect(h.statuses.at(-1)).toEqual(["advisor", undefined]);
  await assert.rejects(h.ask(), /No advisor configured/);
  expect(readdirSync(directory)).toEqual(["settings.json"]);
});

test("status and invalid commands do not write or replace a working selection", async () => {
  const h = harness({ advisorModel: "good/model" });
  h.start();
  await h.command("");
  await h.command("status");
  await h.command("bad");
  await h.command("provider/model extra");
  expect(readdirSync(directory)).toEqual([]);
  expect((await h.ask()).details.model).toBe("good/model");
  expect(h.notifications.at(-1)[1]).toBe("error");
});

test.each(["broken json", "[]", "null"])("does not overwrite malformed settings: %s", async (contents) => {
  const path = join(directory, "settings.json");
  writeFileSync(path, contents);
  const h = harness({ advisorModel: "good/model" });
  h.start();
  await h.command("new/model");
  expect(readFileSync(path, "utf8")).toBe(contents);
  expect((await h.ask()).details.model).toBe("good/model");
  expect(h.notifications.at(-1)[0]).toContain("Could not set advisor");
});

test("preserves settings symlinks and target permissions", async () => {
  const target = join(directory, "actual-settings.json");
  const path = join(directory, "settings.json");
  writeFileSync(target, '{"theme":"dark"}');
  chmodSync(target, 0o640);
  symlinkSync(target, path);
  const h = harness();
  h.start();
  await h.command("custom/model");
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(statSync(target).mode & 0o777).toBe(0o640);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ theme: "dark", advisorModel: "custom/model" });
  expect(readdirSync(directory).sort()).toEqual(["actual-settings.json", "settings.json"]);
});

test("does not overwrite locked settings or delete another writer's lock", async () => {
  const path = join(directory, "settings.json");
  writeFileSync(path, "{}");
  mkdirSync(`${path}.lock`);
  const h = harness({ advisorModel: "good/model" });
  h.start();
  await h.command("new/model");
  expect(readFileSync(path, "utf8")).toBe("{}");
  expect(statSync(`${path}.lock`).isDirectory()).toBe(true);
  expect((await h.ask()).details.model).toBe("good/model");
  expect(h.notifications.at(-1)[0]).toContain("locked");
});

test("does not replace dangling settings symlinks", async () => {
  const path = join(directory, "settings.json");
  symlinkSync(join(directory, "missing.json"), path);
  const h = harness();
  h.start();
  await h.command("custom/model");
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readdirSync(directory)).toEqual(["settings.json"]);
  await assert.rejects(h.ask(), /No advisor configured/);
});

test("unknown models and missing credentials fail before requests or settings writes", async () => {
  const h = harness({ advisorModel: "good/model" });
  h.known(false);
  h.start();
  await assert.rejects(h.ask(), /not found/);
  await h.command("missing/model");
  h.known(true);
  h.auth(false);
  h.start();
  await assert.rejects(h.ask(), /authentication/);
  await h.command("good/model");
  expect(readdirSync(directory)).toEqual([]);
  expect(h.calls).toHaveLength(0);
  h.auth(true);
  await h.command("good/model");
  expect((await h.ask()).isError).toBeUndefined();
  h.auth(false);
  await assert.rejects(h.ask(), /authentication/);
});

test("headless calls use configured registry, bounded output, cancellation signal, and isolated context", async () => {
  const h = harness({ advisorModel: "custom/model" });
  h.ctx.hasUI = false;
  h.ctx.mode = "print";
  h.ctx.ui = new Proxy({}, { get() { throw new Error("Headless UI access"); } });
  h.start();
  const signal = new AbortController().signal;
  h.respond({ ...assistant(), content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "First" }, { type: "text", text: "Second" }] });
  const result = await h.ask(" Evaluate this ", "Supplied facts", signal);
  expect(h.calls[0][0]).toMatchObject({ provider: "custom", id: "model" });
  expect(h.calls[0][1].messages).toHaveLength(1);
  expect(h.calls[0][1].messages[0].content).toBe("Question:\nEvaluate this\n\nContext:\nSupplied facts");
  expect(h.calls[0][1].tools).toBeUndefined();
  expect(h.calls[0][2]).toMatchObject({ signal, maxTokens: 2048, cacheRetention: "none", reasoning: "medium" });
  expect(result.content).toEqual([{ type: "text", text: "First\nSecond" }]);
  expect(result.usage).toEqual(usage);
  expect(result.details).toEqual({ model: "custom/model", stopReason: "stop" });
});

test.each(["error", "aborted", "length", "toolUse"])("marks %s responses as errors and retains usage", async (reason) => {
  const h = harness({ advisorModel: "custom/model" });
  h.start();
  h.respond({ ...assistant("Partial advice", reason), errorMessage: "Provider explanation" });
  const result = await h.ask();
  expect(result.isError).toBe(true);
  expect(result.usage).toEqual(usage);
  expect(result.content[0].text).toContain("Provider explanation");
  expect(result.content[0].text).not.toContain("Partial advice");
});

test("empty output and blank questions cannot be reported as successful advice", async () => {
  const h = harness({ advisorModel: "custom/model" });
  h.start();
  await assert.rejects(h.ask(" \n "), /must not be empty/);
  expect(h.calls).toHaveLength(0);
  h.respond(assistant(" "));
  expect((await h.ask()).isError).toBe(true);
});

test("propagates thrown provider errors and cancellation before and during requests", async () => {
  const h = harness({ advisorModel: "custom/model" });
  h.start();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.ask("Question", undefined, controller.signal));
  expect(h.calls).toHaveLength(0);
  h.respond(() => { throw new Error("Network unavailable"); });
  await assert.rejects(h.ask(), /Network unavailable/);
  const active = new AbortController();
  h.respond(() => { active.abort(); return assistant(); });
  await assert.rejects(h.ask("Question", undefined, active.signal));
});

test("in-flight requests keep their selected model when the advisor is disabled", async () => {
  const h = harness({ advisorModel: "custom/model" });
  h.start();
  let finish!: (result: any) => void;
  h.respond(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.ask();
  await h.command("off");
  finish(assistant());
  expect((await pending).details.model).toBe("custom/model");
  await assert.rejects(h.ask(), /No advisor configured/);
});

test("real Pi file loader and tool lifecycle call an authenticated offline advisor and account for usage", async () => {
  const runtime = await sdk.ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  const calls: any[] = [];
  runtime.registerProvider("advisor-test", {
    api: "openai-completions", baseUrl: "https://unused.invalid", apiKey: "fake-test-key",
    models: ["main", "test"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple: (model: any, context: any) => {
      calls.push({ model: model.id, context });
      const response = model.id === "test" ? assistant("Use the simpler option.") : calls.length === 1
        ? { ...assistant("", "toolUse"), model: "main", content: [{ type: "toolCall", id: "ask-1", name: "ask_advisor", arguments: { question: "Which option?", context: "One is simpler." } }] }
        : { ...assistant("I recommend the simpler option."), model: "main" };
      const stream = ai.createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...response, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: response.stopReason, message: response });
      stream.end();
      return stream;
    },
  });
  const settings = sdk.SettingsManager.inMemory({ advisorModel: "advisor-test/test", compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(import.meta.dir, "pi-advisor.ts")], systemPrompt: "Ask the advisor." });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
    model: runtime.getModel("advisor-test", "main"), resourceLoader: loader, settingsManager: settings,
    sessionManager: sdk.SessionManager.inMemory(directory), tools: ["ask_advisor"], thinkingLevel: "off" });
  const errors: any[] = [];
  try {
    await session.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error) });
    await session.prompt("Help choose. Private transcript text not passed to advisor.");
    expect(errors).toEqual([]);
    const result = session.sessionManager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "toolResult").message;
    expect(result.content).toEqual([{ type: "text", text: "Use the simpler option." }]);
    expect(calls.map((call) => call.model)).toEqual(["main", "test", "main"]);
    expect(JSON.stringify(calls[1].context)).not.toContain("Private transcript");
    expect(calls[1].context.tools).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.usage.totalTokens).toBe(30);
    expect(session.getLastAssistantText()).toBe("I recommend the simpler option.");
    expect(session.isIdle).toBe(true);
  } finally { session.dispose(); }
}, 20000);
