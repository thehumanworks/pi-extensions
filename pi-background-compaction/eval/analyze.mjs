// Per-probe and per-check success rates for a replay output directory.
// Usage: node eval/analyze.mjs DIR [DIR...]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rows = new Map();
for (const dir of process.argv.slice(2)) {
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json") || file === "summary.json") continue;
		const result = JSON.parse(readFileSync(join(dir, file), "utf8"));
		if (!result.probes) continue;
		const key = `${result.name} [${result.scenario ?? "ledger"}]`;
		const row = rows.get(key) ?? { n: 0, probes: {}, task: {} };
		row.n++;
		for (const [id, ok] of Object.entries(result.probes)) row.probes[id] = (row.probes[id] ?? 0) + (ok ? 1 : 0);
		for (const [id, ok] of Object.entries(result.task)) row.task[id] = (row.task[id] ?? 0) + (ok ? 1 : 0);
		rows.set(key, row);
	}
}
const names = [...rows.keys()].sort();
const ids = (kind) => [...new Set(names.flatMap((name) => Object.keys(rows.get(name)[kind])))];
for (const kind of ["probes", "task"]) {
	const table = {};
	for (const id of ids(kind)) table[id] = Object.fromEntries(names.map((name) => [name, `${rows.get(name)[kind][id] ?? "-"}/${rows.get(name).n}`]));
	console.log(kind);
	console.table(table);
}
