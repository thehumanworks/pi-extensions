import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { allowedSkill, matchTools } from "../index.ts";
import { createBot, loadBot } from "../src/bots.ts";
import { invocations, persona, tempRoot, useFakePi } from "./helpers.ts";

const models = [
  { provider: "openai", id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
  { provider: "claude-bridge", id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];
const registry = {
  getAll: () => models, getAvailable: () => models,
  find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
};
const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "bot_manage", "bot_run"];

function fixture(flag?: string) {
  const tools: Record<string, any> = {}, commands: Record<string, any> = {}, events: Record<string, any> = {};
  const calls = { models: [] as unknown[], thinking: [] as string[], flags: [] as Array<{ name: string; description: string }> };
  let active = ["read", "bash", "edit", "write", "bot_manage", "bot_run"];
  const pi = {
    registerFlag: (name: string, options: { description: string }) => { calls.flags.push({ name, ...options }); },
    getFlag: (name: string) => name === "bot" ? flag : undefined,
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    on: (name: string, handler: any) => { events[name] = handler; },
    setModel: async (model: unknown) => { calls.models.push(model); return true; },
    setThinkingLevel: (level: string) => { calls.thinking.push(level); },
    getAllTools: () => ALL_TOOLS.map(name => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    getSettings: () => ({}),
  };
  extension(pi as unknown as ExtensionAPI);
  return { tools, commands, events, calls, active: () => active };
}

function context(options: { sessionManager?: SessionManager; sessionFile?: string; sessionDir?: string; entries?: unknown[]; cwd?: string; selections?: number[] } = {}) {
  const notices: Array<[string, string | undefined]> = [], status: Array<[string, string | undefined]> = [], switched: string[] = [];
  const selections = [...(options.selections ?? [])];
  const ui = {
    notify: (message: string, level?: string) => { notices.push([message, level]); },
    setStatus: (key: string, value?: string) => { status.push([key, value]); },
    select: async (_title: string, items: string[]) => items[selections.shift() ?? 0],
    confirm: async () => true,
    input: async () => undefined,
    editor: async () => undefined,
  };
  const ctx = {
    cwd: options.cwd ?? process.cwd(), hasUI: true, mode: "tui", model: models[1], modelRegistry: registry, ui,
    sessionManager: options.sessionManager ?? {
      getSessionFile: () => options.sessionFile,
      getSessionDir: () => options.sessionDir ?? (options.sessionFile ? dirname(options.sessionFile) : ""),
      getEntries: () => options.entries ?? [],
    },
    switchSession: async (path: string, opts?: { withSession?: (next: unknown) => Promise<void> }) => {
      switched.push(path);
      await opts?.withSession?.({ ui });
      return { cancelled: false };
    },
  };
  return { ctx, notices, status, switched };
}

async function reviewer(t: TestContext, extra: Partial<Parameters<typeof createBot>[0]> = {}) {
  const root = await tempRoot(t);
  const bot = await createBot({ name: "reviewer", description: "Reviews diffs", prompt: persona, model: "openai/gpt-6.1-sol", thinking: "high", ...extra });
  return { root, bot, sessionFile: join(bot.home, "sessions", "2026-10-25T00-00-00-000Z_x.jsonl") };
}

async function startBot(f: ReturnType<typeof fixture>, sessionFile: string, entries: unknown[] = []) {
  const c = context({ sessionFile, entries });
  await f.events.session_start({ type: "session_start", reason: "startup" }, c.ctx);
  return c;
}

test("registers the flag, tools, command and lifecycle handlers", () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.tools).sort(), ["bot_manage", "bot_run"]);
  assert.ok(f.commands.bot);
  for (const name of ["session_start", "resources_discover", "before_agent_start", "tool_call"]) assert.ok(f.events[name], name);
});

test("bot_manage creates, lists, shows and edits bots with validated settings", async t => {
  await tempRoot(t);
  const f = fixture(), { ctx } = context();
  const run = (params: Record<string, unknown>) => f.tools.bot_manage.execute("id", params, undefined, undefined, ctx);
  const created = await run({ action: "create", name: "scout", description: "Maps codebases", prompt: persona, model: "gpt-6.1-sol", thinking: "low", tools: ["read", "grep"] });
  assert.match(created.content[0].text, /Created bot scout/);
  const bot = await loadBot("scout");
  assert.equal(bot.model, "openai/gpt-6.1-sol");
  assert.deepEqual(bot.tools, ["read", "grep"]);
  await assert.rejects(run({ action: "create", name: "bad", description: "x", prompt: "y", model: "nope-9000" }), /Unknown or ambiguous model/);
  await assert.rejects(run({ action: "create", name: "bad", description: "x", prompt: "y", thinking: "loud" }), /Invalid thinking level/);
  await assert.rejects(run({ action: "show" }), /requires a bot name/);
  assert.match((await run({ action: "list" })).content[0].text, /- scout: Maps codebases \(model: openai\/gpt-6\.1-sol, thinking: low\)/);
  assert.match((await run({ action: "show", name: "scout" })).content[0].text, /home: .*scout[\s\S]*BOT\.md:\n---\nname: scout/);
  const edited = await run({ action: "edit", name: "scout", thinking: "inherit", tools: [] });
  assert.match(edited.content[0].text, /^Edited bot scout\.[\s\S]*apply to its new conversations\.$/);
  const updated = await loadBot("scout");
  assert.equal(updated.thinking, undefined);
  assert.equal(updated.tools, undefined);
  assert.equal(updated.model, "openai/gpt-6.1-sol");
});

test("bot_manage edit supports targeted persona edits and full definitions, but never deletion", async t => {
  await tempRoot(t);
  const f = fixture(), { ctx } = context();
  const run = (params: Record<string, unknown>) => f.tools.bot_manage.execute("id", params, undefined, undefined, ctx);
  await run({ action: "create", name: "scout", description: "Maps codebases", prompt: persona });
  await run({ action: "edit", name: "scout", edits: [{ oldText: "Be direct.", newText: "Be direct. Always cite file:line." }] });
  assert.match((await loadBot("scout")).prompt, /Be direct\. Always cite file:line\.$/);
  await assert.rejects(run({ action: "edit", name: "scout", edits: [{ oldText: "absent", newText: "x" }] }), /not found in the persona/);
  await assert.rejects(run({ action: "edit", name: "scout" }), /needs at least one change/);

  const definition = "---\ndescription: Maps codebases fast\nthinking: minimal\ncolor: green\n---\n\nRewritten persona.\n";
  await assert.rejects(run({ action: "edit", name: "scout", definition, thinking: "low" }), /do not combine it with thinking/);
  await assert.rejects(run({ action: "edit", name: "scout", definition: definition.replace("thinking: minimal", "model: nope/zzz") }), /BOT\.md was not changed/);
  assert.match((await loadBot("scout")).prompt, /cite file:line/);
  await run({ action: "edit", name: "scout", definition });
  const rewritten = await loadBot("scout");
  assert.deepEqual([rewritten.description, rewritten.thinking, rewritten.prompt, rewritten.extra], ["Maps codebases fast", "minimal", "Rewritten persona.", { color: "green" }]);
  await assert.rejects(run({ action: "create", name: "other", description: "x", prompt: "y", definition }), /edits and definition are for edit/);

  const warned = await run({ action: "edit", name: "scout", tools: ["read", "websearch", "mcp__*"] });
  assert.match(warned.content[0].text, /Warning: no loaded tool is named websearch;/);
  const actions = f.tools.bot_manage.parameters.properties.action.anyOf.map((option: { const: string }) => option.const);
  assert.deepEqual(actions, ["list", "show", "create", "edit"]);
});

test("a session stored in a bot's home activates its model, thinking and tools", async t => {
  const { sessionFile } = await reviewer(t, { tools: ["read", "grep"] });
  const f = fixture();
  const c = await startBot(f, sessionFile);
  assert.deepEqual(f.calls.models, [models[0]]);
  assert.deepEqual(f.calls.thinking, ["high"]);
  assert.deepEqual(f.active(), ["read", "grep", "write", "edit", "bot_manage"]);
  assert.deepEqual(c.status.at(-1), ["pi-bot", "bot: reviewer"]);
});

test("resumed conversations keep their model; unknown models only warn", async t => {
  const { sessionFile } = await reviewer(t, { model: "missing/model" });
  const f = fixture();
  await startBot(f, sessionFile, [{ type: "message", message: { role: "user", content: "hi" } }]);
  assert.deepEqual(f.calls.models, []);
  const g = fixture();
  const c = await startBot(g, sessionFile);
  assert.deepEqual(g.calls.models, []);
  assert.match(c.notices[0]![0], /model "missing\/model" was not found/);
});

test("--bot stores startup history in the bot's home without changing cwd", async t => {
  const { root, bot } = await reviewer(t);
  const sessions = SessionManager.create(root, join(root, "ordinary"));
  const original = sessions.getSessionFile()!;
  const id = sessions.getSessionId();
  sessions.appendSessionInfo("Review the API");
  const f = fixture("reviewer");
  const startup = context({ sessionManager: sessions, cwd: root });
  await f.events.session_start({ type: "session_start", reason: "startup" }, startup.ctx);
  assert.deepEqual(startup.status.at(-1), ["pi-bot", "bot: reviewer"]);
  assert.ok(!startup.notices.some(([, level]) => level === "warning"));
  assert.equal(sessions.getSessionDir(), join(bot.home, "sessions"));
  assert.equal(dirname(sessions.getSessionFile()!), sessions.getSessionDir());
  assert.equal(sessions.getCwd(), root);
  assert.equal(sessions.getSessionId(), id);
  assert.equal(sessions.getSessionName(), "Review the API");
  sessions.appendMessage({ role: "user", content: "Review this", timestamp: Date.now() });
  assert.match(readFileSync(sessions.getSessionFile()!, "utf8"), /Review this/);
  assert.ok(!existsSync(original));
  assert.equal(f.events.input({ type: "input" }, startup.ctx), undefined);
});

test("--bot selects the requested startup bot even when opening another bot's history", async t => {
  const { root, bot } = await reviewer(t);
  const other = await createBot({ name: "scout", description: "Maps codebases", prompt: persona });
  const sessions = SessionManager.create(root, join(other.home, "sessions"));
  sessions.appendMessage({ role: "user", content: "Prior work", timestamp: Date.now() });
  const original = sessions.getSessionFile()!;
  const f = fixture("reviewer"), c = context({ sessionManager: sessions, cwd: root });
  await f.events.session_start({ type: "session_start", reason: "startup" }, c.ctx);
  assert.equal(dirname(sessions.getSessionFile()!), join(bot.home, "sessions"));
  assert.ok(existsSync(original));
  assert.deepEqual(c.status.at(-1), ["pi-bot", "bot: reviewer"]);
});

test("session switches and reloads follow storage, not the startup --bot flag", async t => {
  const { sessionFile } = await reviewer(t);
  const f = fixture("reviewer");
  const bot = context({ sessionFile });
  await f.events.session_start({ type: "session_start", reason: "reload" }, bot.ctx);
  assert.deepEqual(bot.status.at(-1), ["pi-bot", "bot: reviewer"]);
  for (const reason of ["new", "resume", "reload"]) {
    const ordinary = context({ sessionFile: "/tmp/ordinary/s.jsonl" });
    await f.events.session_start({ type: "session_start", reason }, ordinary.ctx);
    assert.deepEqual(ordinary.status.at(-1), ["pi-bot", undefined]);
  }
});

test("storage failures block prompts instead of falling back to ordinary storage", async t => {
  const { root, bot } = await reviewer(t);
  const sessions = SessionManager.create(root, join(root, "ordinary"));
  const original = sessions.getSessionFile()!;
  // Make the destination unusable without relying on filesystem permissions (tests may run as root).
  await rm(join(bot.home, "sessions"), { recursive: true });
  await writeFile(join(bot.home, "sessions"), "not a directory");
  const f = fixture("reviewer"), c = context({ sessionManager: sessions });
  await f.events.session_start({ type: "session_start", reason: "startup" }, c.ctx);
  assert.match(c.notices[0]![0], /Cannot start bot reviewer/);
  assert.deepEqual(f.events.input({ type: "input" }, c.ctx), { action: "handled" });
  assert.equal(sessions.getSessionFile(), original);
  assert.ok(!existsSync(original));
  assert.deepEqual(f.calls.models, []);
});

test("a missing definition is reported instead of activating", async t => {
  const root = await tempRoot(t);
  const f = fixture();
  const c = await startBot(f, join(root, "ghost", "sessions", "s.jsonl"));
  assert.match(c.notices[0]![0], /Unknown bot "ghost"/);
});

test("before_agent_start adds the persona sections and filters skills, without listing other bots", async t => {
  const { bot, sessionFile } = await reviewer(t, { skills: ["allowed"] });
  await createBot({ name: "scout", description: "Maps codebases", prompt: persona });
  const f = fixture();
  const c = await startBot(f, sessionFile);
  const own = { name: "own", filePath: join(bot.home, "skills", "own", "SKILL.md") };
  const options = { sections: {} as Record<string, string>, skills: [{ name: "allowed", filePath: "/s/allowed/SKILL.md" }, { name: "other", filePath: "/s/other/SKILL.md" }, own] };
  await f.events.before_agent_start({ type: "before_agent_start", systemPromptOptions: options }, c.ctx);
  assert.deepEqual(Object.keys(options.sections), ["bot", "bot_home", "bot_memory", "bot_state"]);
  assert.match(options.sections.bot_home!, new RegExp(`Home: ${bot.home}`));
  assert.deepEqual(options.skills.map(skill => skill.name), ["allowed", "own"]);
});

// Creating a bot elsewhere must not change a running session's system prompt.
test("ordinary sessions get no prompt sections, even when bots exist", async t => {
  await reviewer(t);
  const f = fixture(), c = context({ sessionFile: "/tmp/normal/s.jsonl" });
  await f.events.session_start({ type: "session_start", reason: "startup" }, c.ctx);
  const options = { sections: {} as Record<string, string>, skills: [] };
  await f.events.before_agent_start({ type: "before_agent_start", systemPromptOptions: options }, c.ctx);
  assert.deepEqual(Object.keys(options.sections), []);
  assert.equal(f.events.resources_discover({ type: "resources_discover" }, c.ctx), undefined);
});

test("tools added for home upkeep are confined to the home; allowlisted tools are not", async t => {
  const { bot, sessionFile } = await reviewer(t, { tools: ["read", "bash"] });
  const f = fixture();
  const c = await startBot(f, sessionFile);
  const call = (toolName: string, input: Record<string, unknown>) => f.events.tool_call({ type: "tool_call", toolName, toolCallId: "1", input }, c.ctx);
  assert.equal(call("write", { path: join(bot.home, "memory", "new.md"), content: "x" }), undefined);
  assert.equal(call("edit", { path: "~/../../etc/passwd", edits: [] })?.block, true);
  assert.match(call("write", { path: "src/app.ts", content: "x" }).reason, /only inside its home/);
  assert.equal(call("read", { path: "/etc/hosts" }), undefined);
  assert.equal(call("bash", { command: "ls" }), undefined);
  assert.deepEqual(f.events.resources_discover({ type: "resources_discover" }, c.ctx), { skillPaths: [join(bot.home, "skills")] });
});

test("/bot <name> starts a conversation stored in the bot's home", async t => {
  const { bot } = await reviewer(t);
  const f = fixture(), c = context();
  await f.commands.bot.handler("reviewer", c.ctx);
  assert.equal(c.switched.length, 1);
  assert.equal(dirname(c.switched[0]!), join(bot.home, "sessions"));
  assert.match(c.notices.at(-1)![0], /Talking to reviewer/);
  await f.commands.bot.handler("nobody", c.ctx);
  assert.match(c.notices.at(-1)![0], /Unknown bot "nobody"/);
});

test("/bot resume forks a conversation from another directory into this one", async t => {
  const { root, bot } = await reviewer(t);
  const original = SessionManager.create(root, join(bot.home, "sessions"));
  original.appendMessage({ role: "user", content: "audit the API", timestamp: Date.now() });
  const f = fixture(), c = context({ cwd: process.cwd() });
  await f.commands.bot.handler("resume reviewer", c.ctx);
  const forked = c.switched[0]!;
  assert.notEqual(forked, original.getSessionFile());
  assert.equal(dirname(forked), join(bot.home, "sessions"));
  const header = JSON.parse(readFileSync(forked, "utf8").split("\n")[0]!);
  assert.equal(header.cwd, process.cwd());
  assert.equal(header.parentSession, original.getSessionFile());
  // The fork is now the newest entry; pick the original, then "Open in its original directory".
  const g = context({ cwd: process.cwd(), selections: [1, 1] });
  await f.commands.bot.handler("resume reviewer", g.ctx);
  assert.equal(g.switched[0], original.getSessionFile());
});

test("/bot exit returns to an ordinary session; delete archives other bots only", async t => {
  const { root, sessionFile } = await reviewer(t);
  await createBot({ name: "scout", description: "Maps codebases", prompt: persona });
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-bot-sessions-"));
  const saved = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
  t.after(async () => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = saved;
    await rm(sessionsDir, { recursive: true, force: true });
  });
  const f = fixture();
  const c = await startBot(f, sessionFile);
  await f.commands.bot.handler("delete reviewer", c.ctx);
  assert.match(c.notices.at(-1)![0], /Leave reviewer first/);
  await f.commands.bot.handler("delete scout", c.ctx);
  assert.match(c.notices.at(-1)![0], /Archived scout/);
  assert.ok(!existsSync(join(root, "scout")));
  await f.commands.bot.handler("exit", c.ctx);
  assert.equal(dirname(c.switched.at(-1)!), sessionsDir);
});

test("/bot help and completions", async t => {
  await reviewer(t);
  const f = fixture(), c = context();
  await f.commands.bot.handler("help", c.ctx);
  assert.match(c.notices[0]![0], /\/bot resume \[name\]/);
  assert.match(c.notices[0]![0], /From a shell: pi --bot <name>/);
  assert.equal(f.calls.flags[0]!.description, "Run as this bot, saving conversation history in its home");
  const values = (items: Array<{ value: string }> | null) => items?.map(item => item.value);
  assert.deepEqual(values(await f.commands.bot.getArgumentCompletions("re")), ["resume", "reviewer"]);
  assert.deepEqual(values(await f.commands.bot.getArgumentCompletions("edit r")), ["edit reviewer"]);
  assert.equal(await f.commands.bot.getArgumentCompletions("zzz"), null);
});

test("bot_run delegates through a child Pi and resumes or forks earlier sessions", async t => {
  const { root, bot } = await reviewer(t);
  const log = await useFakePi(t);
  const f = fixture(), c = context();
  const run = (params: Record<string, unknown>) => f.tools.bot_run.execute("id", params, undefined, undefined, c.ctx);
  const result = await run({ bot: "reviewer", task: "Review the diff" });
  assert.match(result.content[0].text, /^Done: Review the diff\n\n\[reviewer · session s-1 · 2 turns · fake\/m1\]/);
  assert.equal(result.isError, undefined);
  assert.equal(result.usage.totalTokens, 36);
  const here = SessionManager.create(process.cwd(), join(bot.home, "sessions"));
  here.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
  await run({ bot: "reviewer", task: "Continue", session: "last" });
  const away = SessionManager.create(root, join(bot.home, "sessions"));
  away.appendMessage({ role: "user", content: "elsewhere", timestamp: Date.now() });
  await run({ bot: "reviewer", task: "Continue there", session: away.getSessionId() });
  const calls = invocations(log);
  assert.deepEqual(calls[0]!.args.slice(3, 7), ["--session-dir", join(bot.home, "sessions"), "--bot", "reviewer"]);
  assert.ok(!calls[0]!.args.includes("--session"));
  assert.deepEqual(calls[1]!.args.slice(9, 11), ["--session", here.getSessionFile()]);
  assert.deepEqual(calls[2]!.args.slice(9, 11), ["--fork", away.getSessionFile()]);
  await assert.rejects(run({ bot: "reviewer", task: "x", session: "no-such-id" }), /has no session "no-such-id"/);
});

test("bot_run refuses runaway nesting and reports failures as errors", async t => {
  await reviewer(t);
  await useFakePi(t, "error");
  const f = fixture(), c = context();
  const run = (params: Record<string, unknown>) => f.tools.bot_run.execute("id", params, undefined, undefined, c.ctx);
  const failure = await run({ bot: "reviewer", task: "x" });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /Bot reviewer failed \(error\): Rate limited/);
  const saved = process.env.PI_BOT_DEPTH;
  process.env.PI_BOT_DEPTH = "3";
  t.after(() => { if (saved === undefined) delete process.env.PI_BOT_DEPTH; else process.env.PI_BOT_DEPTH = saved; });
  await assert.rejects(run({ bot: "reviewer", task: "x" }), /already 3 levels deep/);
});

test("tool patterns and skill allowlists", async t => {
  assert.deepEqual(matchTools(["read", "mcp__docs__*", "nope"], ["read", "mcp__docs__a", "mcp__docs__b", "bash"]), { selected: ["read", "mcp__docs__a", "mcp__docs__b"], unknown: ["nope"] });
  const { bot } = await reviewer(t, { skills: ["~/team-skills", "lint"] });
  const cwd = process.cwd();
  assert.ok(allowedSkill({ name: "lint", filePath: "/x/lint/SKILL.md" }, bot, cwd));
  assert.ok(allowedSkill({ name: "any", filePath: join(process.env.HOME!, "team-skills", "any", "SKILL.md") }, bot, cwd));
  assert.ok(!allowedSkill({ name: "other", filePath: "/x/other/SKILL.md" }, bot, cwd));
  assert.ok(allowedSkill({ name: "other", filePath: "/x/other/SKILL.md" }, { ...bot, skills: undefined }, cwd));
});
