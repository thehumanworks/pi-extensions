import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { main, type CliDependencies } from "../src/cli.js";
import type { OpenBotOptions, RunOptions } from "../src/types.js";
import type { ServeOptions } from "../src/server.js";
import { eventually, fixture, INFO } from "./interface-fixtures.js";

function io(extra: CliDependencies = {}) {
  let stdout = ""; let stderr = "";
  const dependencies: CliDependencies = {
    signal: new AbortController().signal, env: {}, cwd: "/operator", stdin: Readable.from([]),
    stdout: { write(chunk: string | Uint8Array) { stdout += chunk.toString(); return true; } },
    stderr: { write(chunk: string | Uint8Array) { stderr += chunk.toString(); return true; } }, ...extra,
  };
  return { dependencies, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test("help/version are predictable, explain optional access and need no provider/runtime", async () => {
  for (const args of [[], ["--help"], ["-h"], ["serve", "--help"]]) {
    const out = io(); assert.equal(await main(args, out.dependencies), 0);
    assert.match(out.stdout, /Usage: bot/); assert.match(out.stdout, /authentication is OFF/); assert.match(out.stdout, /No bot login/);
    assert.equal(out.stderr, "");
  }
  const out = io(); assert.equal(await main(["--version"], out.dependencies), 0); assert.match(out.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("invalid options, combinations, positional args and JSON fail before starting anything", async () => {
  const invalid = [
    ["login"], ["run"], ["run", "ref", "--unknown", "x"], ["run", "ref", "--message"],
    ["run", "ref", "--message", "a", "--message", "b"], ["run", "ref", "extra", "--message", "a"],
    ["run", "ref", "--url", "http://remote", "--message", "a"],
    ...["cwd", "state-dir", "model", "ephemeral"].map(flag => ["run", "--url", "http://remote", "--message", "a", `--${flag}`, ...(flag === "ephemeral" ? [] : ["x"])]),
    ["run", "--message", "a", "--auth-token-env", "TOKEN"],
    ["serve", "ref", "--port", "-1"], ["serve", "ref", "--port", "65536"], ["serve", "ref", "--port", "3.5"],
    ["serve", "ref", "--allow-anonymous"], ["serve", "ref", "--ephemeral"], ["info", "ref", "--cwd", "x"],
    ["tool", "wrong"], ["tool", "call", "ref", "echo"], ["tool", "call", "ref", "echo", "--input", "{"],
    ["sessions", "wrong"], ["run", "--message", "a", "--json=true"],
    ["run", "ref", "--message", "a", "--no-stream"], ["run", "ref", "--message", "a", "--no-color"], ["chat", "ref", "--no-color=false"],
  ];
  for (const args of invalid) {
    let started = false;
    const out = io({ env: { TOKEN: "set" }, openBot: async () => { started = true; return fixture().bot; },
      serve: async () => { started = true; throw new Error("should not serve"); },
      connectBot: () => { started = true; throw new Error("should not connect"); } });
    assert.equal(await main(args, out.dependencies), 1, args.join(" "));
    assert.equal(started, false, args.join(" ")); assert.match(out.stderr, /bot:/); assert.equal(out.stdout, "");
  }
});

test("local run passes open/run options, emits only final JSON and closes its handle", async () => {
  const f = fixture(); let opened: { source: string; options: OpenBotOptions } | undefined;
  const out = io({ openBot: async (source, options) => { opened = { source, options }; return f.bot; } });
  const code = await main(["run", "named", "--message", "hello", "--session", "existing", "--cwd", "workspace", "--state-dir", "state", "--model", "provider/model", "--ephemeral", "--json"], out.dependencies);
  assert.equal(code, 0);
  assert.deepEqual(opened, { source: "named", options: { cwd: "/operator/workspace", stateDir: "/operator/state", model: "provider/model", ephemeral: true } });
  assert.equal(f.submitted[0].message, "hello"); assert.equal(f.submitted[0].options?.session, "existing");
  assert.equal(JSON.parse(out.stdout).status, "completed"); assert.equal(out.stderr, ""); assert.equal(f.closed, 1);
});

test("text runs show durable IDs on stderr and accept local/remote idempotency keys", async () => {
  for (const remote of [false, true]) {
    const f = fixture(); const out = io({ openBot: async () => f.bot, connectBot: () => f.bot });
    assert.equal(await main(["run", ...(remote ? ["--url", "http://remote"] : ["ref"]), "--message", "hello", "--request-id", "retry-key"], out.dependencies), 0);
    assert.equal(out.stdout, "done\n");
    assert.match(out.stderr, /Session: session-1/); assert.match(out.stderr, /Run: run-1/);
    assert.equal(f.submitted[0].options?.requestId, "retry-key");
  }
});

test("remote run uses optional requested token only, not local runtime or credentials", async () => {
  for (const protectedAccess of [false, true]) {
    const f = fixture(); let connected: unknown;
    const out = io({ env: { TOKEN: "chosen-secret", UNUSED: "ignored" }, connectBot: (url, options) => {
      connected = { url, options }; return f.bot;
    } });
    const code = await main(["run", "--url", "http://remote:3000", "--message", "hello", ...(protectedAccess ? ["--auth-token-env", "TOKEN"] : []), "--json"], out.dependencies);
    assert.equal(code, 0); assert.deepEqual(connected, { url: "http://remote:3000", options: { authToken: protectedAccess ? "chosen-secret" : undefined } });
    assert.ok(!out.stdout.includes("chosen-secret")); assert.equal(f.closed, 1);
  }
});

test("explicit token environment must exist and be non-empty, for both serve and remote clients", async () => {
  for (const token of [undefined, "", "   ", "bad\nheader"]) {
    for (const args of [["serve", "ref"], ["run", "--url", "http://remote", "--message", "a"]]) {
      const out = io({ env: { TOKEN: token } });
      assert.equal(await main([...args, "--auth-token-env", "TOKEN"], out.dependencies), 1);
      assert.match(out.stderr, /missing, empty or invalid token/);
    }
  }
});

test("serve remains foreground, public access is not gated, port 0 works and shutdown is graceful", async () => {
  for (const protectedAccess of [false, true]) {
    const controller = new AbortController(); let called: { source: string; options: ServeOptions } | undefined; let closed = 0;
    const out = io({ signal: controller.signal, env: { TOKEN: "never-log-me" }, serve: async (source, options) => {
      called = { source, options }; return { url: "http://0.0.0.0:12345", async close() { closed++; } };
    } });
    const pending = main(["serve", "ref", "--host", "0.0.0.0", "--port", "0", ...(protectedAccess ? ["--auth-token-env", "TOKEN"] : [])], out.dependencies);
    await eventually(() => out.stderr.includes("Listening")); assert.equal(closed, 0);
    assert.equal(called!.options.host, "0.0.0.0"); assert.equal(called!.options.port, 0);
    assert.equal(called!.options.authToken, protectedAccess ? "never-log-me" : undefined);
    assert.match(out.stderr, protectedAccess ? /token-protected/ : /unauthenticated/);
    assert.ok(!out.stderr.includes("never-log-me")); assert.equal(out.stdout, "");
    controller.abort(); assert.equal(await pending, 0); assert.equal(closed, 1);
  }
});

test("foreground run receives cancellation signal and closes even on interruption", async () => {
  const controller = new AbortController(); const f = fixture(); let options: RunOptions | undefined;
  f.bot.run = async (_message, supplied) => {
    options = supplied;
    return new Promise((_resolve, reject) => supplied!.signal!.addEventListener("abort", () => reject(supplied!.signal!.reason), { once: true }));
  };
  const out = io({ signal: controller.signal, openBot: async () => f.bot });
  const pending = main(["run", "ref", "--message", "wait"], out.dependencies);
  await eventually(() => options !== undefined); controller.abort();
  assert.equal(await pending, 130); assert.equal(f.closed, 1); assert.equal(out.stdout, ""); assert.match(out.stderr, /Interrupted/);
});

test("interactive chat continues the accepted session and prompts only stderr", async () => {
  const f = fixture(); const out = io({ stdin: Readable.from(["first\nsecond\n/exit\n"]), openBot: async () => f.bot });
  assert.equal(await main(["chat", "ref", "--json"], out.dependencies), 0);
  assert.equal(f.submitted.length, 2); assert.equal(f.submitted[1].options?.session, "session-1");
  assert.equal(out.stdout.trim().split("\n").length, 2);
  for (const line of out.stdout.trim().split("\n")) assert.equal(JSON.parse(line).status, "completed");
  assert.match(out.stderr, /Chat ready/); assert.equal(f.closed, 1);
});

/** A handle whose runs emit a thinking block, a tool call and a final answer, like the runtime. */
function streaming() {
  const f = fixture(); const options: Array<RunOptions | undefined> = [];
  f.bot.run = async (message, runOptions) => {
    options.push(runOptions);
    const accepted = await f.bot.submit(message, { session: runOptions?.session });
    for (const event of [
      { type: "message_start", data: { message: { role: "assistant", content: [{ type: "thinking", thinking: "Considering" }] } } },
      { type: "tool_execution_start", data: { toolCallId: "t1", toolName: "echo", args: { n: 2 } } },
      { type: "tool_execution_end", data: { toolCallId: "t1", toolName: "echo", entry: { model: [{ role: "toolResult", content: [{ type: "text", text: "v1:2" }], isError: false }] } } },
      { type: "message_end", data: { entry: { model: [{ role: "assistant", content: [{ type: "text", text: "**done**" }] }] } } },
    ]) runOptions?.onEvent?.({ ...event, sessionId: accepted.sessionId, runId: accepted.runId });
    f.complete(accepted.runId);
    return { ...(await f.bot.getRun(accepted.runId)), output: "**done**", toolCalls: 1, model: "faux/model",
      usage: { input: 1234, output: 34, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2 } };
  };
  return Object.assign(f, { options });
}

test("chat streams thinking, tools, answer and usage by default in local and remote forms", async () => {
  for (const remote of [false, true]) {
    const f = streaming(); const target = remote ? ["--url", "http://remote"] : ["ref"];
    const out = io({ stdin: Readable.from(["hello\nagain\n/exit\n"]), openBot: async () => f.bot, connectBot: () => f.bot });
    assert.equal(await main(["chat", ...target], out.dependencies), 0);
    assert.equal(typeof f.options[0]?.onEvent, "function"); assert.equal(f.options[1]?.session, "session-1");
    assert.equal(out.stdout, "**done**\n\n**done**\n", "answers alone on stdout, plain when not a terminal");
    assert.match(out.stderr, /^Chat ready.*\n> \n✻ Considering\n\n⏺ echo \{"n":2\}\n  ⎿ v1:2\n\n✓ completed · [\d.]+s · 2 turns · 1 tool call · ↑1\.2k ↓34 · \$0\.0100 · faux\/model\nSession: session-1 · Run: run-1\n> \n/);
    assert.ok(!out.stdout.includes("\x1b[") && !out.stderr.includes("\x1b["));
    assert.equal(f.closed, 1);
  }
});

test("chat --no-stream and --json wait for final records without an event observer", async () => {
  const f = streaming();
  const waited = io({ stdin: Readable.from(["hello\n"]), openBot: async () => f.bot });
  assert.equal(await main(["chat", "ref", "--no-stream"], waited.dependencies), 0);
  assert.equal(f.options[0]?.onEvent, undefined);
  assert.equal(waited.stdout, "**done**\n"); assert.match(waited.stderr, /✓ completed .*\nSession: session-1 · Run: run-1\n/);
  assert.doesNotMatch(waited.stderr, /⏺|✻/);
  const json = io({ stdin: Readable.from(["hello\n"]), openBot: async () => f.bot });
  assert.equal(await main(["chat", "ref", "--json"], json.dependencies), 0);
  assert.equal(f.options[1]?.onEvent, undefined); assert.equal(JSON.parse(json.stdout).output, "**done**");
});

test("terminal chat formats markdown and styles diagnostics; --no-color and NO_COLOR print plain text", async () => {
  const tty = (extra: CliDependencies) => {
    const out = io({ stdin: Readable.from(["hello\n"]), env: { TERM: "xterm-256color" }, ...extra });
    Object.assign(out.dependencies.stdout!, { isTTY: true, columns: 80, rows: 24 });
    Object.assign(out.dependencies.stderr!, { isTTY: true, columns: 80, rows: 24 });
    return out;
  };
  let loads = 0;
  const loadMarkdown = async () => { loads++; return { render: (text: string) => [`\x1b[1m${text.trim().replaceAll("**", "")}\x1b[22m`], complete: () => 0 }; };
  const f = streaming();
  const styled = tty({ openBot: async () => f.bot, loadMarkdown });
  assert.equal(await main(["chat", "ref"], styled.dependencies), 0);
  assert.equal(loads, 1); assert.match(styled.stdout, /\x1b\[1mdone\x1b\[22m\n/); assert.match(styled.stderr, /\x1b\[32m✓ completed/);
  for (const [args, env] of [[["--no-color"], { TERM: "xterm-256color" }], [[], { TERM: "xterm-256color", NO_COLOR: "1" }]] as const) {
    const plain = tty({ openBot: async () => f.bot, loadMarkdown, env });
    assert.equal(await main(["chat", "ref", ...args], plain.dependencies), 0);
    assert.equal(plain.stdout, "**done**\n"); assert.match(plain.stderr, /⏺ echo/);
    assert.ok(!plain.stdout.includes("\x1b[") && !plain.stderr.includes("\x1b["));
  }
  assert.equal(loads, 1, "plain output never loads the formatter");
  const broken = tty({ openBot: async () => f.bot, loadMarkdown: async () => { throw new Error("no theme"); } });
  assert.equal(await main(["chat", "ref"], broken.dependencies), 0);
  assert.match(broken.stderr, /markdown formatting unavailable: no theme/); assert.match(broken.stdout, /\*\*done\*\*/);
});

test("tool call and sessions support local and remote forms", async () => {
  for (const remote of [false, true]) {
    const f = fixture(); await f.bot.submit("hello");
    const out = io({ openBot: async () => f.bot, connectBot: () => f.bot });
    const toolArgs = remote ? ["tool", "call", "--url", "http://remote", "echo"] : ["tool", "call", "ref", "echo"];
    assert.equal(await main([...toolArgs, "--input", '{"key":1}', "--session", "session-1", "--json"], out.dependencies), 0);
    const tool = JSON.parse(out.stdout); assert.deepEqual(JSON.parse(tool.content[0].text), { input: { key: 1 }, session: "session-1" });
    const sessions = io({ openBot: async () => f.bot, connectBot: () => f.bot });
    assert.equal(await main(["sessions", "list", ...(remote ? ["--url", "http://remote"] : ["ref"]), "--json"], sessions.dependencies), 0);
    assert.equal(JSON.parse(sessions.stdout)[0].sessionId, "session-1");
  }
});

test("info and validate use project inspection, without starting the runtime", async () => {
  for (const command of ["info", "validate"]) {
    let called: unknown;
    const operation = async (source: string, options: { stateDir?: string }) => { called = { source, options }; return INFO; };
    const out = io({ inspectBot: operation, validateBot: operation });
    assert.equal(await main([command, "named", "--state-dir", "state", ...(command === "info" ? ["--json"] : [])], out.dependencies), 0);
    assert.deepEqual(called, { source: "named", options: { stateDir: "/operator/state" } });
    if (command === "info") assert.deepEqual(JSON.parse(out.stdout), INFO); else assert.match(out.stdout, /Valid: fixture/);
  }
});

test("real process SIGTERM gracefully closes foreground serve without an access confirmation", async t => {
  const script = `
    import { main } from ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)};
    const keepAlive = setInterval(() => {}, 1000);
    process.exitCode = await main(["serve", "ref", "--host", "0.0.0.0"], {
      serve: async () => ({ url: "http://0.0.0.0:3000", close: async () => { clearInterval(keepAlive); process.stderr.write("closed\\n"); } })
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await eventually(() => stderr.includes("Listening"), stderr);
  assert.match(stderr, /unauthenticated/); child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null }); assert.match(stderr, /closed/); assert.equal(stdout, "");
});

test("init/validate/info smoke test uses the real project loader but never opens a model", async t => {
  const root = await mkdtemp(join(tmpdir(), "bot-cli-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "new-bot");
  const initialized = io();
  assert.equal(await main(["init", dir, "--name", "reviewer", "--description", "Reviews code"], initialized.dependencies), 0, initialized.stderr);
  assert.match(await readFile(join(dir, "BOT.md"), "utf8"), /reviewer/);
  const validated = io(); assert.equal(await main(["validate", dir], validated.dependencies), 0, validated.stderr);
  const inspected = io(); assert.equal(await main(["info", dir, "--json"], inspected.dependencies), 0, inspected.stderr);
  const info = JSON.parse(inspected.stdout); assert.equal(info.name, "reviewer"); assert.equal(info.sourceDir, dir);
});
