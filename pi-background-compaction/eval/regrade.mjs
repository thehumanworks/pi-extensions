// Re-apply the current graders to stored replay answers. Usage: node eval/regrade.mjs DIR
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const modules = new Map();
for (const file of readdirSync(dir)) {
	if (!file.endsWith(".json") || file === "summary.json") continue;
	const path = join(dir, file);
	const result = JSON.parse(readFileSync(path, "utf8"));
	if (!result.probeText) continue;
	const scenario = result.scenario ?? result.session.replace(/-\d+$/, "");
	if (!modules.has(scenario)) modules.set(scenario, await import(`./scenarios/${scenario}/scenario.mjs`));
	const { gradeProbes, gradeTask, PROBES, TASK_CHECKS } = modules.get(scenario);
	const probes = gradeProbes(result.probeText);
	const task = gradeTask(result.taskText);
	Object.assign(result, {
		scenario,
		probeScore: probes.filter(Boolean).length / probes.length,
		taskScore: task.filter(Boolean).length / task.length,
		probes: Object.fromEntries(PROBES.map((probe, i) => [probe.id, probes[i]])),
		task: Object.fromEntries(TASK_CHECKS.map((check, i) => [check.id, task[i]])),
	});
	writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}
