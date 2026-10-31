import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { botAt, createBot, listBots, loadBot, sessionFile } from "../index.ts";

const execAsync = promisify(execFile);
/** Pi reads piped stdin into its first prompt, so close it. */
const run: typeof execAsync = ((...args: Parameters<typeof execAsync>) => {
  const promise = execAsync(...args);
  promise.child.stdin?.end();
  return promise;
}) as typeof execAsync;
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const faux = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux"));

/**
 * A Pi user directory whose faux model reports what it was given: whether its current system prompt
 * preamble is the bot persona, and whether the prompt has the bot section and a marker from the bot's
 * own extension. "delegate" calls bot_run and "reload" calls bot_reload.
 */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-bot-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), bots = join(root, "bots"), workspace = join(root, "workspace");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", retry: { enabled: false } }));
  await writeFile(join(agentDir, "mcp.json"), '{"mcpServers":{}}');
  // Pi checks an extension provider's auth asynchronously unless it has a stored credential, and its
  // startup model choice can run first. A stored key makes the faux model the deterministic default.
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "test" } }));
  await writeFile(join(agentDir, "extensions/faux.ts"), `import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall as call } from ${JSON.stringify(faux)};
const text = message => typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("");
export default pi => {
  const provider = fauxProvider({ tokensPerSecond: 100000 });
  const reply = context => {
    const all = JSON.stringify(context.messages), last = context.messages.at(-1);
    // Pi sends prompt changes as later system messages carrying only the changed sections.
    const preamble = context.messages.filter(m => m.role === "system" && m.sections?.preamble).at(-1)?.sections.preamble ?? "";
    if (last.role === "toolResult") return answer("parent got: " + text(last));
    if (text(last).startsWith("delegate")) return answer(call("bot_run", { bot: "tester", task: "child task" }), { stopReason: "toolUse" });
    if (text(last).startsWith("reload")) return answer(call("bot_reload", {}), { stopReason: "toolUse" });
    return answer("reply to " + text(last) + ": persona=" + preamble.includes("PERSONA-MARK") + " section=" + all.includes("You are the bot") + " home-extension=" + all.includes("HOME-EXTENSION-MARK"));
  };
  provider.setResponses(Array.from({ length: 20 }, () => reply));
  pi.registerProvider(provider.provider);
};`);
  // No inherited provider credentials: if the faux model were missed, Pi must fail rather than call a real model.
  const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_BOT_HOME: bots, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
  process.env.PI_BOT_HOME = bots;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const bot = await createBot("tester", "Tests things", "You are tester. PERSONA-MARK");
  return { root, agentDir, bots, workspace, env, bot };
}

const events = (stdout: string) => stdout.trim().split("\n").map(line => JSON.parse(line));
const replies = (records: any[]) => records.filter(e => e.type === "message_end" && e.message.role === "assistant").map(e => e.message.content.map((p: any) => p.text ?? "").join(""));

test("bots are directories with a BOT.md; old SDK definitions still load", async t => {
  const f = await fixture(t);
  assert.equal(f.bot.home, join(f.bots, "tester"));
  assert.equal(f.bot.prompt, "You are tester. PERSONA-MARK");
  assert.equal(botAt(f.bot.home), "tester");
  assert.equal(botAt(f.workspace), undefined);
  assert.equal(botAt(f.bots), undefined);
  await assert.rejects(createBot("tester", "Again", "x"), /already exists/);
  await assert.rejects(createBot("list", "Reserved", "x"), /cannot be a bot name/);
  await assert.rejects(createBot("Bad/Name", "x", "x"), /cannot be a bot name/);
  await mkdir(join(f.bots, "legacy"));
  await writeFile(join(f.bots, "legacy/BOT.md"), `---\n"format": 2\n"name": "legacy"\n"description": "Old format"\n"tools": ["read"]\n---\n\nLegacy persona.\n`);
  assert.deepEqual((await listBots()).bots.map(bot => [bot.name, bot.description]), [["legacy", "Old format"], ["tester", "Tests things"]]);
  await assert.rejects(loadBot("missing"), /No bot named "missing"/);
});

test("a new bot session's file records the bot's home as its cwd before Pi writes it", async t => {
  const f = await fixture(t);
  const file = await sessionFile(f.bot.home, false);
  const header = JSON.parse((await readFile(file, "utf8")).trim());
  assert.equal(header.type, "session");
  assert.equal(header.cwd, f.bot.home);
  assert.equal(await sessionFile(f.bot.home, true), file, "continuing picks the latest session");
});

test("Pi running in a bot's home uses BOT.md as the system prompt and trusts the home's .pi resources", async t => {
  const f = await fixture(t);
  await mkdir(join(f.bot.home, ".pi/extensions"), { recursive: true });
  await writeFile(join(f.bot.home, ".pi/extensions/marker.ts"), `export default pi => pi.on("before_agent_start", event => { event.systemPromptOptions.sections.marker = "HOME-EXTENSION-MARK"; });`);
  const { stdout } = await run(process.execPath, [cli, "-e", extension, "--mode", "json", "hello"], { cwd: f.bot.home, env: f.env, timeout: 30_000 });
  const records = events(stdout);
  assert.equal(records[0].cwd, f.bot.home);
  assert.deepEqual(replies(records), ["reply to hello: persona=true section=true home-extension=true"]);
  // An ordinary directory gets no bot prompt.
  const plain = await run(process.execPath, [cli, "-e", extension, "--mode", "json", "hello"], { cwd: f.workspace, env: f.env, timeout: 30_000 });
  assert.deepEqual(replies(events(plain.stdout)), ["reply to hello: persona=false section=false home-extension=false"]);
});

test("--bot in print mode outside the home fails without reaching the model", async t => {
  const f = await fixture(t);
  await assert.rejects(run(process.execPath, [cli, "-e", extension, "--bot", "tester", "-p", "hello"], { cwd: f.workspace, env: f.env, timeout: 30_000 }), (error: any) => {
    assert.match(error.stderr, /Run it from there: cd .*tester/);
    assert.doesNotMatch(error.stdout, /reply to/);
    return true;
  });
  await assert.rejects(run(process.execPath, [cli, "-e", extension, "--bot", "missing", "-p", "hello"], { cwd: f.workspace, env: f.env, timeout: 30_000 }), /No bot named "missing"/);
});

/** A Pi RPC process; `next` waits for a record matching the predicate. */
function rpc(t: TestContext, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(process.execPath, [cli, "-e", extension, "--mode", "rpc", ...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  const records: any[] = [];
  let buffer = "", stderr = "";
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(index + 1)) records.push(JSON.parse(buffer.slice(0, index)));
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  let seen = 0;
  return {
    kill: () => child.kill("SIGKILL"),
    send: (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`),
    async next(predicate: (record: any) => boolean): Promise<any> {
      const end = Date.now() + 20_000;
      for (;;) {
        const index = records.findIndex((record, i) => i >= seen && predicate(record));
        if (index >= 0) { seen = index + 1; return records[index]; }
        if (Date.now() > end) throw new Error(`Timed out. stderr: ${stderr}\nrecords: ${JSON.stringify(records)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
  };
}
const reply = (record: any) => record.type === "message_end" && record.message.role === "assistant";
const state = (record: any) => record.type === "response" && record.command === "get_state";

test("pi --bot starts a native session in the bot's home and keeps the first prompt", async t => {
  const f = await fixture(t);
  const pi = rpc(t, ["--bot", "tester"], { cwd: f.workspace, env: f.env });
  pi.send({ type: "prompt", message: "hello" });
  const answer = await pi.next(reply);
  assert.equal(answer.message.content[0].text, "reply to hello: persona=true section=true home-extension=false");
  pi.send({ type: "get_state" });
  const { data } = await pi.next(state);
  const header = JSON.parse((await readFile(data.sessionFile, "utf8")).split("\n")[0]);
  assert.equal(header.cwd, f.bot.home);
});

test("pi --bot continues the bot's latest conversation, and /new starts a fresh one in the home", async t => {
  const f = await fixture(t);
  const header = async (file: string) => JSON.parse((await readFile(file, "utf8")).split("\n")[0]);
  const first = rpc(t, ["--bot", "tester"], { cwd: f.workspace, env: f.env });
  first.send({ type: "prompt", message: "one" });
  await first.next(reply);
  first.send({ type: "get_state" });
  const file = (await first.next(state)).data.sessionFile;
  first.kill();
  // Started inside the home this time: Pi opens a fresh session there, and --bot still continues.
  const second = rpc(t, ["--bot", "tester"], { cwd: f.bot.home, env: f.env });
  second.send({ type: "prompt", message: "two" });
  await second.next(reply);
  second.send({ type: "get_state" });
  assert.equal((await second.next(state)).data.sessionFile, file);
  const users = (await readFile(file, "utf8")).split("\n").filter(line => line.includes('"role":"user"'));
  assert.equal(users.length, 2, "both prompts are in one conversation");
  second.send({ type: "new_session" });
  await second.next(record => record.type === "response" && record.command === "new_session");
  second.send({ type: "prompt", message: "three" });
  assert.equal((await second.next(reply)).message.content[0].text, "reply to three: persona=true section=true home-extension=false");
  second.send({ type: "get_state" });
  const fresh = (await second.next(state)).data.sessionFile;
  assert.notEqual(fresh, file);
  assert.equal((await header(fresh)).cwd, f.bot.home);
});

test("/bot <name> moves a running session into the bot's home, and /bot exit moves it back", async t => {
  const f = await fixture(t);
  const pi = rpc(t, [], { cwd: f.workspace, env: f.env });
  pi.send({ type: "prompt", message: "/bot tester" });
  await pi.next(record => record.type === "response" && record.command === "prompt");
  pi.send({ type: "prompt", message: "hi" });
  assert.equal((await pi.next(reply)).message.content[0].text, "reply to hi: persona=true section=true home-extension=false");
  pi.send({ type: "prompt", message: "/bot exit" });
  await pi.next(record => record.type === "response" && record.command === "prompt");
  pi.send({ type: "prompt", message: "back" });
  assert.equal((await pi.next(reply)).message.content[0].text, "reply to back: persona=false section=false home-extension=false");
  pi.send({ type: "get_state" });
  const { data } = await pi.next(state);
  assert.equal(JSON.parse((await readFile(data.sessionFile, "utf8")).split("\n")[0]).cwd, f.workspace);
});

test("a bot's edits to its BOT.md apply from its next turn", async t => {
  const f = await fixture(t);
  const pi = rpc(t, [], { cwd: f.bot.home, env: f.env });
  pi.send({ type: "prompt", message: "one" });
  assert.match((await pi.next(reply)).message.content[0].text, /persona=true/);
  await writeFile(join(f.bot.home, "BOT.md"), "---\ndescription: Tests things\n---\n\nRewritten persona.\n");
  pi.send({ type: "prompt", message: "two" });
  assert.match((await pi.next(reply)).message.content[0].text, /persona=false section=true/);
});

test("a bot loads an extension it added to its home by calling bot_reload", async t => {
  const f = await fixture(t);
  const pi = rpc(t, [], { cwd: f.bot.home, env: f.env });
  const started = (record: any) => record.type === "extension_ui_request" && record.statusText === "bot: tester";
  await pi.next(started);
  await mkdir(join(f.bot.home, ".pi/extensions"), { recursive: true });
  await writeFile(join(f.bot.home, ".pi/extensions/marker.ts"), `export default pi => pi.on("before_agent_start", event => { event.systemPromptOptions.sections.marker = "HOME-EXTENSION-MARK"; });`);
  pi.send({ type: "prompt", message: "reload" });
  assert.match((await pi.next(reply)).message.content.map((part: any) => part.text ?? "").join(""), /^$/, "the bot calls bot_reload");
  assert.match((await pi.next(reply)).message.content[0].text, /^parent got: Reload scheduled/);
  await pi.next(started);
  pi.send({ type: "prompt", message: "check" });
  assert.equal((await pi.next(reply)).message.content[0].text, "reply to check: persona=true section=true home-extension=true");
});

test("entering and leaving a bot without a message leaves no empty sessions", async t => {
  const f = await fixture(t);
  const pi = rpc(t, [], { cwd: f.workspace, env: f.env });
  for (const message of ["/bot tester", "/bot exit"]) {
    pi.send({ type: "prompt", message });
    await pi.next(record => record.type === "response" && record.command === "prompt");
  }
  pi.send({ type: "get_state" });
  await pi.next(state);
  const dirs = await readdir(join(f.agentDir, "sessions")).catch(() => []);
  const files = (await Promise.all(dirs.map(dir => readdir(join(f.agentDir, "sessions", dir))))).flat();
  assert.deepEqual(files, []);
});

test("bot_run delegates to a child Pi in the bot's home and returns its reply and session", async t => {
  const f = await fixture(t);
  const { stdout } = await run(process.execPath, [cli, "-e", extension, "--mode", "json", "delegate"], { cwd: f.workspace, env: f.env, timeout: 60_000 });
  const records = events(stdout);
  const result = records.find(e => e.type === "tool_execution_end" && e.toolName === "bot_run");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.result.details.output, "reply to child task: persona=true section=true home-extension=false");
  assert.match(result.result.details.sessionId, /\S/);
  const sessionDir = join(f.agentDir, "sessions", `--${f.bot.home.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
  const [child] = await readdir(sessionDir);
  assert.ok((await readFile(join(sessionDir, child), "utf8")).includes("child task"), "the child's session is stored with the bot's sessions");
  assert.match(replies(records).at(-1)!, /^parent got: reply to child task: persona=true/);
});
