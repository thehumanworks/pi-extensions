// Record real coding sessions on a scenario fixture with compaction off, so they grow past any
// threshold the replay picks. Usage: tsx eval/record.mts --scenario=ledger --name=ledger-1 [--model=openai/gpt-6.1-sol]
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { models, session } from "./lib.mts";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const scenario = arg("scenario", "ledger");
const name = arg("name", `${scenario}-${Date.now()}`);
const model = arg("model", "openai/gpt-6.1-sol");
const { materialize, TURNS } = await import(`./scenarios/${scenario}/scenario.mjs`);

const cwd = mkdtempSync(join(tmpdir(), `ledger-${name}-`));
materialize(cwd);
const sessionDir = join(cwd, ".sessions");
const manager = SessionManager.create(cwd, sessionDir);
const { modelRuntime } = await models();
const { session: agent } = await session({ modelRuntime, cwd, model, settings: { compaction: { enabled: false } }, sessionManager: manager });

const turns: { turn: number; ms: number; tokens: number | null; requests: number }[] = [];
let requests = 0;
agent.subscribe((event) => {
	if (event.type === "message_end" && event.message.role === "assistant") requests++;
});
for (const [index, prompt] of (TURNS as string[]).entries()) {
	const started = Date.now();
	const before = requests;
	await agent.prompt(prompt);
	const usage = agent.getContextUsage();
	turns.push({ turn: index + 1, ms: Date.now() - started, tokens: usage?.tokens ?? null, requests: requests - before });
	console.log(`${name} turn ${index + 1}: ${usage?.tokens} tokens, ${requests - before} requests, ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
const out = join(here, "data", "sessions");
mkdirSync(out, { recursive: true });
copyFileSync(manager.getSessionFile()!, join(out, `${name}.jsonl`));
writeFileSync(join(out, `${name}.meta.json`), `${JSON.stringify({ name, scenario, model, cwd, turns }, null, 2)}\n`);
agent.dispose();
console.log(`saved ${join(out, `${name}.jsonl`)}`);
process.exit(0);
