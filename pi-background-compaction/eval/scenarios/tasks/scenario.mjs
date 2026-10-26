// Second scenario: a tasks HTTP API. Same interface as the ledger scenario.
export { materialize } from "./fixture.mjs";

export const TURNS = [
	"We're working on the tasks API in this repo. Rules for this whole session: (1) never log request bodies, they contain personal data; (2) every error response uses the error envelope from docs/DESIGN.md; (3) timestamps are RFC 3339 UTC with a trailing Z and no milliseconds; (4) keep every function under 40 lines; (5) no new dependencies. Start by reading docs/DESIGN.md in full and tell me what it says about pagination and errors.",
	"CI is red. Read logs/ci-run-8812.log and tell me exactly which test fails, why, and the overall totals. Don't change code yet.",
	"Fix that failure at its root, keep the test, and run the tests.",
	"Read bench/profile.txt and tell me the top 3 hot functions with their self-time percentages.",
	"Design decision: cache serialized tasks in an LRU with at most 500 entries, keyed by id plus updated_at. We rejected caching by id alone because it served stale tasks after a PATCH. Implement it in src/store.js with tests.",
	"Make every error response in src/routes/tasks.js use the design's error envelope with proper codes, with tests.",
	"Correction from product today: the maximum page size is 50, not what the design says. The default stays as designed. Implement limit validation accordingly, with tests.",
	"Add a `status` filter to GET /tasks (`open` or `done`), rejecting other values properly. Add tests.",
	"Implement soft delete as the design describes: DELETE /tasks/:id, hidden from listings and GETs. Add tests.",
	"Review src/routes/tasks.js and src/store.js for problems. List them but don't change code yet.",
	"Fix the two most important problems from your review, with tests.",
	"Run the full test suite, fix anything failing, and summarize what changed in this session.",
];

const has = (...patterns) => (answer) => patterns.every((pattern) => pattern.test(answer));

export const PROBES = [
	{ id: "no-body-logs", kind: "rule", question: "What must never be logged, and why?", grade: has(/request bod/i, /personal|pii|privacy/i) },
	{ id: "timestamps", kind: "rule", question: "What exact timestamp format must the API use?", grade: has(/RFC ?3339/i, /millisecond|\.000|fraction/i) },
	{ id: "fn-length", kind: "rule", question: "What limit applies to function length?", grade: has(/40/) },
	{ id: "ci-test", kind: "tool", question: "Which CI test failed (number and name)?", grade: has(/\b37\b/, /created_at/) },
	{ id: "ci-cause", kind: "tool", question: "Why did that test fail? Give the expected and actual values.", grade: has(/10:00:00Z/, /10:00:00\.000Z/) },
	{ id: "ci-totals", kind: "tool", question: "What were the CI run's totals?", grade: has(/212/, /211/) },
	{ id: "ci-flaky", kind: "tool", question: "Was there any other warning in the CI log? Which test and how long did it take?", grade: has(/120/, /2\.4 ?s/) },
	{ id: "hot-functions", kind: "tool", question: "What were the top 3 hot functions in the profile, in order?", grade: has(/serializeTask[\s\S]*validateQuery[\s\S]*ulid/) },
	{ id: "hot-percent", kind: "tool", question: "What was serializeTask's self-time percentage?", grade: has(/41\.2/) },
	{ id: "lru", kind: "decision", question: "How is the serialized-task cache bounded and keyed?", grade: has(/500/, /updated_at/) },
	{ id: "lru-why", kind: "decision", question: "Which cache key did we reject, and why?", grade: has(/\bid[ -]?(alone|only)\b|only (the )?id\b|just (the )?id\b|by id\b/i, /stale/i) },
	{ id: "page-max", kind: "update", question: "What is the maximum page size now, and what did the design originally say?", grade: has(/\b50\b/, /\b100\b/) },
	{ id: "page-default", kind: "spec", question: "What is the default page size?", grade: has(/\b25\b/) },
	{ id: "pagination", kind: "spec", question: "Which pagination style does the design require, and what is the response field for the next page?", grade: has(/cursor/i, /next_cursor/) },
	{ id: "envelope", kind: "spec", question: "What is the exact shape of an error response?", grade: has(/error/, /code/, /message/) },
	{ id: "bad-limit", kind: "spec", question: "According to the design, what happens with an invalid limit?", grade: has(/400/, /clamp|not silently|error/i) },
	{ id: "ids", kind: "spec-deep", question: "According to the design, what kind of IDs do tasks have and who generates them?", grade: has(/ULID/i, /server/i) },
	{ id: "rate-limit", kind: "spec-deep", question: "According to the design, what is the rate limit and what does an excess request receive?", grade: has(/120/, /429/) },
	{ id: "restore", kind: "spec-deep", question: "According to the design, can a deleted task be restored, and for how long?", grade: has(/30 days/i) },
];

export const PROBE_PROMPT = `Quick memory check before we continue. Answer from what you remember of this session only: do not use tools and do not read files. If you do not know, say "unknown". Reply with exactly one line per question, numbered like the questions.

${PROBES.map((probe, index) => `${index + 1}. ${probe.question}`).join("\n")}`;

export function gradeProbes(text) {
	const answers = new Map();
	let current;
	for (const line of text.split("\n")) {
		const match = /^\s*(?:\*\*)?(\d+)[.):]\s*(?:\*\*)?\s*(.*)$/.exec(line);
		if (match) {
			current = Number(match[1]);
			answers.set(current, match[2]);
		} else if (current !== undefined && line.trim()) answers.set(current, `${answers.get(current)} ${line.trim()}`);
	}
	return PROBES.map((probe, index) => {
		// Bold markers and code spans are formatting, not content.
		const answer = (answers.get(index + 1) ?? "").replace(/[`*]/g, "");
		return !/^\W*unknown\W*$/i.test(answer) && probe.grade(answer);
	});
}

export const TASK_PROMPT = `Without using tools, write the complete code of a function \`listPage(tasks, query)\` for src/routes/tasks.js that implements GET /tasks pagination: \`tasks\` is every stored task, \`query\` is the URLSearchParams. Return a { status, body } response like the other handlers. Follow every rule, decision, and correction from this session. Reply with code blocks only.`;

const code = (text) => [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]).join("\n") || text;

export const TASK_CHECKS = [
	{ id: "max-50", check: (source) => /\b50\b/.test(source) && !/\b100\b/.test(source) },
	{ id: "default-25", check: (source) => /\b25\b/.test(source) },
	{ id: "cursor", check: (source) => /cursor/.test(source) && /next_cursor/.test(source) && !/offset/.test(source) },
	{ id: "envelope", check: (source) => /invalid_limit|invalid_cursor|invalid_query/.test(source) && (/error\s*:\s*\{[\s\S]{0,80}code/.test(source) || /\w*[eE]rror\w*\(\s*\d{3}\s*,\s*["'`]invalid_/.test(source)) },
	{ id: "status-400", check: (source) => /\b400\b/.test(source) && !/Math\.min\([^)]*limit|Math\.max\([^)]*limit/.test(source) },
	{ id: "hides-deleted", check: (source) => /deleted_at/.test(source) },
];

export function gradeTask(text) {
	const source = code(text);
	return TASK_CHECKS.map((check) => check.check(source));
}
