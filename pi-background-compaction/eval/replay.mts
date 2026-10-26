// Replay recorded sessions through the production BackgroundCompactor, then score the compacted
// context. Background summaries run for real but on the session's recorded clock: one started at a
// turn boundary is ready its measured latency later, so waits and blocking match the original pace.
//
// Usage: tsx eval/replay.mts --configs=eval/configs/base.json [--sessions=s1,s2] [--repeats=2]
//        [--threshold=56000] [--keep=8000] [--answerer=openai/gpt-6.1-sol] [--concurrency=6] [--out=DIR]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, compact, convertToLlm, estimateTokens, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../src/config.ts";
import { BackgroundCompactor, type Snapshot, type SummaryJob } from "../src/controller.ts";
import { projectedMessages } from "../src/plan.ts";
import { writeSummary } from "../src/summarize.ts";
import { find, models, text } from "./lib.mts";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
// Pi's compaction threshold: by default just under each session's size after turn 10, so every
// session compacts at the same point of its script whatever its token growth.
const THRESHOLD_ARG = arg("threshold", "auto");
const KEEP = Number(arg("keep", "8000"));
const REPEATS = Number(arg("repeats", "2"));
const ANSWERER = arg("answerer", "openai/gpt-6.1-sol");
const SESSION_MODEL = arg("session-model", "openai/gpt-6.1-sol");
const CONCURRENCY = Number(arg("concurrency", "6"));
const sessions = arg("sessions", "ledger-1,ledger-2,ledger-3,tasks-1,tasks-2,tasks-3").split(",");
/** Scenario module for a recorded session, from its metadata. */
const scenarios = new Map<string, any>();
async function scenarioFor(name: string) {
	const meta = JSON.parse(readFileSync(join(here, "data", "sessions", `${name}.meta.json`), "utf8"));
	const scenario = meta.scenario ?? "ledger";
	if (!scenarios.has(scenario)) scenarios.set(scenario, await import(`./scenarios/${scenario}/scenario.mjs`));
	return scenarios.get(scenario);
}
const configsPath = resolve(arg("configs", join(here, "configs/base.json")));
const candidates: Record<string, Record<string, unknown>> = JSON.parse(readFileSync(configsPath, "utf8"));
const out = resolve(arg("out", join(here, "results", new Date().toISOString().replace(/[:.]/g, "-"))));
mkdirSync(out, { recursive: true });

// Pi's own preparation, for the built-in baseline. It is internal, so load it from the package.
const { prepareCompaction } = (await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href)) as {
	prepareCompaction: (entries: SessionEntry[], settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }) => Parameters<typeof compact>[0] | undefined;
};

const CONTEXT_WINDOW = 1_000_000;
const thresholds = new Map<string, number>();
function thresholdFor(name: string): number {
	if (THRESHOLD_ARG !== "auto") return Number(THRESHOLD_ARG);
	if (!thresholds.has(name)) {
		const meta = JSON.parse(readFileSync(join(here, "data", "sessions", `${name}.meta.json`), "utf8"));
		thresholds.set(name, meta.turns[9].tokens - 500);
	}
	return thresholds.get(name)!;
}
const settingsFor = (threshold: number) => ({ enabled: true, reserveTokens: CONTEXT_WINDOW - threshold, keepRecentTokens: KEEP });

function load(name: string): SessionEntry[] {
	return SessionManager.open(join(here, "data", "sessions", `${name}.jsonl`), join(out, ".scratch")).getEntries();
}

/** Context tokens as Pi estimates them: the last response's usage plus estimates for what followed. */
function tokensAt(branch: SessionEntry[]): number {
	const messages = projectedMessages(branch);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && calculateContextTokens(message.usage) > 0) {
			let tokens = calculateContextTokens(message.usage);
			for (const later of messages.slice(i + 1)) tokens += estimateTokens(later);
			return tokens;
		}
	}
	return 0;
}

/** Turn boundaries: after each assistant message and the tool results that follow it. */
function boundaries(entries: SessionEntry[]): number[] {
	const result: number[] = [];
	entries.forEach((entry, index) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return;
		let end = index;
		while (entries[end + 1]?.type === "message" && (entries[end + 1] as { message: { role: string } }).message.role === "toolResult") end++;
		result.push(end);
	});
	return result;
}

const time = (entry: SessionEntry) => Date.parse(entry.timestamp);

interface Outcome {
	summary: string;
	firstKeptEntryId: string;
	usage?: Usage;
	details?: unknown;
	blockedMs: number;
	swapIndex: number;
	trace: Record<string, unknown>[];
	summaryRequests: number;
}

/** Drive the controller over a recorded session until Pi's threshold, then return the swap. */
async function runController(entries: SessionEntry[], candidate: Record<string, unknown>, THRESHOLD: number): Promise<Outcome | undefined> {
	const SETTINGS = settingsFor(THRESHOLD);
	const { modelRuntime } = await models();
	const config = readConfig({ backgroundCompaction: { minTokens: 0, ...candidate } }, here, {});
	const summarizer = find(modelRuntime, config.model ?? SESSION_MODEL);
	let clock = 0;
	let taking = false;
	let summaryRequests = 0;
	const gates: { at: number; open: () => void }[] = [];
	const inflight = new Set<Promise<unknown>>();
	const trace: Record<string, unknown>[] = [];
	const summarize = async (job: SummaryJob) => {
		const startedAt = clock;
		const started = Date.now();
		summaryRequests++;
		const request = writeSummary(job, config, {
			model: summarizer,
			complete: (m, c, o) => modelRuntime.completeSimple(m, c, o),
			sessionThinking: "low",
			sessionId: "replay",
		});
		const blocking = taking;
		if (!blocking) inflight.add(request.catch(() => undefined));
		let output;
		try {
			output = await request;
		} finally {
			const readyAt = startedAt + (Date.now() - started);
			if (blocking) {
				// Compaction is waiting on this request, so session time runs until it is done.
				clock = Math.max(clock, readyAt);
			} else {
				// Background: the controller sees the result once session time reaches readyAt.
				await new Promise<void>((open) => gates.push({ at: readyAt, open }));
			}
		}
		return output;
	};
	const compactor = new BackgroundCompactor({ config: () => config, summarize, trace: (event) => trace.push(event), now: () => clock });
	const settle = async (until: number) => {
		for (const gate of gates.splice(0).sort((a, b) => a.at - b.at)) {
			if (gate.at <= until) {
				clock = Math.max(clock, gate.at);
				gate.open();
				await new Promise((r) => setImmediate(r));
			} else gates.push(gate);
		}
	};
	const ends = boundaries(entries);
	const origin = time(entries[ends[0]!]!);
	for (const end of ends) {
		const branch = entries.slice(0, end + 1);
		// Learn when in-flight background requests finish, then land those done by this boundary.
		await Promise.all([...inflight]);
		inflight.clear();
		await new Promise((r) => setImmediate(r));
		await settle(time(entries[end]!) - origin);
		clock = Math.max(clock, time(entries[end]!) - origin);
		const snapshot: Snapshot = { branch, tokens: tokensAt(branch), contextWindow: CONTEXT_WINDOW, settings: SETTINGS, transcript: !config.model || config.model === SESSION_MODEL };
		compactor.observe(snapshot, "turn");
		if ((snapshot.tokens ?? 0) <= THRESHOLD) continue;
		taking = true;
		const dueAt = clock;
		// Everything still writing finishes while compaction waits for it.
		const releaser = setInterval(() => {
			for (const gate of gates.splice(0)) {
				clock = Math.max(clock, gate.at);
				gate.open();
			}
		}, 5);
		const result = await compactor.take(snapshot, new AbortController().signal, { tokensBefore: snapshot.tokens ?? 0, reason: "threshold" });
		clearInterval(releaser);
		if (!result) return undefined;
		return { summary: result.summary, firstKeptEntryId: result.firstKeptEntryId, usage: result.usage, details: result.details, blockedMs: clock - dueAt, swapIndex: end, trace, summaryRequests };
	}
	return undefined;
}

/** Pi's built-in compaction at the first boundary over the threshold, timed as the blocking call it is. */
async function runPi(entries: SessionEntry[], THRESHOLD: number): Promise<Outcome | undefined> {
	const SETTINGS = settingsFor(THRESHOLD);
	const { modelRuntime } = await models();
	for (const end of boundaries(entries)) {
		const branch = entries.slice(0, end + 1);
		if (tokensAt(branch) <= THRESHOLD) continue;
		const preparation = prepareCompaction(branch, SETTINGS)!;
		const model = find(modelRuntime, SESSION_MODEL);
		const started = Date.now();
		const result = await compact(preparation, model, undefined, undefined, undefined, undefined, "low", (m, c, o) => modelRuntime.streamSimple(m, c, o));
		return { ...result, blockedMs: Date.now() - started, swapIndex: end, trace: [], summaryRequests: 1 };
	}
	return undefined;
}

/** The context Pi would send after appending `outcome` as a compaction, or the raw branch for `full`. */
function compactedContext(entries: SessionEntry[], outcome: Outcome | "full" | "drop", SETTINGS: ReturnType<typeof settingsFor>): { context: Context; tokens: number } {
	if (outcome === "full") {
		const branch = entries.slice(0, entries.length);
		return { context: { messages: convertToLlm(projectedMessages(branch)) }, tokens: tokensAt(branch) };
	}
	const manager = SessionManager.inMemory("/tmp/replay", undefined, [{ type: "session", version: 3, id: "replay", timestamp: new Date().toISOString(), cwd: "/tmp/replay" }, ...entries] as never);
	const summary = outcome === "drop" ? "(The earlier conversation was removed without a summary.)" : outcome.summary;
	const firstKept = outcome === "drop" ? (prepareCompaction(entries, SETTINGS)?.firstKeptEntryId ?? entries[0]!.id) : outcome.firstKeptEntryId;
	manager.appendCompaction(summary, firstKept, 0, undefined, true);
	const messages = manager.buildSessionProjection().messages;
	return { context: { messages: convertToLlm(messages) }, tokens: messages.reduce((sum, m) => sum + estimateTokens(m), 0) };
}

async function ask(context: Context, prompt: string): Promise<string> {
	const { modelRuntime } = await models();
	const messages = [...context.messages, { role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }];
	for (let attempt = 0; attempt < 3; attempt++) {
		const reply = await modelRuntime.completeSimple(find(modelRuntime, ANSWERER), { messages }, { reasoning: "low", toolChoice: "none", maxTokens: 8000 });
		if (reply.stopReason !== "error") return text(reply);
		await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
	}
	return "";
}

async function evaluate(name: string, sessionName: string, repeat: number) {
	const all = load(sessionName);
	const THRESHOLD = thresholdFor(sessionName);
	const started = Date.now();
	let outcome: Outcome | undefined;
	let mode: Outcome | "full" | "drop";
	if (name === "full" || name === "drop") {
		const end = boundaries(all).find((index) => tokensAt(all.slice(0, index + 1)) > THRESHOLD);
		if (end === undefined) return undefined;
		const entries = all.slice(0, end + 1);
		mode = name;
		return score(name, sessionName, repeat, entries, mode, started, THRESHOLD);
	}
	outcome = name === "pi" ? await runPi(all, THRESHOLD) : await runController(all, candidates[name]!, THRESHOLD);
	if (!outcome) return { name, session: sessionName, repeat, error: "no compaction" };
	return score(name, sessionName, repeat, all.slice(0, outcome.swapIndex + 1), outcome, started, THRESHOLD);
}

async function score(name: string, sessionName: string, repeat: number, entries: SessionEntry[], outcome: Outcome | "full" | "drop", started: number, threshold: number) {
	const { gradeProbes, gradeTask, PROBE_PROMPT, PROBES, TASK_CHECKS, TASK_PROMPT } = await scenarioFor(sessionName);
	const { context, tokens } = compactedContext(entries, outcome, settingsFor(threshold));
	const [probeText, taskText] = await Promise.all([ask(context, PROBE_PROMPT), ask(context, TASK_PROMPT)]);
	const probes = gradeProbes(probeText);
	const task = gradeTask(taskText);
	const swap = typeof outcome === "object" ? outcome : undefined;
	const result = {
		name,
		session: sessionName,
		repeat,
		probeScore: probes.filter(Boolean).length / probes.length,
		taskScore: task.filter(Boolean).length / task.length,
		scenario: sessionName.replace(/-\d+$/, ""),
		threshold,
		probes: Object.fromEntries(PROBES.map((probe: { id: string }, i: number) => [probe.id, probes[i]])),
		task: Object.fromEntries(TASK_CHECKS.map((check: { id: string }, i: number) => [check.id, task[i]])),
		blockedMs: swap?.blockedMs ?? 0,
		contextTokens: tokens,
		summaryTokens: swap ? Math.ceil(swap.summary.length / 4) : 0,
		summaryRequests: swap?.summaryRequests ?? 0,
		usage: swap?.usage,
		trace: swap?.trace,
		summary: swap?.summary,
		probeText,
		taskText,
		ms: Date.now() - started,
	};
	writeFileSync(join(out, `${name}--${sessionName}--${repeat}.json`), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}

const jobs: [string, string, number][] = [];
for (const name of Object.keys(candidates)) for (const s of sessions) for (let r = 0; r < REPEATS; r++) jobs.push([name, s, r]);
const results: Awaited<ReturnType<typeof evaluate>>[] = [];
let next = 0;
await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		while (next < jobs.length) {
			const [name, s, r] = jobs[next++]!;
			try {
				const result = await evaluate(name, s, r);
				results.push(result);
				if (result && "probeScore" in result) console.log(`${name} ${s}#${r}: probes ${(result.probeScore * 100).toFixed(0)}% task ${(result.taskScore * 100).toFixed(0)}% blocked ${(result.blockedMs / 1000).toFixed(1)}s ctx ${result.contextTokens}`);
				else console.log(`${name} ${s}#${r}: ${JSON.stringify(result)}`);
			} catch (error) {
				console.log(`${name} ${s}#${r}: failed ${error instanceof Error ? error.stack : error}`);
			}
		}
	}),
);

const table: Record<string, Record<string, number>> = {};
for (const result of results) {
	if (!result || !("probeScore" in result)) continue;
	const row = (table[result.name] ??= { n: 0, probes: 0, task: 0, blockedMs: 0, contextTokens: 0, summaryTokens: 0, requests: 0, cost: 0 });
	row.n!++;
	row.probes! += result.probeScore;
	row.task! += result.taskScore;
	row.blockedMs! += result.blockedMs;
	row.contextTokens! += result.contextTokens;
	row.summaryTokens! += result.summaryTokens;
	row.requests! += result.summaryRequests;
	row.cost! += result.usage?.cost.total ?? 0;
}
const summary = Object.fromEntries(
	Object.entries(table).map(([name, row]) => [
		name,
		{
			n: row.n,
			probes: +(row.probes! / row.n!).toFixed(3),
			task: +(row.task! / row.n!).toFixed(3),
			score: +((0.7 * row.probes! + 0.3 * row.task!) / row.n!).toFixed(3),
			blockedS: +(row.blockedMs! / row.n! / 1000).toFixed(2),
			contextTokens: Math.round(row.contextTokens! / row.n!),
			summaryTokens: Math.round(row.summaryTokens! / row.n!),
			requests: +(row.requests! / row.n!).toFixed(2),
			costUsd: +(row.cost! / row.n!).toFixed(4),
		},
	]),
);
writeFileSync(join(out, "summary.json"), `${JSON.stringify({ threshold: THRESHOLD_ARG, keep: KEEP, answerer: ANSWERER, sessions, repeats: REPEATS, candidates, summary }, null, 2)}\n`);
console.table(summary);
process.exit(0);
