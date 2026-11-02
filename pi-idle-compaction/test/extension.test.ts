import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import idleCompaction, { describe, ENTRY_TYPE, type IdleCompactionEntry } from "../index.ts";

const MINUTE = 60_000;

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function setup(settings: unknown = {}, state: { tokens?: number | null; idle?: boolean; pending?: boolean; mode?: string } = {}) {
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const compactions: CompactOptions[] = [];
	let renderer: ((entry: any, options: any, theme: any) => any) | undefined;

	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		getSettings: () => settings,
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		registerEntryRenderer: (_type: string, fn: typeof renderer) => {
			renderer = fn;
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: state.mode ?? "tui",
		hasUI: true,
		ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
		isIdle: () => state.idle ?? true,
		hasPendingMessages: () => state.pending ?? false,
		getContextUsage: () => ({ tokens: state.tokens === undefined ? 180_000 : state.tokens, contextWindow: 400_000, percent: null }),
		compact: (options: CompactOptions) => compactions.push(options),
	} as unknown as ExtensionContext;

	idleCompaction(pi);
	const emit = (event: string, payload: object = {}) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event, ...payload }, ctx);
	};
	return { emit, entries, notices, compactions, state, renderer: () => renderer! };
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

test("compacts after 5 idle minutes once the context reaches 150k tokens", () => {
	const { emit, compactions } = setup();
	emit("agent_settled", { aborted: false });
	mock.timers.tick(5 * MINUTE - 1);
	assert.equal(compactions.length, 0);
	mock.timers.tick(1);
	assert.equal(compactions.length, 1);
	mock.timers.tick(60 * MINUTE);
	assert.equal(compactions.length, 1, "compacts once per idle period");
});

test("does nothing below the token threshold or when the token count is unknown", () => {
	for (const tokens of [149_999, null]) {
		const { emit, compactions } = setup({}, { tokens });
		emit("agent_settled", { aborted: false });
		mock.timers.tick(5 * MINUTE);
		assert.equal(compactions.length, 0);
	}
});

test("activity cancels the idle timer and settling restarts it", () => {
	const { emit, compactions } = setup();
	emit("agent_settled", { aborted: false });
	mock.timers.tick(4 * MINUTE);
	emit("agent_start");
	mock.timers.tick(10 * MINUTE);
	assert.equal(compactions.length, 0);
	emit("agent_settled", { aborted: false });
	mock.timers.tick(5 * MINUTE);
	assert.equal(compactions.length, 1);
});

test("a resumed session left idle is compacted, and shutdown cancels the timer", () => {
	const resumed = setup();
	resumed.emit("session_start", { reason: "resume" });
	mock.timers.tick(5 * MINUTE);
	assert.equal(resumed.compactions.length, 1);

	const closed = setup();
	closed.emit("session_start", { reason: "startup" });
	closed.emit("session_shutdown", { reason: "quit" });
	mock.timers.tick(5 * MINUTE);
	assert.equal(closed.compactions.length, 0);
});

test("skips when the agent is busy or has queued messages when the timer fires", () => {
	const busy = setup({}, { idle: false });
	busy.emit("agent_settled", { aborted: false });
	mock.timers.tick(5 * MINUTE);
	assert.equal(busy.compactions.length, 0);

	const queued = setup({}, { pending: true });
	queued.emit("agent_settled", { aborted: false });
	mock.timers.tick(5 * MINUTE);
	assert.equal(queued.compactions.length, 0);
});

test("a cache-warming refresh while idle restarts the idle clock", () => {
	const { emit, compactions } = setup();
	emit("agent_settled", { aborted: false });
	mock.timers.tick(4 * MINUTE);
	emit("cache_warming_decision", { action: "warm" });
	mock.timers.tick(4 * MINUTE);
	assert.equal(compactions.length, 0);
	emit("cache_warming_decision", { action: "stop" });
	mock.timers.tick(1 * MINUTE);
	assert.equal(compactions.length, 1);
});

test("honours configured threshold, idle time and the off switch", () => {
	const custom = setup({ idleCompaction: { tokenThreshold: 50_000, idleMinutes: 1 } }, { tokens: 60_000 });
	custom.emit("agent_settled", { aborted: false });
	mock.timers.tick(1 * MINUTE);
	assert.equal(custom.compactions.length, 1);

	const off = setup({ idleCompaction: false });
	off.emit("agent_settled", { aborted: false });
	mock.timers.tick(60 * MINUTE);
	assert.equal(off.compactions.length, 0);
});

test("invalid settings warn once and leave idle compaction off", () => {
	const { emit, compactions, notices } = setup({ idleCompaction: { idleMinutes: -1 } });
	emit("agent_settled", { aborted: false });
	emit("agent_settled", { aborted: false });
	mock.timers.tick(60 * MINUTE);
	assert.equal(compactions.length, 0);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!.message, /Idle compaction is off: settings\.idleCompaction\.idleMinutes/);
	assert.equal(notices[0]!.type, "warning");
});

test("a completed compaction records a notice rendered dim and italic", () => {
	const { emit, compactions, entries, notices, renderer } = setup();
	emit("agent_settled", { aborted: false });
	mock.timers.tick(5 * MINUTE);
	compactions[0]!.onComplete!({ summary: "s", firstKeptEntryId: "e", tokensBefore: 182_400 });

	assert.deepEqual(entries, [{ type: ENTRY_TYPE, data: { tokensBefore: 182_400, idleMinutes: 5 } }]);
	assert.equal(notices.length, 0, "the TUI draws the entry; no extra notification");

	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, italic: (text: string) => `<i>${text}</i>` };
	const lines: string[] = renderer()({ type: "custom", customType: ENTRY_TYPE, data: entries[0]!.data }, { expanded: false }, theme).render(200);
	const text = lines.join("\n");
	assert.match(text, /<dim><i>Idle compaction: compacted 182,400 tokens after 5 min idle, since the prompt cache had expired\./);
});

test("RPC clients get the notice as an info notification", () => {
	const { emit, compactions, notices } = setup({}, { mode: "rpc" });
	emit("agent_settled", { aborted: false });
	mock.timers.tick(5 * MINUTE);
	compactions[0]!.onComplete!({ summary: "s", firstKeptEntryId: "e", tokensBefore: 160_000 });
	assert.deepEqual(notices, [{ message: describe({ tokensBefore: 160_000, idleMinutes: 5 } satisfies IdleCompactionEntry), type: "info" }]);
});
