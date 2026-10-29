import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CompactOptions, ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand, SessionManager } from "@earendil-works/pi-coding-agent";
import backgroundCompaction from "../index.ts";
import { assistant, deferred, session, settle, until } from "./helpers.ts";

const model = (id: string, api = "openai-responses") => ({ provider: "test", id, api, contextWindow: 100_000, maxTokens: 4000 }) as Model<Api>;
const SETTINGS = { enabled: true, reserveTokens: 8000, keepRecentTokens: 4000 };

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;

/**
 * The extension with a fake Pi. `file` gives the session a file, so summary jobs are stored and
 * survive a restart; a restart is a new harness on the same `manager` and `file`.
 */
function harness(settings: Record<string, unknown> = {}, shared: { manager?: SessionManager; ids?: string[]; file?: string } = {}) {
	const created = shared.manager ? undefined : session(14);
	const manager = shared.manager ?? created!.manager;
	const ids = shared.ids ?? created!.ids;
	const models = [model("expensive"), model("cheap"), model("other"), model("router", "pi-virtual")];
	const authenticated = new Set(models.map((model) => model.id));
	const calls: { model: Model<Api>; signal?: AbortSignal; result: ReturnType<typeof deferred<AssistantMessage>> }[] = [];
	const notices: { text: string; type: string }[] = [];
	const statuses: (string | undefined)[] = [];
	const compacts: (CompactOptions | undefined)[] = [];
	const handlers = new Map<string, (event: never, context: ExtensionContext) => unknown>();
	let command: Command;
	let tokens = 20_000;
	let idle = true;
	const sessionManager = shared.file
		? (new Proxy(manager, {
				get: (target, property) => {
					if (property === "getSessionFile") return () => shared.file;
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as SessionManager)
		: manager;
	const context = {
		cwd: "/tmp/project",
		hasUI: true,
		model: models[0],
		thinkingLevel: "off",
		sessionManager,
		getContextUsage: () => ({ tokens, contextWindow: 40_000 }),
		isIdle: () => idle,
		compact: (options?: CompactOptions) => { compacts.push(options); },
		modelRegistry: {
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: Model<Api>) => authenticated.has(model.id),
			getAvailable: () => models.filter((model) => authenticated.has(model.id)),
			streamSimple: (model: Model<Api>, _context: unknown, options: SimpleStreamOptions) => {
				const result = deferred<AssistantMessage>();
				calls.push({ model, signal: options.signal, result });
				return { result: () => result.promise };
			},
		},
		ui: {
			notify: (text: string, type: string) => { notices.push({ text, type }); },
			setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
		},
	} as unknown as ExtensionCommandContext;
	const api = {
		on: (event: string, handler: (event: never, context: ExtensionContext) => unknown) => { handlers.set(event, handler); },
		registerCommand: (_name: string, registered: Command) => { command = registered; },
		// Retries back off for 10 ms here rather than 10 s.
		getSettings: () => ({ compaction: SETTINGS, backgroundCompaction: { minTokens: 0, retryDelayMs: 10, ...settings } }),
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
	} as unknown as ExtensionAPI;
	const reload = () => backgroundCompaction(api);
	reload();
	const emit = async (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, context);
	return {
		calls, notices, statuses, compacts, authenticated, manager, ids, context,
		reload, emit,
		setTokens: (value: number) => { tokens = value; },
		setIdle: (value: boolean) => { idle = value; },
		command: (args: string) => command.handler(args, context),
		complete: (prefix: string) => command.getArgumentCompletions!(prefix),
		finish: async (index: number, text = "summary") => { calls[index]!.result.resolve(assistant(text)); await settle(); },
		compact: (reason = "threshold", customInstructions?: string) => emit("session_before_compact", {
			preparation: { settings: SETTINGS, tokensBefore: 33_000 }, reason, customInstructions, signal: new AbortController().signal,
		}),
	};
}

test("off by default; status, model selection and start never implicitly enable", async () => {
	const h = harness();
	await h.emit("session_start");
	h.setTokens(30_000);
	await h.emit("agent_settled");
	await h.command("");
	assert.match(h.notices.at(-1)!.text, /Background compaction off/);
	assert.match(h.notices.at(-1)!.text, /Compaction model: not set/);
	await h.command("on");
	assert.equal(h.notices.at(-1)!.type, "error");
	assert.match(h.notices.at(-1)!.text, /set a compaction model/);
	await h.command("start");
	assert.equal(h.notices.at(-1)!.type, "error");
	await h.command("model test/cheap");
	assert.match(h.notices.at(-1)!.text, /off; run \/bg-compact on/);
	await h.emit("agent_settled");
	await settle();
	assert.equal(h.calls.length, 0);
	assert.equal(await h.compact(), undefined, "off leaves Pi's built-in compaction alone");
	await h.command("on");
	await until(() => h.calls.length === 1, "the summary request");
	assert.equal(h.calls[0]!.model.id, "cheap");
	assert.match(h.statuses.at(-1)!, /writing test\/cheap/);
	await h.command("on");
	await settle();
	assert.equal(h.calls.length, 1, "repeated on must not restart a paid request");
	assert.equal(h.calls[0]!.signal?.aborted, false);
	await h.finish(0);
	await until(() => /ready test\/cheap/.test(h.statuses.at(-1) ?? ""), "the ready status");
	await h.command("off");
	assert.equal(h.statuses.at(-1), "compact: off");
});

test("invalid, unavailable, unauthenticated and virtual models cannot be selected or enabled", async () => {
	const h = harness();
	await h.emit("session_start");
	h.authenticated.delete("other");
	for (const selector of ["session", "cheap", "missing/model", "test/other", "test/router"]) {
		await h.command(`model ${selector}`);
		assert.equal(h.notices.at(-1)!.type, "error", selector);
	}
	await h.command("model test/cheap");
	h.authenticated.delete("cheap");
	await h.command("on");
	assert.match(h.notices.at(-1)!.text, /Cannot enable.*not signed in/);
	assert.equal(h.statuses.at(-1), "compact: off");
	assert.equal(h.calls.length, 0);
});

test("model and on/off commands reject extra arguments and implicit toggles", async () => {
	const h = harness();
	await h.emit("session_start");
	for (const args of ["toggle", "on test/cheap", "off now", "model test/cheap extra", "start now", "unknown"]) {
		await h.command(args);
		assert.equal(h.notices.at(-1)!.type, "error", args);
		assert.match(h.notices.at(-1)!.text, /Switching requires explicit on or off/);
	}
	assert.equal(h.calls.length, 0);
	assert.deepEqual((await h.complete("o"))?.map((item) => item.value), ["on", "off"]);
	assert.deepEqual((await h.complete("model test/ch"))?.map((item) => item.value), ["model test/cheap"]);
	assert.ok(!(await h.complete("model "))?.some((item) => item.value.includes("router")));
});

test("changing the model cancels old work, stays off, and needs another explicit on", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("model test/cheap");
	await h.command("on");
	await h.command("start");
	await until(() => h.calls.length === 1, "the summary request");
	await h.command("model test/other");
	await until(() => h.calls[0]!.signal?.aborted === true, "the request to abort");
	await h.finish(0); // A provider ignoring abort must not resurrect the old summary.
	await h.command("status");
	assert.match(h.notices.at(-1)!.text, /off: idle/);
	assert.match(h.notices.at(-1)!.text, /Compaction model: test\/other/);
	await h.command("start");
	await settle();
	assert.equal(h.calls.length, 1);
	await h.command("on");
	await h.command("start");
	await until(() => h.calls.length === 2, "the second request");
	assert.equal(h.calls[1]!.model.id, "other");
	await h.finish(1);
	await h.command("off");
});

test("the compaction hook returns at once while a summary never finishes", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	const durations: number[] = [];
	for (let i = 0; i < 20; i++) {
		const started = performance.now();
		assert.deepEqual(await h.compact(), { cancel: true });
		durations.push(performance.now() - started);
		await settle(5);
	}
	assert.ok(Math.max(...durations) < 50, `slowest hook ${Math.max(...durations).toFixed(1)} ms`);
	await until(() => h.calls.length === 1, "the summary request");
	await settle();
	assert.equal(h.calls.length, 1, "deferred compactions share one request");
	assert.equal(h.calls[0]!.signal?.aborted, false);
	await h.finish(0, "ready at last");
	await until(() => /ready/.test(h.statuses.at(-1) ?? ""), "the ready status");
	const result = (await h.compact()) as { compaction: { summary: string } };
	assert.match(result.compaction.summary, /ready at last/);
	await h.command("off");
});

test("off cancels the background request of a deferred compaction without falling through to Pi", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	await h.command("start");
	await until(() => h.calls.length === 1, "the summary request");
	assert.deepEqual(await h.compact(), { cancel: true });
	await h.command("off");
	await until(() => h.calls[0]!.signal?.aborted === true, "the request to abort");
	await h.finish(0);
	assert.equal(h.statuses.at(-1), "compact: off");
	h.setTokens(35_000);
	await h.emit("agent_settled");
	await settle();
	assert.equal(h.calls.length, 1);
});

test("model failures are retried in the background and never fall back to the expensive session model", async () => {
	const h = harness({ enabled: true, model: "test/cheap", retries: 1 });
	await h.emit("session_start");
	assert.deepEqual(await h.compact(), { cancel: true });
	await until(() => h.calls.length === 1, "the summary request");
	h.calls[0]!.result.reject(new Error("provider unavailable"));
	await until(() => h.calls.length === 2, "the retry");
	h.calls[1]!.result.reject(new Error("provider unavailable"));
	await until(() => h.notices.some((notice) => /summary with test\/cheap failed: provider unavailable/.test(notice.text)), "the failure warning");
	assert.deepEqual(await h.compact(), { cancel: true });
	h.authenticated.delete("cheap");
	assert.deepEqual(await h.compact(), { cancel: true });
	assert.match(h.notices.at(-1)!.text, /not signed in/);
	h.setTokens(30_000);
	await h.emit("agent_settled");
	await settle();
	assert.deepEqual(h.calls.map((call) => call.model.id), ["cheap", "cheap"]);
});

test("a transient failure is retried and the retried summary is used", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	await h.command("start");
	await until(() => h.calls.length === 1, "the summary request");
	h.calls[0]!.result.reject(new Error("overloaded"));
	await until(() => h.calls.length === 2, "the retry");
	await h.finish(1, "second attempt");
	await until(() => /ready/.test(h.statuses.at(-1) ?? ""), "the ready status");
	const result = (await h.compact()) as { compaction: { summary: string; details: { backgroundCompaction: { requests: number } } } };
	assert.match(result.compaction.summary, /second attempt/);
	assert.equal(result.compaction.details.backgroundCompaction.requests, 1);
	await h.command("off");
});

test("a deferred /compact runs once its summary is ready and the agent is idle", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	assert.deepEqual(await h.compact("manual", "keep the test names"), { cancel: true });
	assert.match(h.notices.at(-1)!.text, /compacts when it is ready/);
	await until(() => h.calls.length === 1, "the summary request");
	h.setIdle(false);
	await h.finish(0, "focused");
	await settle();
	assert.equal(h.compacts.length, 0, "not while the agent is running");
	h.setIdle(true);
	await h.emit("agent_settled");
	assert.deepEqual(h.compacts, [{ customInstructions: "keep the test names", onError: h.compacts[0]?.onError }]);
	const result = (await h.compact("manual", "keep the test names")) as { compaction: { summary: string } };
	assert.match(result.compaction.summary, /focused/);
	await h.command("off");
});

test("cancel drops work but does not turn the extension off", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	await h.command("start");
	await until(() => h.calls.length === 1, "the summary request");
	await h.command("cancel");
	await until(() => h.calls[0]!.signal?.aborted === true, "the request to abort");
	assert.match(h.notices.at(-1)!.text, /remains on \(test\/cheap\)/);
	await h.finish(0);
	assert.match(h.statuses.at(-1)!, /idle test\/cheap/);
	await h.command("start");
	await until(() => h.calls.length === 2, "the second request");
	await h.finish(1);
	await h.command("off");
});

test("a summary being written survives a restart, and a finished one is restored", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "bg-compaction-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { manager, ids } = session(14);
		const shared = { manager, ids, file: join(agentDir, "session.jsonl") };
		const first = harness({ enabled: true, model: "test/cheap" }, shared);
		await first.emit("session_start");
		await first.command("start");
		await until(() => first.calls.length === 1, "the summary request");
		// Pi exits while the summary is being written.
		await first.emit("session_shutdown");
		assert.equal(first.calls[0]!.signal?.aborted, true);
		const stored = await readdir(join(agentDir, "background-compaction"));
		assert.ok(stored.some((name) => name.endsWith(".db")));
		const second = harness({ enabled: true, model: "test/cheap" }, shared);
		await second.emit("session_start");
		await until(() => second.calls.length === 1, "the resumed request");
		await second.finish(0, "resumed summary");
		await until(() => /ready/.test(second.statuses.at(-1) ?? ""), "the ready status");
		// Exiting with a finished summary keeps it for the next process.
		await second.emit("session_shutdown");
		const third = harness({ enabled: true, model: "test/cheap" }, shared);
		await third.emit("session_start");
		await until(() => /ready/.test(third.statuses.at(-1) ?? ""), "the restored summary");
		const result = (await third.compact()) as { compaction: { summary: string } };
		assert.match(result.compaction.summary, /resumed summary/);
		assert.equal(third.calls.length, 0, "the restored summary needs no request");
		// A compaction uses the summary up; nothing is left to store.
		await third.emit("session_compact");
		await third.emit("session_shutdown");
		await settle();
		assert.deepEqual(await readdir(join(agentDir, "background-compaction")), []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("a stored request that a newer one replaced is dropped without running", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "bg-compaction-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { manager, ids } = session(14);
		const shared = { manager, ids, file: join(agentDir, "session.jsonl") };
		const first = harness({ enabled: true, model: "test/cheap" }, shared);
		await first.emit("session_start");
		await first.command("start");
		await until(() => first.calls.length === 1, "the summary request");
		await first.emit("session_shutdown");
		// The next process starts off, so nothing opens the stored jobs until a summary is requested.
		const second = harness({ model: "test/cheap" }, shared);
		await second.emit("session_start");
		await second.command("on");
		await second.command("start");
		await until(() => second.calls.length === 1, "the new request");
		await second.finish(0, "new summary");
		await until(() => /ready/.test(second.statuses.at(-1) ?? ""), "the ready status");
		assert.equal(second.calls.length, 1, "the replaced request never ran again");
		const result = (await second.compact()) as { compaction: { summary: string } };
		assert.match(result.compaction.summary, /new summary/);
		await second.command("off");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("session controls survive reload and tree navigation without modifying file settings", async () => {
	const h = harness({ enabled: true, model: "test/expensive" });
	await h.emit("session_start");
	await h.command("model test/cheap");
	await h.command("on");
	await h.emit("session_shutdown");
	h.reload();
	await h.emit("session_start");
	await h.command("status");
	assert.match(h.notices.at(-1)!.text, /Background compaction on/);
	assert.match(h.notices.at(-1)!.text, /Compaction model: test\/cheap/);
	await h.command("off");
	h.manager.branch(h.ids[10]!);
	await h.emit("session_tree");
	await h.emit("session_shutdown");
	h.reload();
	await h.emit("session_start");
	await h.command("status");
	assert.match(h.notices.at(-1)!.text, /Background compaction off/);
	assert.match(h.notices.at(-1)!.text, /Compaction model: test\/cheap/);
	await settle();
	assert.equal(h.calls.length, 0);
});

test("file settings cannot enable without a model; commands can repair legacy session selection", async () => {
	for (const settings of [{ enabled: true }, { enabled: true, model: "session" }, { enabled: true, model: "missing/model" }]) {
		const h = harness(settings);
		await h.emit("session_start");
		h.setTokens(30_000);
		await h.emit("agent_settled");
		assert.equal(h.statuses.at(-1), "compact: off");
		assert.equal(h.calls.length, 0);
		await h.command("off");
		assert.equal(h.notices.at(-1)!.type, "info");
		await h.command("model test/cheap");
		await h.command("on");
		await until(() => h.calls.length === 1, "the summary request");
		assert.equal(h.calls[0]!.model.id, "cheap");
		await h.finish(0);
		await h.command("off");
	}
});
