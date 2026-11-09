import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import timeTravel, { ENTRY_TYPE, MESSAGE_TYPE } from "../index.ts";

const USE_PNPM = `---
condition: '\\b(npm|yarn)\\s+(i|install|add)\\b'
scope: tool:bash
---
This project uses pnpm. Use \`pnpm add <pkg>\`, never npm or yarn.
`;

const NO_CLAIMS = `---
condition: 'all tests pass'
scope: text
---
Do not claim tests pass without running them.
`;

const ALWAYS = `---
alwaysApply: true
condition: 'console\\.log'
scope: tool:write
---
Use the package logger, never console.log.
`;

let home: string;
const savedHome = process.env.HOME;

before(async () => {
	// Rules and settings come from this fake home, never from the real one.
	home = await mkdtemp(join(tmpdir(), "pi-time-travel-home-"));
	process.env.HOME = home;
	await mkdir(join(home, ".agents", "ttsr"), { recursive: true });
	await writeFile(join(home, ".agents", "ttsr", "use-pnpm.md"), USE_PNPM);
	await writeFile(join(home, ".agents", "ttsr", "no-claims.md"), NO_CLAIMS);
	await writeFile(join(home, ".agents", "ttsr", "use-logger.md"), ALWAYS);
});

after(async () => {
	process.env.HOME = savedHome;
	await rm(home, { recursive: true, force: true });
});

type Context = Parameters<Extract<FauxResponseStep, (...args: never[]) => unknown>>[0];

/** A real AgentSession with the built-in tools, on the faux provider. Records each request's context. */
async function start(responses: Array<(context: Context) => ReturnType<typeof fauxAssistantMessage>>, config: object = {}, tools = ["bash"]) {
	await writeFile(join(home, ".agents", "ttsr", "config.json"), JSON.stringify({ judge: { mode: "off" }, ...config }));
	const dir = await mkdtemp(join(tmpdir(), "pi-time-travel-"));
	const requests: Context[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4000 }] });
	faux.setResponses(
		responses.map((respond) => (context: Context) => {
			requests.push(structuredClone(context));
			return respond(context);
		}),
	);
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "test");
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		extensionFactories: [timeTravel],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager,
		tools,
	});
	await modelRuntime.refresh({ allowNetwork: false });
	await session.bindExtensions({});
	return {
		dir,
		session,
		requests,
		entries: () => sessionManager.getEntries(),
		dispose: async () => {
			session.dispose();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** Every tool call and text the model would see in a request. */
function visible(context: Context): string {
	return JSON.stringify(context.messages);
}

test("a violating tool call never runs, is withdrawn from context, and the agent resumes with the rule", async () => {
	const run = await start([
		() => fauxAssistantMessage([fauxText("Installing with npm."), fauxToolCall("bash", { command: ": npm install lodash; touch npm-ran" }, { id: "call_npm" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxToolCall("bash", { command: "touch pnpm-ran" }, { id: "call_pnpm" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage("Added lodash with pnpm."),
	]);
	try {
		await run.session.prompt("Add lodash.");
		assert.equal(existsSync(join(run.dir, "npm-ran")), false, "the npm command was blocked before it ran");
		assert.equal(existsSync(join(run.dir, "pnpm-ran")), true, "the agent resumed and ran the compliant command");
		assert.equal(run.requests.length, 3);

		const resumed = run.requests[1]!;
		assert.doesNotMatch(visible(resumed), /call_npm|toolCall/, "the withdrawn tool call is gone from the model's context");
		assert.doesNotMatch(visible(resumed), /Installing with npm/, "so is the withdrawn prose");
		const last = resumed.messages.at(-1)!;
		assert.equal(last.role, "user", "the resumed request ends with a user-role message");
		assert.match(JSON.stringify(last), /system-interrupt[^]*use-pnpm[^]*pnpm add/);

		const entries = run.entries();
		const edits = entries.filter((entry) => entry.type === "context_edit");
		assert.equal(edits.length, 2, "the assistant message and its tool result are both withdrawn");
		const record = entries.find((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
		assert.deepEqual((record as { data: { action: string; rules: string[] } }).data.action, "withdraw");
		const hidden = entries.find((entry) => entry.type === "custom_message" && entry.customType === MESSAGE_TYPE);
		assert.equal((hidden as { display: boolean }).display, false);
	} finally {
		await run.dispose();
	}
});

test("a violating final message is withdrawn and answered again", async () => {
	const run = await start([() => fauxAssistantMessage("Done, all tests pass."), () => fauxAssistantMessage("Done. I have not run the tests.")]);
	try {
		await run.session.prompt("Fix it.");
		assert.equal(run.requests.length, 2, "one extra request to answer again");
		assert.doesNotMatch(visible(run.requests[1]!), /all tests pass"/);
		assert.match(JSON.stringify(run.requests[1]!.messages.at(-1)), /no-claims/);
	} finally {
		await run.dispose();
	}
});

test("keep mode blocks the call with the rule as its result and leaves the context alone", async () => {
	const run = await start(
		[
			() => fauxAssistantMessage([fauxToolCall("bash", { command: ": npm install lodash; touch npm-ran" }, { id: "call_npm" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage("Switching to pnpm."),
		],
		{ contextMode: "keep" },
	);
	try {
		await run.session.prompt("Add lodash.");
		assert.equal(existsSync(join(run.dir, "npm-ran")), false);
		assert.equal(run.entries().some((entry) => entry.type === "context_edit"), false);
		const second = visible(run.requests[1]!);
		assert.match(second, /npm install lodash/, "the attempt stays in context");
		assert.match(second, /blocked before it ran[^]*pnpm add/, "with the rule as the tool result");
	} finally {
		await run.dispose();
	}
});

test("repeatMode once lets a second violation through; the default blocks every one", async () => {
	const attempt = (id: string) => () => fauxAssistantMessage([fauxToolCall("bash", { command: `: npm install lodash; touch ${id}` }, { id })], { stopReason: "toolUse" });
	for (const [repeatMode, ran] of [["once", true], ["always", false]] as const) {
		const run = await start([attempt("first"), attempt("second"), () => fauxAssistantMessage("ok")], { repeatMode });
		try {
			await run.session.prompt("Add lodash.");
			assert.equal(existsSync(join(run.dir, "first")), false);
			assert.equal(existsSync(join(run.dir, "second")), ran, `repeatMode ${repeatMode}`);
		} finally {
			await run.dispose();
		}
	}
});

test("withdrawals per run are capped, so a model that keeps violating cannot loop", async () => {
	const claim = () => fauxAssistantMessage("all tests pass");
	const run = await start([claim, claim, claim, claim, claim], { maxRewindsPerRun: 2 });
	try {
		await run.session.prompt("Fix it.");
		assert.equal(run.requests.length, 3, "the first answer plus two withdrawals");
	} finally {
		await run.dispose();
	}
});

test("compliant work passes untouched", async () => {
	const run = await start([
		() => fauxAssistantMessage([fauxToolCall("bash", { command: "rg -n 'npm' README.md; touch searched" }, { id: "call_rg" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage("Found nothing."),
	]);
	try {
		await run.session.prompt("Where is npm mentioned?");
		assert.equal(existsSync(join(run.dir, "searched")), true);
		assert.equal(run.entries().some((entry) => entry.type === "custom" || entry.type === "context_edit"), false);
	} finally {
		await run.dispose();
	}
});

test("alwaysApply rules are in the system prompt from the first request, in their own section", async () => {
	const run = await start([() => fauxAssistantMessage("ok")]);
	try {
		await run.session.prompt("Hello.");
		// The prompt reaches the provider as sections of a leading system message.
		const first = run.requests[0]!;
		const system = JSON.stringify(first.messages.filter((message) => (message.role as string) === "system"));
		assert.match(system, /<time_travel_rules>[^]*<rule name=\\"use-logger\\">[^]*never console\.log[^]*<\/time_travel_rules>/);
		assert.doesNotMatch(system, /use-pnpm/, "rules without alwaysApply are not given up front");
	} finally {
		await run.dispose();
	}
});

test("an ignoreNewFiles rule lets the agent edit a test file it wrote, and still guards existing ones", async () => {
	const ruleFile = join(home, ".agents", "ttsr", "existing-tests.md");
	await writeFile(ruleFile, "---\ncondition: '^'\nscope: tool:edit(test/**), tool:write(test/**)\nignoreNewFiles: true\n---\nDo not change existing tests.");
	const call = (name: string, input: Parameters<typeof fauxToolCall>[1], id: string) => () => fauxAssistantMessage([fauxToolCall(name, input, { id })], { stopReason: "toolUse" });
	const run = await start(
		[
			call("write", { path: "test/new.test.js", content: "one" }, "w1"),
			call("edit", { path: "test/new.test.js", edits: [{ oldText: "one", newText: "two" }] }, "e1"),
			call("edit", { path: "test/old.test.js", edits: [{ oldText: "old", newText: "changed" }] }, "e2"),
			() => fauxAssistantMessage("Done."),
		],
		{},
		["bash", "write", "edit"],
	);
	try {
		await mkdir(join(run.dir, "test"));
		await writeFile(join(run.dir, "test", "old.test.js"), "old");
		await run.session.prompt("Add a test.");
		assert.equal(readFileSync(join(run.dir, "test", "new.test.js"), "utf8"), "two", "its own new file: written, then edited");
		assert.equal(readFileSync(join(run.dir, "test", "old.test.js"), "utf8"), "old", "the existing test was not touched");
		assert.match(JSON.stringify(run.requests.at(-1)!.messages.at(-1)), /existing-tests/);
	} finally {
		await run.dispose();
		await rm(ruleFile);
	}
});
