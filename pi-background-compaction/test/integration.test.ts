import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AssistantMessage, contentText, fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type CompactionEntry,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import backgroundCompaction from "../index.ts";
import { words } from "./helpers.ts";

interface Run {
	summaryRequests: { at: number; text: string; cacheRead: number }[];
	events: (AgentSessionEvent & { at: number })[];
	trace: () => Promise<Record<string, unknown>[]>;
	entries: () => ReturnType<SessionManager["getEntries"]>;
	prompt: (text: string) => Promise<void>;
	dispose: () => Promise<void>;
}

const isSummaryRequest = (context: TranscriptContext) => {
	const last = context.messages.at(-1);
	const text = last?.role === "user" ? contentText(last.content) : "";
	return text.includes("<conversation>") || text.includes("Context checkpoint.");
};

/**
 * A real AgentSession on the faux provider: a 30k window that Pi compacts at 24k. Replies are ~1.5k
 * tokens; summary requests answer after `summaryDelayMs`.
 */
async function start(settings: Record<string, unknown>, summaryDelayMs = 0, extension = true): Promise<Run> {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-compaction-"));
	const tracePath = join(dir, "trace.jsonl");
	process.env.PI_BACKGROUND_COMPACTION_TRACE = tracePath;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 30_000, maxTokens: 4000 }] });
	const summaryRequests: Run["summaryRequests"] = [];
	let reply = 0;
	const respond = async (context: TranscriptContext): Promise<AssistantMessage> => {
		if (isSummaryRequest(context)) {
			const last = context.messages.at(-1)!;
			const index = summaryRequests.push({ at: Date.now(), text: last.role === "user" ? contentText(last.content) : "", cacheRead: 0 }) - 1;
			if (summaryDelayMs) await new Promise((resolve) => setTimeout(resolve, summaryDelayMs));
			return fauxAssistantMessage(`## Objective\n- background summary ${index}`);
		}
		return fauxAssistantMessage(`reply ${reply++} ${words(1500)}`);
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond));
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "test");
	const settingsManager = SettingsManager.inMemory({ compaction: { reserveTokens: 6000, keepRecentTokens: 3000 }, ...settings } as never);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		extensionFactories: extension ? [backgroundCompaction] : [],
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
		noTools: "all",
	});
	await session.bindExtensions({});
	const events: Run["events"] = [];
	session.subscribe((event) => events.push({ ...event, at: Date.now() }));
	return {
		summaryRequests,
		events,
		trace: async () =>
			(await readFile(tracePath, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		entries: () => sessionManager.getEntries(),
		prompt: (text) => session.prompt(text),
		dispose: async () => {
			session.dispose();
			delete process.env.PI_BACKGROUND_COMPACTION_TRACE;
			await rm(dir, { recursive: true, force: true });
		},
	};
}

const compactions = (run: Run) => run.entries().filter((entry): entry is CompactionEntry => entry.type === "compaction");

test("Pi compacts with the summary written in the background", async () => {
	const run = await start({ backgroundCompaction: { minTokens: 0, prompt: "pi", trigger: 0.8 } });
	try {
		const turnsAt: number[] = [];
		for (let i = 0; i < 8 && compactions(run).length === 0; i++) {
			turnsAt.push(Date.now());
			await run.prompt(`step ${i} ${words(1500)}`);
		}
		const [compaction] = compactions(run);
		assert.ok(compaction, "a compaction happened");
		assert.equal(compaction.fromHook, true);
		const meta = (compaction.details as { backgroundCompaction: { requests: number; caughtUp: boolean } }).backgroundCompaction;
		assert.equal(meta.requests, 1);
		assert.equal(meta.caughtUp, false);
		// One summary request, sent with the configured prompt before Pi started compacting.
		assert.equal(run.summaryRequests.length, 1);
		assert.match(run.summaryRequests[0]!.text, /Create a structured context checkpoint summary/);
		const startedAt = run.events.find((event) => event.type === "compaction_start")!.at;
		assert.ok(run.summaryRequests[0]!.at < startedAt);
		const trace = await run.trace();
		assert.deepEqual(trace.map((event) => event.event), ["start", "ready", "swap"]);
		assert.equal(trace[2]!.source, "background");
		const end = run.events.find((event) => event.type === "compaction_end");
		assert.ok(end && end.type === "compaction_end" && end.result?.summary.includes("background summary 0"));
		// The kept entry is on the branch and the next request sees summary + kept tail.
		const ids = new Set(run.entries().map((entry) => entry.id));
		assert.ok(ids.has(compaction.firstKeptEntryId));
		await run.prompt("after compaction");
		const last = run.entries().at(-1)!;
		assert.equal(last.type, "message");
	} finally {
		await run.dispose();
	}
});

test("a slow background summary is awaited instead of starting another", async () => {
	const run = await start({ backgroundCompaction: { minTokens: 0, trigger: 0.95 } }, 300);
	try {
		for (let i = 0; i < 10 && compactions(run).length === 0; i++) await run.prompt(`step ${i} ${words(1500)}`);
		assert.equal(compactions(run).length, 1);
		assert.equal(run.summaryRequests.length, 1);
		const trace = await run.trace();
		assert.deepEqual(trace.map((event) => event.event), ["start", "wait", "ready", "swap"]);
		assert.ok((trace[3]!.waitedMs as number) > 0);
	} finally {
		await run.dispose();
	}
});

test("transcript requests read the conversation from the prompt cache", async () => {
	const run = await start({ backgroundCompaction: { minTokens: 0, request: "transcript" } });
	try {
		for (let i = 0; i < 8 && compactions(run).length === 0; i++) await run.prompt(`step ${i} ${words(1500)}`);
		const [compaction] = compactions(run);
		assert.ok(compaction);
		assert.ok(run.summaryRequests[0]!.text.startsWith("Context checkpoint."));
		const usage = compaction.usage!;
		assert.ok(usage.cacheRead > usage.input, `cache read ${usage.cacheRead}, uncached ${usage.input}`);
	} finally {
		await run.dispose();
	}
});

test("without the extension Pi writes the summary while the session waits", async () => {
	const run = await start({}, 0, false);
	try {
		for (let i = 0; i < 8 && compactions(run).length === 0; i++) await run.prompt(`step ${i} ${words(1500)}`);
		const [compaction] = compactions(run);
		assert.ok(compaction);
		assert.equal(compaction.fromHook, false);
	} finally {
		await run.dispose();
	}
});
