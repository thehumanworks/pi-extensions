import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Pi, sessionCwd, type Call } from "./fixtures/run-pi.ts";

// These tests run the real Pi CLI with the extension and a scripted model.

const PI_PROMPT = "You are an expert coding assistant operating inside pi";

function assertAgentPrompt(call: Call | undefined, body: string, home: string) {
  assert.ok(call, "the model was called");
  assert.ok(call.system.trim().startsWith(body), `system prompt starts with the agent's body:\n${call.system}`);
  assert.ok(!call.system.includes(PI_PROMPT), "Pi's base prompt is replaced");
  assert.ok(call.system.includes(`<cwd>\n${home}\n</cwd>`), `cwd is the agent's home:\n${call.system}`);
}

describe("print mode", () => {
  let pi: Pi;
  before(async () => {
    pi = await Pi.create();
  });
  after(async () => {
    await pi.dispose();
  });

  test("--agent starts a session in the agent's home with its prompt, tools and model", async () => {
    pi.defineAgent("reviewer", "tools: Read, Grep, Glob\nmodel: faux-2\n", "You are the reviewer.");
    mkdirSync(pi.home("reviewer"), { recursive: true });
    writeFileSync(join(pi.home("reviewer"), "note.txt"), "home note\n");

    const run = await pi.print(["--agent", "reviewer", "hello"], [{ tool: "read", args: { path: "note.txt" } }, { text: "done" }]);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout.trim(), "done");
    assert.equal(run.calls.length, 2);
    assertAgentPrompt(run.calls[0], "You are the reviewer.", pi.home("reviewer"));
    assert.deepEqual(run.calls[0]?.tools, ["find", "grep", "read"]);
    assert.equal(run.calls[0]?.model, "faux-2");
    assert.deepEqual(run.calls[0]?.last, { role: "user", text: "hello" });
    // A relative path resolves in the home, so the tools run there.
    assert.deepEqual(run.calls[1]?.last, { role: "toolResult", text: "home note\n" });

    const [session, ...others] = pi.sessions(pi.home("reviewer"));
    assert.equal(others.length, 0);
    const marker = session?.entries.find((entry) => entry.customType === "pi-agent");
    assert.deepEqual(marker?.data, { name: "reviewer", file: join(pi.agentDir, "agents", "reviewer.md"), home: pi.home("reviewer") });
    assert.equal(pi.sessions(pi.project).length, 0, "the launch directory keeps no session");
  });

  test("resuming an agent session restores the agent but not its model", async () => {
    const [session] = pi.sessions(pi.home("reviewer"));
    assert.ok(session);
    const run = await pi.print(["--session", session.file, "again"], [{ text: "resumed" }]);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout.trim(), "resumed", run.stderr);
    assertAgentPrompt(run.calls[0], "You are the reviewer.", pi.home("reviewer"));
    assert.deepEqual(run.calls[0]?.tools, ["find", "grep", "read"]);
    // The model is Pi's choice for a resumed session; here the explicit --model.
    assert.equal(run.calls[0]?.model, "faux-1");
  });

  test("--no-session keeps no agent session", async () => {
    pi.defineAgent("passing", "", "You are passing through.");

    const run = await pi.print(["--no-session", "--agent", "passing", "hi"], [{ text: "ok" }]);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout.trim(), "ok");
    assertAgentPrompt(run.calls[0], "You are passing through.", pi.home("passing"));
    assert.equal(pi.sessions(pi.home("passing")).length, 0);
    assert.deepEqual(readdirSync(pi.tmp).filter((entry) => entry.startsWith("pi-agent-sessions-")), []);
  });

  test("an unknown agent fails without prompting Pi's default agent", async () => {
    pi.defineAgent("known", "", "You are known.");
    const run = await pi.print(["--agent", "nobody", "hello", "and more"], [{ text: "should not answer" }]);

    assert.equal(run.code, 1);
    assert.equal(run.calls.length, 0, "no prompt reaches the model");
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /No agent named "nobody"\. Available: .*\bknown\b/);
    assert.match(run.stderr, /--agent nobody: the prompt was not sent/);
    assert.match(run.stderr, /--agent nobody did not start; the prompt was not sent/);
  });

  test("an agent without tools keeps Pi's tools; tools: [] and disallowedTools narrow them", async () => {
    pi.defineAgent("open", "", "You are open.");
    pi.defineAgent("silent", "tools: []\n", "You are silent.");
    pi.defineAgent("careful", "disallowedTools: Bash, Write\n", "You are careful.");

    const open = await pi.print(["--agent", "open", "hi"], [{ text: "ok" }]);
    const silent = await pi.print(["--agent", "silent", "hi"], [{ text: "ok" }]);
    const careful = await pi.print(["--agent", "careful", "hi"], [{ text: "ok" }]);

    assert.deepEqual(open.calls[0]?.tools, ["bash", "edit", "read", "write"]);
    assertAgentPrompt(open.calls[0], "You are open.", pi.home("open"));
    assert.deepEqual(silent.calls[0]?.tools, []);
    assert.deepEqual(careful.calls[0]?.tools, ["edit", "read"]);
  });

  test("an allowlist also blocks tools reached through codemode", async () => {
    pi.defineAgent("scripter", "tools: codemode\n", "You script.");
    pi.defineAgent("keeper", "tools: codemode, vault\n", "You keep the vault.");
    const script = [{ tool: "codemode", args: { code: "return await tools.vault({})" } }, { text: "done" }];

    const denied = await pi.print(["--agent", "scripter", "open the vault"], script);
    const granted = await pi.print(["--agent", "keeper", "open the vault"], script);

    assert.deepEqual(denied.calls[0]?.tools, ["codemode"]);
    assert.match(denied.calls[1]?.last?.text ?? "", /Agent "scripter" is not allowed to use vault/);
    assert.doesNotMatch(denied.calls[1]?.last?.text ?? "", /vault-secret/);
    assert.match(granted.calls[1]?.last?.text ?? "", /vault-secret/);
  });

  test("initialPrompt is prepended to the first prompt", async () => {
    pi.defineAgent("starter", "initialPrompt: Read the plan first.\n", "You start.");

    const run = await pi.print(["--agent", "starter", "then report"], [{ text: "ok" }]);

    assert.deepEqual(run.calls[0]?.last, { role: "user", text: "Read the plan first.\n\nthen report" });
  });

  test("project agents load only in trusted projects", async () => {
    pi.defineAgent("local", "", "You are local.", "project");

    const untrusted = await pi.print(["--agent", "local", "hi"], [{ text: "ok" }]);
    const approved = await pi.print(["--approve", "--agent", "local", "hi"], [{ text: "ok" }]);

    assert.equal(untrusted.code, 1);
    assert.equal(untrusted.calls.length, 0);
    assert.match(untrusted.stderr, /project agents load only in trusted projects/);
    assert.equal(approved.code, 0, approved.stderr);
    assertAgentPrompt(approved.calls[0], "You are local.", pi.home("local"));
    rmSync(join(pi.project, ".pi"), { recursive: true });
  });

  test("a session whose agent definition is gone runs without tools", async () => {
    const file = pi.defineAgent("fleeting", "", "You are fleeting.");
    await pi.print(["--agent", "fleeting", "hi"], [{ text: "ok" }]);
    const [session] = pi.sessions(pi.home("fleeting"));
    assert.ok(session);
    rmSync(file);

    const run = await pi.print(["--session", session.file, "again"], [{ text: "ok" }]);

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /Agent "fleeting": its definition cannot be loaded, so its tools are disabled/);
    assert.deepEqual(run.calls[0]?.tools, []);
  });
});

describe("rpc mode", () => {
  let pi: Pi;
  before(async () => {
    pi = await Pi.create();
    pi.defineAgent("helper", "model: faux-2\n", "You help.");
  });
  after(async () => {
    await pi.dispose();
  });

  test("/agent starts an agent session, and /new keeps the agent", async () => {
    const rpc = pi.rpc([], [{ text: "one" }, { text: "two" }]);
    try {
      const started = await rpc.request({ type: "prompt", message: "/agent helper hi there" });
      assert.equal(started.success, true);
      await rpc.runsEnded(1);
      const first = await rpc.state();
      assert.equal(sessionCwd(first.sessionFile), pi.home("helper"));
      assert.equal(first.model.id, "faux-2");

      await rpc.request({ type: "new_session" });
      await rpc.request({ type: "prompt", message: "second" });
      await rpc.runsEnded(2);
      const second = await rpc.state();

      assert.notEqual(second.sessionFile, first.sessionFile);
      assert.equal(sessionCwd(second.sessionFile), pi.home("helper"));
      assertAgentPrompt(rpc.calls[0], "You help.", pi.home("helper"));
      assert.deepEqual(rpc.calls[0]?.last, { role: "user", text: "hi there" });
      assertAgentPrompt(rpc.calls[1], "You help.", pi.home("helper"));
      assert.deepEqual(rpc.calls[1]?.last, { role: "user", text: "second" });
    } finally {
      await rpc.close();
    }
  });

  test("agent sessions follow --session-dir, and forks keep the agent", async () => {
    const sessionDir = join(pi.root, "custom-sessions");
    const rpc = pi.rpc(["--session-dir", sessionDir], [{ text: "one" }, { text: "two" }]);
    try {
      await rpc.request({ type: "prompt", message: "/agent helper hi" });
      await rpc.runsEnded(1);
      const first = await rpc.state();
      assert.ok(first.sessionFile.startsWith(sessionDir), first.sessionFile);

      const { messages } = (await rpc.request({ type: "get_fork_messages" })).data as { messages: { entryId: string }[] };
      await rpc.request({ type: "fork", entryId: messages[0]?.entryId });
      await rpc.request({ type: "prompt", message: "after fork" });
      await rpc.runsEnded(2);
      const forked = await rpc.state();

      assert.notEqual(forked.sessionFile, first.sessionFile);
      assert.ok(forked.sessionFile.startsWith(sessionDir), forked.sessionFile);
      assert.equal(sessionCwd(forked.sessionFile), pi.home("helper"));
      assertAgentPrompt(rpc.calls[1], "You help.", pi.home("helper"));
      assert.deepEqual(rpc.calls[1]?.last, { role: "user", text: "after fork" });
    } finally {
      await rpc.close();
    }
  });

  test("--agent switches before the first prompt", async () => {
    const rpc = pi.rpc(["--agent", "helper"], [{ text: "hello" }]);
    try {
      await rpc.request({ type: "prompt", message: "first" });
      await rpc.runsEnded(1);
      const state = await rpc.state();

      assert.equal(sessionCwd(state.sessionFile), pi.home("helper"));
      assert.equal(rpc.calls.length, 1);
      assertAgentPrompt(rpc.calls[0], "You help.", pi.home("helper"));
      assert.deepEqual(rpc.calls[0]?.last, { role: "user", text: "first" });
    } finally {
      await rpc.close();
    }
  });

  test("--agent with an unknown agent refuses prompts", async () => {
    const rpc = pi.rpc(["--agent", "nobody"], [{ text: "should not answer" }]);
    try {
      await rpc.waitFor((message) => message.method === "notify" && /No agent named "nobody"/.test(message.message ?? ""));
      const response = await rpc.request({ type: "prompt", message: "hello" });
      assert.deepEqual(response.data, { disposition: "handled" });
      await rpc.waitFor((message) => message.method === "notify" && /did not start; the prompt was not sent/.test(message.message ?? ""));
      assert.equal(rpc.calls.length, 0);
    } finally {
      await rpc.close();
    }
  });

  test("/agent without a name lists the agents", async () => {
    const rpc = pi.rpc([], []);
    try {
      await rpc.request({ type: "prompt", message: "/agent" });
      const listing = await rpc.waitFor((message) => message.method === "notify");
      assert.match(listing.message ?? "", /helper \(user\): The helper agent/);
      assert.equal(rpc.calls.length, 0);
    } finally {
      await rpc.close();
    }
  });
});
