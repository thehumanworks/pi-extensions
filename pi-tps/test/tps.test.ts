import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import tpsExtension from "../index.ts";

function assistant(usage: Partial<AssistantMessage["usage"]> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...usage,
		},
	};
}

function harness(t: TestContext, hasUI = true) {
	type Event = AgentStartEvent | AgentEndEvent;
	const handlers = new Map<string, ExtensionHandler<Event>>();
	const notices: { message: string; type?: string }[] = [];
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	tpsExtension({
		on: (name: string, handler: ExtensionHandler<Event>) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
	} as unknown as ExtensionAPI);
	const ctx = {
		hasUI,
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, type }),
		},
	} as unknown as ExtensionContext;
	return {
		notices,
		advance: (ms: number) => { now += ms; },
		start: () => handlers.get("agent_start")!({ type: "agent_start" }, ctx),
		end: (messages: AgentEndEvent["messages"]) =>
			handlers.get("agent_end")!({ type: "agent_end", messages }, ctx),
	};
}

test("reports combined assistant usage over the full agent run", async (t) => {
	const h = harness(t);
	await h.start();
	h.advance(2_500);
	await h.end([
		{ role: "user", content: "hello", timestamp: 0 },
		assistant({ input: 10, output: 30, cacheRead: 5, cacheWrite: 2, totalTokens: 47 }),
		{ role: "toolResult", toolCallId: "call", toolName: "test", content: [], isError: false, timestamp: 0 },
		assistant({ input: 20, output: 70, cacheRead: 15, cacheWrite: 3, totalTokens: 108 }),
	]);
	assert.deepEqual(h.notices, [{
		message: "TPS 40.0 tok/s. out 100, in 30, cache r/w 20/5, total 155, 2.5s",
		type: "info",
	}]);
});

test("does not notify without an interactive UI", async (t) => {
	const h = harness(t, false);
	await h.start();
	h.advance(1_000);
	await h.end([assistant({ output: 10 })]);
	assert.deepEqual(h.notices, []);
});

test("skips runs without a start, output tokens, or positive elapsed time", async (t) => {
	const h = harness(t);
	await h.end([assistant({ output: 10 })]);
	await h.start();
	await h.end([assistant({ output: 10 })]);
	await h.start();
	h.advance(-1);
	await h.end([assistant({ output: 10 })]);
	await h.start();
	h.advance(1_000);
	await h.end([]);
	await h.start();
	h.advance(1_000);
	await h.end([assistant({ input: 10 })]);
	assert.deepEqual(h.notices, []);
});

test("reports each run once and starts fresh timing and usage for the next run", async (t) => {
	const h = harness(t);
	const messages = [assistant({ output: 10, totalTokens: 10 })];
	await h.start();
	h.advance(1_000);
	await h.end(messages);
	await h.end(messages);
	h.advance(10_000);
	await h.start();
	h.advance(2_000);
	await h.end(messages);
	assert.deepEqual(h.notices.map(({ message }) => message), [
		"TPS 10.0 tok/s. out 10, in 0, cache r/w 0/0, total 10, 1.0s",
		"TPS 5.0 tok/s. out 10, in 0, cache r/w 0/0, total 10, 2.0s",
	]);
});
