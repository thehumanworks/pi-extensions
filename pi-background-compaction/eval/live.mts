// End-to-end check in Pi's runtime: run a scenario's scripted turns with real compaction, with and
// without the extension, then score the session where it ended. Measures the time the agent spent
// waiting on compaction (compaction_start to compaction_end).
//
// Usage: tsx eval/live.mts --scenario=ledger --arm=extension|pi [--threshold=40000] [--keep=8000]
//        [--config='{"prompt":"coding"}'] [--model=openai/gpt-6.1-sol] [--name=...]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import backgroundCompaction from "../index.ts";
import { find, models, session, text } from "./lib.mts";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const scenarioName = arg("scenario", "ledger");
const arm = arg("arm", "extension");
const threshold = Number(arg("threshold", "40000"));
const keep = Number(arg("keep", "8000"));
const model = arg("model", "openai/gpt-6.1-sol");
const config = JSON.parse(arg("config", "{}"));
const name = arg("name", `${scenarioName}-${arm}-${Date.now()}`);
const out = join(here, "results", "live");
mkdirSync(out, { recursive: true });

const scenario = await import(`./scenarios/${scenarioName}/scenario.mjs`);
const cwd = mkdtempSync(join(tmpdir(), `live-${name}-`));
scenario.materialize(cwd);
const { modelRuntime } = await models();
const contextWindow = find(modelRuntime, model).contextWindow;
const trace = join(cwd, "trace.jsonl");
process.env.PI_BACKGROUND_COMPACTION_TRACE = trace;
const manager = SessionManager.create(cwd, join(cwd, ".sessions"));
const { session: agent } = await session({
	modelRuntime,
	cwd,
	model,
	sessionManager: manager,
	extensions: arm === "extension" ? [backgroundCompaction] : [],
	settings: {
		compaction: { keepRecentTokens: keep, modelOverrides: { [model]: { reserveTokens: contextWindow - threshold } } },
		backgroundCompaction: { enabled: true, model, minTokens: 0, ...config },
	},
});

const compactions: { reason: string; ms: number; turn: number; summaryTokens?: number }[] = [];
let compactionStart = 0;
let turn = 0;
agent.subscribe((event) => {
	if (event.type === "compaction_start") compactionStart = Date.now();
	if (event.type === "compaction_end") compactions.push({ reason: event.reason, ms: Date.now() - compactionStart, turn, summaryTokens: event.result ? Math.ceil(event.result.summary.length / 4) : undefined });
});
const started = Date.now();
for (const prompt of scenario.TURNS as string[]) {
	turn++;
	await agent.prompt(prompt);
	console.log(`${name} turn ${turn}: ${agent.getContextUsage()?.tokens} tokens, compactions ${compactions.length}`);
}
const wallMs = Date.now() - started;

// Score the compacted session the way the replay does: probes and task against its current context.
const messages = convertToLlm(manager.buildSessionProjection().messages);
const ask = async (prompt: string) =>
	text(await modelRuntime.completeSimple(find(modelRuntime, model), { messages: [...messages, { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { reasoning: "low", toolChoice: "none", maxTokens: 8000 }));
const [probeText, taskText] = await Promise.all([ask(scenario.PROBE_PROMPT), ask(scenario.TASK_PROMPT)]);
const probes = scenario.gradeProbes(probeText) as boolean[];
const task = scenario.gradeTask(taskText) as boolean[];
const result = {
	name,
	scenario: scenarioName,
	arm,
	threshold,
	keep,
	config,
	wallMs,
	compactions,
	blockedMs: compactions.reduce((sum, c) => sum + c.ms, 0),
	probeScore: probes.filter(Boolean).length / probes.length,
	taskScore: task.filter(Boolean).length / task.length,
	probes: Object.fromEntries((scenario.PROBES as { id: string }[]).map((probe, i) => [probe.id, probes[i]])),
	task: Object.fromEntries((scenario.TASK_CHECKS as { id: string }[]).map((check, i) => [check.id, task[i]])),
	probeText,
	taskText,
	cwd,
};
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(`${name}: ${compactions.length} compactions, blocked ${(result.blockedMs / 1000).toFixed(1)}s of ${(wallMs / 1000).toFixed(0)}s, probes ${(result.probeScore * 100).toFixed(0)}%, task ${(result.taskScore * 100).toFixed(0)}%`);
agent.dispose();
process.exit(0);
