import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type ClaudeHookInput, handleClaudeHook } from "../src/claude.ts";
import { hookCommand, main, withHooks } from "../src/cli.ts";

const RULES = {
	"use-pnpm.md": "---\ncondition: '\\bnpm\\s+install\\b'\nscope: tool:bash\n---\nUse pnpm.",
	"no-claims.md": "---\ncondition: all tests pass\nscope: text\n---\nRun the tests before claiming they pass.",
	"style.md": "---\ncondition: 'console\\.log'\nscope: tool:edit\ninterruptMode: never\n---\nUse the logger.",
	"house.md": "---\nalwaysApply: true\n---\nWrite in British English.",
	"secret.md": "---\ncondition: x\nscope: thinking\n---\nThinking-only rule.",
};

async function setup(config: object = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-time-travel-claude-"));
	const home = join(root, "home");
	const repo = join(root, "repo");
	await mkdir(join(repo, ".git"), { recursive: true });
	await mkdir(join(repo, ".agents", "ttsr"), { recursive: true });
	for (const [file, content] of Object.entries(RULES)) await writeFile(join(repo, ".agents", "ttsr", file), content);
	await mkdir(join(home, ".agents", "ttsr"), { recursive: true });
	await writeFile(join(home, ".agents", "ttsr", "config.json"), JSON.stringify({ judge: { mode: "off" }, logFile: join(root, "log.jsonl"), ...config }));
	const env = { PI_TIME_TRAVEL_STATE_DIR: join(root, "state") };
	const hook = async (input: ClaudeHookInput) => {
		const out = await handleClaudeHook({ session_id: "s1", cwd: repo, ...input }, { home, env });
		return out === undefined ? undefined : JSON.parse(out);
	};
	return { root, repo, home, env, hook, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("PreToolUse denies a violating call with the rule as the reason, and stays silent otherwise", async () => {
	const t = await setup();
	try {
		const denied = await t.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm install lodash" }, tool_use_id: "t1" });
		assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
		assert.match(denied.hookSpecificOutput.permissionDecisionReason, /rule="use-pnpm"[^]*blocked before it ran[^]*Use pnpm\./);
		assert.equal(await t.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pnpm add lodash" } }), undefined);
		const log = (await readFile(join(t.root, "log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(log.some((r) => r.event === "interrupt" && r.rule === "use-pnpm" && r.harness === "claude"));
		assert.ok(log.every((r) => r.event !== "check" || typeof r.ms === "number"));
	} finally {
		await t.dispose();
	}
});

test("a non-interrupting rule adds context instead of denying", async () => {
	const t = await setup();
	try {
		const out = await t.hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(t.repo, "a.ts"), old_string: "a", new_string: "console.log(a)" } });
		assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
		assert.match(out.hookSpecificOutput.additionalContext, /system-reminder[^]*Use the logger/);
	} finally {
		await t.dispose();
	}
});

test("Stop blocks a violating final message once, and does not loop on the same correction", async () => {
	const t = await setup();
	try {
		const blocked = await t.hook({ hook_event_name: "Stop", last_assistant_message: "Done, all tests pass.", stop_hook_active: false });
		assert.equal(blocked.decision, "block");
		assert.match(blocked.reason, /no-claims[^]*Run the tests/);
		assert.equal(await t.hook({ hook_event_name: "Stop", last_assistant_message: "Yes, all tests pass.", stop_hook_active: true }), undefined, "the same rule again in the continuation is let through");
		assert.equal(await t.hook({ hook_event_name: "Stop", last_assistant_message: "I ran them: all tests pass.", stop_hook_active: false }).then((o) => o?.decision), "block", "a later turn is checked again");
		const state = JSON.parse(await readFile(join(t.root, "state", "s1.json"), "utf8"));
		assert.equal(state.turn, 1);
		assert.equal(typeof state.fired["no-claims"], "number");
	} finally {
		await t.dispose();
	}
});

test("repeatMode once is tracked per session", async () => {
	const t = await setup({ repeatMode: "once" });
	try {
		const call = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm install a" } };
		assert.equal((await t.hook(call)).hookSpecificOutput.permissionDecision, "deny");
		assert.equal(await t.hook(call), undefined);
		assert.equal((await t.hook({ ...call, session_id: "s2" })).hookSpecificOutput.permissionDecision, "deny");
	} finally {
		await t.dispose();
	}
});

test("SessionStart delivers up-front rules and reports what hooks cannot see", async () => {
	const t = await setup();
	try {
		const out = await t.hook({ hook_event_name: "SessionStart" });
		assert.match(out.hookSpecificOutput.additionalContext, /<rule name="house">\nWrite in British English\.\n<\/rule>/);
		assert.match(out.systemMessage, /secret: watches only thinking/);
	} finally {
		await t.dispose();
	}
});

test("ignoreNewFiles rules let Claude edit a test file it created, across hook processes", async () => {
	const t = await setup();
	try {
		await writeFile(join(t.repo, ".agents", "ttsr", "tests.md"), "---\ncondition: '^'\nscope: tool:edit(test/**), tool:write(test/**)\nignoreNewFiles: true\n---\nDo not edit existing tests.");
		await mkdir(join(t.repo, "test"));
		await writeFile(join(t.repo, "test", "old.test.js"), "x");
		const pre = (tool: string, input: object) => t.hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
		assert.equal(await pre("Write", { file_path: join(t.repo, "test", "new.test.js"), content: "x" }), undefined);
		await writeFile(join(t.repo, "test", "new.test.js"), "x");
		assert.equal(await pre("Edit", { file_path: join(t.repo, "test", "new.test.js"), old_string: "x", new_string: "y" }), undefined);
		const denied = await pre("Edit", { file_path: join(t.repo, "test", "old.test.js"), old_string: "x", new_string: "y" });
		assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
	} finally {
		await t.dispose();
	}
});

test("disabled: silent everywhere", async () => {
	const t = await setup({ enabled: false });
	try {
		assert.equal(await t.hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm install x" } }), undefined);
	} finally {
		await t.dispose();
	}
});

test("the CLI hook reads stdin, prints JSON, and fails open on bad input", async () => {
	const t = await setup();
	try {
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const run = (input: string) =>
			execFileSync(process.execPath, ["--import", "tsx", cli, "hook", "claude"], { input, encoding: "utf8", env: { ...process.env, ...t.env, HOME: t.home }, stdio: ["pipe", "pipe", "pipe"] });
		const out = JSON.parse(run(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: t.repo, tool_name: "Bash", tool_input: { command: "npm install x" } })));
		assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
		assert.equal(run("not json"), "", "exit 0 and no output: Claude Code carries on");
	} finally {
		await t.dispose();
	}
});

test("install adds one hook per event, keeps other hooks, and uninstall removes only ours", () => {
	const other = { type: "command", command: "corgi hook claude" };
	const settings = { model: "opus", hooks: { PreToolUse: [{ hooks: [other] }], Notification: [{ hooks: [other] }] } };
	const command = hookCommand("/opt/node_modules/@nothumanwork/pi-time-travel/dist/src/cli.js");
	const installed = withHooks(settings, command) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
	assert.deepEqual(Object.keys(installed.hooks).sort(), ["Notification", "PreToolUse", "SessionStart", "Stop"]);
	assert.equal(installed.hooks.PreToolUse!.length, 2);
	assert.deepEqual(withHooks(installed, command), installed, "installing twice changes nothing");
	assert.deepEqual(withHooks(installed, undefined), settings);
	assert.equal((installed as { model?: string }).model, "opus");
});

test("cli test --judge asks the judge about a rule given as a file", async (t) => {
	const setupDir = await setup();
	const requests: Array<{ url: string; body: { state: { facts?: unknown }; questions: Record<string, { instructions: string }> } }> = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		requests.push({ url, body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify({ answers: { q0: { type: "noul", noul: 0.97 } } }), { headers: { "content-type": "application/json" } });
	});
	const printed: string[] = [];
	t.mock.method(console, "log", (line: string) => printed.push(line));
	const saved = { home: process.env.HOME, key: process.env.TT_TEST_JUDGE_KEY };
	process.env.HOME = setupDir.home;
	process.env.TT_TEST_JUDGE_KEY = "k";
	try {
		const judge = { mode: "auto", provider: "local", model: "m", api: "system-one", baseUrl: "https://judge.test/v1", apiKeyEnv: "TT_TEST_JUDGE_KEY" };
		await writeFile(join(setupDir.home, ".agents", "ttsr", "config.json"), JSON.stringify({ judge }));
		const rule = join(setupDir.root, "pinned-lease.md");
		await writeFile(rule, "---\ncondition: 'force-with-lease='\nquestion: Was the lease value read from the remote?\nscope: tool:bash\n---\nDo not pin leases.");
		const facts = JSON.stringify({ commandsRunThisSession: ["git ls-remote origin x"] });
		const code = await main(["test", rule, "--tool", "bash", "--judge", "--cwd", setupDir.repo, "--facts", facts, "git push --force-with-lease=x:abc origin x"]);
		assert.equal(code, 0);
		assert.match(printed.join("\n"), /match \(judge, p=0\.97/);
		assert.equal(requests.length, 1, "the repo's own rules need no judge, but the file's rule does");
		assert.equal(requests[0]!.url, "https://judge.test/v1/systemone");
		assert.deepEqual(requests[0]!.body.state.facts, { commandsRunThisSession: ["git ls-remote origin x"] });
		assert.match(requests[0]!.body.questions.q0!.instructions, /Was the lease value read from the remote\?[^]*state\.facts/);
	} finally {
		process.env.HOME = saved.home;
		if (saved.key === undefined) delete process.env.TT_TEST_JUDGE_KEY;
		else process.env.TT_TEST_JUDGE_KEY = saved.key;
		await setupDir.dispose();
	}
});

test("cli test treats a path that does not exist yet as a new file for ignoreNewFiles rules", async (t) => {
	const setupDir = await setup();
	const printed: string[] = [];
	t.mock.method(console, "log", (line: string) => printed.push(line));
	try {
		const rule = join(setupDir.root, "existing-tests.md");
		await writeFile(rule, "---\ncondition: '^'\nscope: tool:edit(test/**)\nignoreNewFiles: true\n---\nDo not change existing tests.");
		await mkdir(join(setupDir.repo, "test"));
		await writeFile(join(setupDir.repo, "test", "old.test.js"), "x");
		const run = (path: string) => main(["test", rule, "--tool", "edit", "--path", path, "--cwd", setupDir.repo, "y"]);
		assert.equal(await run("test/new.test.js"), 1);
		assert.match(printed.at(-1)!, /test\/new\.test\.js does not exist[^]*ignores new files/);
		assert.equal(await run("test/old.test.js"), 0);
	} finally {
		await setupDir.dispose();
	}
});
