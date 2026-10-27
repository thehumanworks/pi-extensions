import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import backgroundCompaction from "../index.ts";
import { assistant, deferred, session, tick } from "./helpers.ts";

const model = (id: string, api = "openai-responses") => ({ provider: "test", id, api, contextWindow: 100_000, maxTokens: 4000 }) as Model<Api>;
const SETTINGS = { enabled: true, reserveTokens: 8000, keepRecentTokens: 4000 };

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;

function harness(settings: Record<string, unknown> = {}) {
	const { manager, ids } = session(14);
	const models = [model("expensive"), model("cheap"), model("other"), model("router", "pi-virtual")];
	const authenticated = new Set(models.map((model) => model.id));
	const calls: { model: Model<Api>; signal?: AbortSignal; result: ReturnType<typeof deferred<AssistantMessage>> }[] = [];
	const notices: { text: string; type: string }[] = [];
	const statuses: (string | undefined)[] = [];
	const handlers = new Map<string, (event: never, context: ExtensionContext) => unknown>();
	let command: Command;
	let tokens = 20_000;
	const context = {
		cwd: "/tmp/project",
		hasUI: true,
		model: models[0],
		thinkingLevel: "off",
		sessionManager: manager,
		getContextUsage: () => ({ tokens, contextWindow: 40_000 }),
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
		getSettings: () => ({ compaction: SETTINGS, backgroundCompaction: { minTokens: 0, ...settings } }),
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
	} as unknown as ExtensionAPI;
	const reload = () => backgroundCompaction(api);
	reload();
	const emit = async (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, context);
	return {
		calls, notices, statuses, authenticated, manager, ids, context,
		reload, emit,
		setTokens: (value: number) => { tokens = value; },
		command: (args: string) => command.handler(args, context),
		complete: (prefix: string) => command.getArgumentCompletions!(prefix),
		finish: async (index: number) => { calls[index]!.result.resolve(assistant("summary")); await tick(); },
		compact: () => emit("session_before_compact", {
			preparation: { settings: SETTINGS, tokensBefore: 33_000 }, reason: "threshold", signal: new AbortController().signal,
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
	assert.equal(h.calls.length, 0);
	assert.equal(await h.compact(), undefined, "off leaves Pi's built-in compaction alone");
	await h.command("on");
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0]!.model.id, "cheap");
	assert.match(h.statuses.at(-1)!, /writing test\/cheap/);
	await h.command("on");
	assert.equal(h.calls.length, 1, "repeated on must not restart a paid request");
	assert.equal(h.calls[0]!.signal?.aborted, false);
	await h.finish(0);
	assert.match(h.statuses.at(-1)!, /ready test\/cheap/);
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
	assert.equal(h.calls.length, 1);
	await h.command("model test/other");
	assert.equal(h.calls[0]!.signal?.aborted, true);
	await h.finish(0); // A provider ignoring abort must not resurrect the old summary.
	await h.command("status");
	assert.match(h.notices.at(-1)!.text, /off: idle/);
	assert.match(h.notices.at(-1)!.text, /Compaction model: test\/other/);
	await h.command("start");
	assert.equal(h.calls.length, 1);
	await h.command("on");
	await h.command("start");
	assert.equal(h.calls[1]!.model.id, "other");
	await h.finish(1);
	await h.command("off");
});

test("off cancels a compaction waiting for the background request without falling through to Pi", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	await h.command("start");
	const taking = h.compact();
	await tick();
	await h.command("off");
	assert.equal(h.calls[0]!.signal?.aborted, true);
	assert.deepEqual(await taking, { cancel: true });
	await h.finish(0);
	h.setTokens(35_000);
	await h.emit("agent_settled");
	assert.equal(h.calls.length, 1);
});

test("off aborts foreground work and ignores its late result", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	const taking = h.compact();
	await tick();
	assert.equal(h.calls.length, 1);
	await h.command("off");
	assert.equal(h.calls[0]!.signal?.aborted, true);
	await h.finish(0);
	assert.deepEqual(await taking, { cancel: true });
});

test("model failures and lost auth never fall back to the expensive session model", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	const taking = h.compact();
	await tick();
	h.calls[0]!.result.reject(new Error("provider unavailable"));
	assert.deepEqual(await taking, { cancel: true });
	assert.match(h.notices.at(-1)!.text, /compaction with test\/cheap cancelled/);
	h.authenticated.delete("cheap");
	assert.deepEqual(await h.compact(), { cancel: true });
	assert.match(h.notices.at(-1)!.text, /not signed in/);
	h.setTokens(30_000);
	await h.emit("agent_settled");
	assert.deepEqual(h.calls.map((call) => call.model.id), ["cheap"]);
});

test("cancel drops work but does not turn the extension off", async () => {
	const h = harness({ enabled: true, model: "test/cheap" });
	await h.emit("session_start");
	await h.command("start");
	await h.command("cancel");
	assert.equal(h.calls[0]!.signal?.aborted, true);
	assert.match(h.notices.at(-1)!.text, /remains on \(test\/cheap\)/);
	await h.finish(0);
	assert.match(h.statuses.at(-1)!, /idle test\/cheap/);
	await h.command("start");
	assert.equal(h.calls.length, 2);
	await h.finish(1);
	await h.command("off");
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
		assert.equal(h.calls[0]!.model.id, "cheap");
		await h.finish(0);
		await h.command("off");
	}
});
