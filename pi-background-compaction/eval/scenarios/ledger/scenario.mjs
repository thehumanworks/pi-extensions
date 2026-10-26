// Scripted user turns for recorded sessions, and the probes and task that score a compacted context.
import { topCategories } from "./fixture.mjs";

export const TURNS = [
	"We're working on the ledger CLI in this repo. Ground rules for the whole session: (1) money is always integer cents in code, never floats; (2) every user-facing error message starts with `ledger: `; (3) never modify anything under legacy/; (4) the data directory comes from the environment variable LEDGER_HOME, defaulting to ~/.ledger; (5) no new dependencies, and in particular no lodash. To start, read docs/SPEC.md in full and tell me what it requires of the import command.",
	"Implement parseAmount(text) in src/ledger.js following the spec's amount rules, and add tests for it in test/ledger.test.js. Run the tests.",
	"The nightly import crashed. Read logs/import-2026-10-20.log and find out exactly why. Don't change any code yet.",
	"Fix that crash, add a regression test for it, and run the tests.",
	"Design decision: categories will live in a Map keyed by a lowercase slug, not a plain object, because a plain object broke when a category was literally named `__proto__`. Implement categorize(transaction, rules) in src/ledger.js accordingly (first matching rule wins, otherwise `uncategorized`), with tests.",
	"Read data/transactions.json and tell me the top 3 categories by total spend, with their totals in cents. Treat spend as the negated sum of amount_cents.",
	"Change of plan for CSV: export will use `,` as the delimiter. Import must keep accepting `;` and also accept `,`. Update the CSV parsing accordingly, with tests.",
	"Add a `--since YYYY-MM-DD` option to the report command in src/cli.js that filters transactions by date. Reject invalid dates with a proper error. Add tests.",
	"Read src/csv.js and src/cli.js again and review them for edge cases. List the issues you find but don't change code yet.",
	"Fix the two most important issues from your review, with tests.",
	"Add a `ledger balance` command that prints the balance of each account, sorted by account name, with amounts formatted from cents. Add tests.",
	"Run the full test suite and fix anything that fails. Then summarize what changed in this session.",
];

const has = (...patterns) => (answer) => patterns.every((pattern) => pattern.test(answer));
const top = topCategories(3);
const amount = (cents) => new RegExp(String(cents).replace(/\B(?=(\d{3})+(?!\d))/g, "[,._ ]?"));

export const PROBES = [
	{ id: "env-var", kind: "rule", question: "Which environment variable sets the data directory, and what is its default?", grade: has(/LEDGER_HOME/, /~\/\.ledger/) },
	{ id: "error-prefix", kind: "rule", question: "What exact prefix must user-facing error messages start with?", grade: has(/ledger:/) },
	{ id: "frozen-dir", kind: "rule", question: "Which directory must never be modified?", grade: has(/legacy/i) },
	{ id: "banned-lib", kind: "rule", question: "Which library did I explicitly rule out?", grade: has(/lodash/i) },
	{ id: "money", kind: "rule", question: "How must money amounts be represented in code?", grade: has(/cent/i, /integer|\bint\b/i) },
	{ id: "map-why", kind: "decision", question: "Why do categories use a Map instead of a plain object?", grade: has(/__proto__|prototype/i) },
	{ id: "crash-cause", kind: "tool", question: "What caused the nightly import crash? Name the error and the function.", grade: has(/currency/i, /normalizeRow/) },
	{ id: "crash-row", kind: "tool", question: "Which row number and which file triggered the crash?", grade: has(/637/, /bank-export-oct/) },
	{ id: "crash-count", kind: "tool", question: "How many rows had the import processed when it aborted, and was anything committed?", grade: has(/636/, /nothing|not committed|no(ne|thing)? (was|were )?committed|no rows|wasn't|was not/i) },
	{ id: "top-categories", kind: "tool", question: "What were the top 3 categories by total spend, in order?", grade: has(new RegExp(`${top[0][0]}[\\s\\S]*${top[1][0]}[\\s\\S]*${top[2][0]}`, "i")) },
	{ id: "top-totals", kind: "tool", question: "What were the totals in cents of those top 3 categories?", grade: has(...top.map(([, cents]) => amount(cents))) },
	{ id: "delimiters", kind: "update", question: "What delimiter does CSV export use, and which delimiters must import accept?", grade: has(/comma|`,`|","|','/i, /semicolon|`;`|";"|';'/i) },
	{ id: "spec-memo", kind: "spec", question: "According to the spec, what happens to imported rows whose memo is blank?", grade: has(/payee/i) },
	{ id: "spec-future", kind: "spec", question: "According to the spec, what happens to future-dated rows on import?", grade: has(/skip/i, /warn/i) },
	{ id: "spec-duplicates", kind: "spec", question: "According to the spec, how are duplicate import rows identified?", grade: has(/date/i, /amount/i, /payee/i) },
	{ id: "spec-exit", kind: "spec", question: "According to the spec, which exit codes mean a user error and a data error?", grade: has(/\b1\b[\s\S]*\b2\b|user[^.]*1[\s\S]*data[^.]*2/i) },
	{ id: "spec-rounding", kind: "spec-deep", question: "According to the spec, how are report totals rounded for display?", grade: has(/half[- ]?even|banker/i) },
	{ id: "spec-order", kind: "spec-deep", question: "According to the spec, in what order does a report list categories?", grade: has(/descend|highest|largest|most/i, /alphabet/i) },
	{ id: "first-function", kind: "work", question: "Which function did you implement first for parsing amounts, and in which file?", grade: has(/parseAmount/, /ledger\.js/) },
];

export const PROBE_PROMPT = `Quick memory check before we continue. Answer from what you remember of this session only: do not use tools and do not read files. If you do not know, say "unknown". Reply with exactly one line per question, numbered like the questions.

${PROBES.map((probe, index) => `${index + 1}. ${probe.question}`).join("\n")}`;

/** Grade a numbered reply; returns one boolean per probe. */
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

export const TASK_PROMPT = `Without using tools, write the complete code of a function \`importRows(rows, today)\` for src/csv.js. It receives already-parsed rows ({ date, payee, amount, memo }, amount in the representation this session agreed on) and must apply every import rule from the spec, returning the rows to import plus the counts the spec says the importer reports. Follow every rule and decision from this session. Reply with code blocks only.`;

const code = (text) => [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]).join("\n") || text;

/** Literal messages thrown, logged, or collected as warnings must start with `ledger: `; interpolated ones are not judged. */
function prefixed(source) {
	const calls = [...source.matchAll(/(?:throw new \w*Error|console\.(?:error|warn)|warn(?:ings)?\.push|warn)\(\s*([`"'])([^`"']*)/g)];
	return calls.every((call) => call[2].startsWith("ledger: ") || call[2].startsWith("${"));
}

export const TASK_CHECKS = [
	{ id: "memo-default", check: (source) => /memo\s*[:=][^;]{0,200}\bpayee\b/.test(source) || /memo[^;\n]*payee|payee[^;\n]*memo/.test(source) },
	{ id: "future-skip", check: (source) => /future|>\s*today|today\s*</i.test(source) && /warn/i.test(source) },
	{ id: "dedupe-key", check: (source) => source.split("\n").some((line) => /date/.test(line) && /amount/.test(line) && /payee/.test(line)) },
	{ id: "counts", check: (source) => /imported/.test(source) && /skipped/.test(source) && /dedup|duplicat/i.test(source) },
	{ id: "error-prefix", check: (source) => /ledger: /.test(source) && prefixed(source) },
	{ id: "no-floats", check: (source) => !/parseFloat|Number\(\s*\w+\.amount\s*\)\s*\*\s*100/.test(source) },
];

export function gradeTask(text) {
	const source = code(text);
	return TASK_CHECKS.map((check) => check.check(source));
}

export { materialize } from "./fixture.mjs";
