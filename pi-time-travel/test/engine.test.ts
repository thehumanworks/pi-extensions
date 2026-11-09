import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, DEFAULTS } from "../src/config.ts";
import { Engine, FiredState } from "../src/engine.ts";
import { type BoolQuestion, buildJudgeRequest, type Classify, httpClassifier } from "../src/judge.ts";
import type { Output } from "../src/matcher.ts";
import { parseRule, type Rule } from "../src/rules.ts";

const parse = (name: string, frontmatter: string, body = `Follow ${name}.`): Rule => parseRule(name, `/${name}.md`, `---\n${frontmatter}\n---\n${body}`).rule!;
const config = (overrides: Partial<Config> = {}, judge: Partial<Config["judge"]> = {}): Config => ({ ...DEFAULTS, ...overrides, judge: { ...DEFAULTS.judge, ...judge } });
const bash = (command: string): Output => ({ source: "tool", text: command, view: { tool: "bash", rawTool: "bash", text: command, paths: [] }, id: "c1" });

/** A judge that answers yes with the given probability per rule name, and records requests. */
function fakeJudge(byRule: Record<string, number>, error?: string) {
	const calls: Array<{ state: unknown; questions: Record<string, BoolQuestion> }> = [];
	const classify: Classify = async (state, questions) => {
		calls.push({ state, questions });
		if (error) return { probabilities: {}, error };
		const probabilities: Record<string, number> = {};
		for (const [id, question] of Object.entries(questions)) {
			const rule = Object.keys(byRule).find((name) => question.instructions.includes(name) || question.instructions.includes(`Q:${name}`));
			probabilities[id] = rule ? byRule[rule]! : 0;
		}
		return { probabilities };
	};
	return { classify, calls };
}

test("a regex match interrupts; interruptMode decides per source", async () => {
	const rules = [parse("pnpm", "condition: npm install"), parse("prose", "condition: npm install\nscope: tool\ninterruptMode: prose-only")];
	const engine = new Engine({ config: config(), rules });
	const { findings } = await engine.evaluate([bash("npm install x")], new FiredState());
	assert.deepEqual(
		findings.map((f) => [f.rule.name, f.action, f.how]),
		[
			["pnpm", "interrupt", "regex"],
			["prose", "remind", "regex"],
		],
	);
});

test("judge.confirm lets the judge clear a regex false positive, and keeps the match if the judge fails", async () => {
	const rules = [parse("pnpm", "condition: npm")];
	const cleared = new Engine({ config: config({}, { confirm: true }), rules, classify: fakeJudge({ pnpm: 0.1 }).classify });
	const a = await cleared.evaluate([bash("rg -n npm README.md")], new FiredState());
	assert.equal(a.findings.length, 0);
	assert.equal(a.cleared[0]?.rule, "pnpm");

	const confirmed = new Engine({ config: config({}, { confirm: true }), rules, classify: fakeJudge({ pnpm: 0.97 }).classify });
	assert.equal((await confirmed.evaluate([bash("npm i x")], new FiredState())).findings[0]?.probability, 0.97);

	const failing = new Engine({ config: config({}, { confirm: true }), rules, classify: fakeJudge({}, "timeout").classify });
	const c = await failing.evaluate([bash("npm i x")], new FiredState());
	assert.equal(c.findings[0]?.how, "regex");
	assert.deepEqual(c.judgeErrors, ["timeout"]);
});

test("question rules: conditions pre-filter, verdicts warn unless judge.blocking, facts reach the judge", async () => {
	const claims = parse("claims", "condition: tests pass\nscope: text\nquestion: Q:claims Does it claim tests pass without running them?");
	const judge = fakeJudge({ claims: 0.95 });
	const engine = new Engine({ config: config(), rules: [claims], classify: judge.classify });
	const facts = () => ({ commandsRunThisSession: [] });
	assert.equal((await engine.evaluate([{ source: "text", text: "Refactored." }], new FiredState(), facts)).findings.length, 0);
	assert.equal(judge.calls.length, 0, "the pre-filter kept this from the judge");
	const warned = await engine.evaluate([{ source: "text", text: "All tests pass." }], new FiredState(), facts);
	assert.deepEqual(warned.findings.map((f) => [f.how, f.action]), [["judge", "remind"]]);
	assert.deepEqual((judge.calls[0]!.state as { facts: unknown }).facts, { commandsRunThisSession: [] });

	const blocking = new Engine({ config: config({}, { blocking: true }), rules: [claims], classify: judge.classify });
	assert.equal((await blocking.evaluate([{ source: "text", text: "All tests pass." }], new FiredState())).findings[0]?.action, "interrupt");
	assert.equal((await new Engine({ config: config(), rules: [claims] }).evaluate([{ source: "text", text: "All tests pass." }], new FiredState())).findings.length, 0, "no judge, no verdict");
});

test("one judge request per output carries every candidate rule", () => {
	const rules = [parse("a", "question: A?"), parse("b", "condition: x")];
	const { questions, state } = buildJudgeRequest(bash("x"), [{ rule: rules[0]!, kind: "question" }, { rule: rules[1]!, kind: "confirm", excerpt: "x" }]);
	assert.deepEqual(Object.keys(questions), ["q0", "q1"]);
	assert.match(questions.q1!.instructions, /project rule "b"[^]*Follow b\.[^]*matched: x/);
	assert.deepEqual((state as { output: { what: string } }).output.what, "a shell command the agent is about to run");
});

test("repeat policies: always, once, after-gap", () => {
	const state = new FiredState();
	state.mark(["r"]);
	assert.equal(state.eligible("r", { repeatMode: "always", repeatGap: 2 }), true);
	assert.equal(state.eligible("r", { repeatMode: "once", repeatGap: 2 }), false);
	assert.equal(state.eligible("r", { repeatMode: "after-gap", repeatGap: 2 }), false);
	state.turn += 2;
	assert.equal(state.eligible("r", { repeatMode: "after-gap", repeatGap: 2 }), true);
	assert.equal(state.eligible("other", { repeatMode: "once", repeatGap: 2 }), true);
	assert.deepEqual(FiredState.from(state.toJSON()).toJSON(), state.toJSON());
});

test("the HTTP judge speaks System One and OpenAI Decisions", async () => {
	const requests: Array<{ url: string; body: any; auth: string | null }> = [];
	const fetchFake = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		requests.push({ url, body, auth: new Headers(init.headers).get("authorization") });
		const answers = url.endsWith("/systemone") ? { q0: { type: "noul", noul: 0.9 } } : [{ type: "predicate", name: "q0", probability: 0.2 }];
		return new Response(JSON.stringify({ answers, usage: { input_tokens: 42 } }));
	}) as typeof fetch;
	const question = { q0: { type: "bool" as const, instructions: "Q?", criteria: { true: "yes", false: "no" } } };

	const s1 = await httpClassifier({ api: "system-one", baseUrl: "https://gw/typesafe/v1/", apiKey: "k", model: "m" }, 1000, fetchFake)({ a: 1 }, question);
	assert.deepEqual(s1, { probabilities: { q0: 0.9 }, inputTokens: 42 });
	assert.equal(requests[0]!.url, "https://gw/typesafe/v1/systemone");
	assert.deepEqual(requests[0]!.body.questions.q0.type, "noul");
	assert.equal(requests[0]!.auth, "Bearer k");

	const oa = await httpClassifier({ api: "openai-decisions", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-6-luna" }, 1000, fetchFake)({ a: 1 }, question);
	assert.deepEqual(oa.probabilities, { q0: 0.2 });
	assert.equal(requests[1]!.body.input, '{"a":1}');
	assert.match(requests[1]!.body.questions[0].instructions, /True means: yes/);

	const failing = httpClassifier({ api: "system-one", baseUrl: "https://gw", apiKey: "k", model: "m" }, 1000, (async () => new Response("nope", { status: 401 })) as typeof fetch);
	assert.match((await failing({}, question)).error!, /HTTP 401/);
});
