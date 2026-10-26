// Aggregate replay results by config: mean and standard error of the scores, blocking, size, cost.
// Usage: node eval/report.mjs DIR [DIR...] [--by-scenario]
//        node eval/report.mjs eval/results/hill-climb.json --round=final [--by-scenario]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const byScenario = process.argv.includes("--by-scenario");
const round = process.argv.find((arg) => arg.startsWith("--round="))?.slice(8);
const groups = new Map();
const add = (result) => {
	if (typeof result.probeScore !== "number") return;
	const scenario = result.scenario ?? result.session.replace(/-\d+$/, "");
	const key = byScenario ? `${result.name} [${scenario}]` : result.name;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push({ ...result, usage: result.usage ?? { cost: { total: result.costUsd ?? 0 } } });
};
for (const path of process.argv.slice(2).filter((arg) => !arg.startsWith("--"))) {
	if (statSync(path).isFile()) {
		// An exported hill climb: { rounds: { name: { runs } } }.
		for (const [name, data] of Object.entries(JSON.parse(readFileSync(path, "utf8")).rounds)) {
			if (!round || round.split(",").includes(name)) for (const run of data.runs) add(run);
		}
		continue;
	}
	for (const file of readdirSync(path)) {
		if (!file.endsWith(".json") || file === "summary.json") continue;
		add(JSON.parse(readFileSync(join(path, file), "utf8")));
	}
}
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const stderr = (values) => {
	if (values.length < 2) return 0;
	const m = mean(values);
	return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1) / values.length);
};
const table = {};
for (const [key, results] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
	const score = results.map((r) => 0.7 * r.probeScore + 0.3 * r.taskScore);
	table[key] = {
		n: results.length,
		probes: `${mean(results.map((r) => r.probeScore)).toFixed(3)}±${stderr(results.map((r) => r.probeScore)).toFixed(3)}`,
		task: mean(results.map((r) => r.taskScore)).toFixed(3),
		score: `${mean(score).toFixed(3)}±${stderr(score).toFixed(3)}`,
		blockedS: mean(results.map((r) => r.blockedMs / 1000)).toFixed(1),
		ctxTokens: Math.round(mean(results.map((r) => r.contextTokens))),
		summaryTok: Math.round(mean(results.map((r) => r.summaryTokens))),
		requests: mean(results.map((r) => r.summaryRequests)).toFixed(2),
		costUsd: mean(results.map((r) => r.usage?.cost?.total ?? 0)).toFixed(4),
	};
}
console.table(table);
