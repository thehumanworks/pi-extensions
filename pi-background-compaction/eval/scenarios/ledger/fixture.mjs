// The "ledger" project the eval sessions work on. Facts the probes ask about are planted in
// user turns (rules, decisions, corrections) and in large files the agent must read.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function rng(seed) {
	return () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
}

function spec() {
	const sections = [
		["Overview", "ledger is a command-line tool for personal bookkeeping. It imports bank exports, categorizes transactions, and prints reports. All state lives in the data directory."],
		["Amounts", "Amounts are written with an optional leading minus, digits, and an optional fractional part of exactly two digits, using `.` as the decimal separator. Thousands separators are not allowed. `12`, `12.50`, and `-0.07` are valid; `12.5`, `1,200.00`, and `12.505` are not. Parsed amounts are integer cents."],
		["Import", "The import command reads a CSV export. Rows whose `memo` column is blank must take the payee name as their memo. Rows dated in the future are rejected with a warning and skipped, not fatal. Duplicate rows, identified by date, amount, and payee, are imported once. The importer must report how many rows were imported, skipped, and deduplicated."],
		["Categories", "Each transaction gets exactly one category. Rules are matched in order, first match wins; a transaction matching no rule is categorized as `uncategorized`. Category names are case-insensitive."],
		["Reports", "Report totals are rounded half-even (banker's rounding) when converted for display. Reports list categories by descending total spend, ties broken alphabetically. The default report period is the current calendar month."],
		["Accounts", "Account names are unique, case-sensitive, and may contain spaces. Transfers between accounts are recorded as two linked transactions and are excluded from spend totals."],
		["Exit codes", "0 on success, 1 for user errors (bad input, unknown command), 2 for data errors (corrupt files), 3 for internal errors."],
	];
	const next = rng(7);
	let text = "# ledger specification\n\n";
	for (const [title, body] of sections) {
		text += `## ${title}\n\n${body}\n\n`;
		// Padding paragraphs make the spec long enough that summaries must choose what to keep.
		for (let i = 0; i < 6; i++) {
			text += `Note ${title.toLowerCase()}-${i + 1}: implementations should keep behavior stable across versions; this note covers edge case ${Math.floor(next() * 900 + 100)} of the ${title.toLowerCase()} rules and is informative only. It repeats guidance from the overview for readers who start here, and it does not change any requirement stated above.\n\n`;
		}
	}
	return text;
}

const CATEGORIES = ["groceries", "rent", "transport", "dining", "utilities", "books", "health", "travel"];
const PAYEES = { groceries: ["Fresh Market", "Corner Grocer"], rent: ["Oak Street Lettings"], transport: ["City Metro", "RideShare"], dining: ["Blue Door Cafe", "Noodle Bar"], utilities: ["PowerCo", "AquaWorks"], books: ["Paper Lantern Books"], health: ["Main St Pharmacy"], travel: ["SkyHop Air", "Harbor Hotel"] };

function transactions() {
	const next = rng(42);
	const rows = [];
	for (let i = 0; i < 260; i++) {
		const category = CATEGORIES[Math.floor(next() * CATEGORIES.length)];
		const payee = PAYEES[category][Math.floor(next() * PAYEES[category].length)];
		const scale = { rent: 140000, travel: 30000, groceries: 9000, utilities: 7000, dining: 4000, transport: 2500, books: 2000, health: 3000 }[category];
		const cents = -Math.round(scale * (0.4 + next()));
		const day = 1 + Math.floor(next() * 28);
		rows.push({ id: `t${1000 + i}`, date: `2026-09-${String(day).padStart(2, "0")}`, account: next() < 0.7 ? "Checking" : "Credit Card", payee, amount_cents: cents, category });
	}
	return rows;
}

/** Totals by category, most spend first: the answer to the data probe. */
export function topCategories(count = 3) {
	const totals = new Map();
	for (const row of transactions()) totals.set(row.category, (totals.get(row.category) ?? 0) - row.amount_cents);
	return [...totals].sort((a, b) => b[1] - a[1]).slice(0, count);
}

function importLog() {
	const next = rng(99);
	const lines = [];
	let time = Date.parse("2026-10-20T02:00:00Z");
	for (let row = 1; row <= 640; row++) {
		time += Math.floor(next() * 400);
		const stamp = new Date(time).toISOString();
		if (row % 97 === 0) lines.push(`${stamp} WARN  row=${row} file=bank-export-oct.csv future-dated row skipped`);
		else if (row % 41 === 0) lines.push(`${stamp} INFO  row=${row} file=bank-export-oct.csv duplicate of row ${row - 3}, skipped`);
		else lines.push(`${stamp} DEBUG row=${row} file=bank-export-oct.csv parsed payee="${Object.values(PAYEES).flat()[row % 13]}" amount=${(next() * 200).toFixed(2)}`);
	}
	lines.push(`${new Date(time + 120).toISOString()} ERROR row=637 file=bank-export-oct.csv TypeError: Cannot read properties of undefined (reading 'currency')`);
	lines.push("    at normalizeRow (src/csv.js:26:31)");
	lines.push("    at parseCsv (src/csv.js:19:13)");
	lines.push("    at main (src/cli.js:10:17)");
	lines.push(`${new Date(time + 140).toISOString()} FATAL import aborted after 636 rows; nothing was committed`);
	return `${lines.join("\n")}\n`;
}

const FILES = {
	"package.json": `${JSON.stringify({ name: "ledger", version: "0.3.0", type: "module", bin: { ledger: "src/cli.js" }, scripts: { test: "node --test test/" } }, null, 2)}\n`,
	"README.md": "# ledger\n\nPersonal bookkeeping CLI. See docs/SPEC.md.\n\n```\nledger import <file.csv>\nledger report [--category NAME]\n```\n",
	"src/ledger.js": `// Core ledger operations.

/** Parse an amount string into integer cents. */
export function parseAmount(text) {
	throw new Error("not implemented");
}

/** Sum transaction amounts (integer cents) by category. */
export function totalsByCategory(transactions) {
	const totals = {};
	for (const t of transactions) totals[t.category] = (totals[t.category] ?? 0) + t.amount_cents;
	return totals;
}
`,
	"src/csv.js": `// CSV import. Rows look like: date;payee;amount;memo, with an optional meta column (JSON).

export function splitLine(line) {
	return line.split(";");
}

/** Parse CSV text into normalized rows. */
export function parseCsv(text) {
	const lines = text.split(/\\r?\\n/).filter(Boolean);
	const header = splitLine(lines.shift());
	const rows = [];
	for (const line of lines) {
		const cells = splitLine(line);
		const record = {};
		header.forEach((name, i) => {
			record[name] = cells[i];
		});
		if (record.meta) record.meta = JSON.parse(record.meta);
		rows.push(normalizeRow(record));
	}
	return rows;
}

export function normalizeRow(record) {
	// Currency defaults to the account currency when the export does not say.
	const currency = record.meta.currency ?? "EUR";
	return { date: record.date, payee: record.payee, amount: record.amount, memo: record.memo, currency };
}
`,
	"src/cli.js": `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseCsv } from "./csv.js";

const [command, ...args] = process.argv.slice(2);

function main() {
	switch (command) {
		case "import": {
			const rows = parseCsv(readFileSync(args[0], "utf8"));
			console.log(\`imported \${rows.length} rows\`);
			return 0;
		}
		case "report":
			console.log("report: not implemented");
			return 0;
		default:
			console.error(\`unknown command: \${command}\`);
			return 1;
	}
}

process.exitCode = main();
`,
	"legacy/old-ledger.js": "// Frozen: the 0.1 importer, kept for the migration script. Do not edit.\nmodule.exports = function oldImport(text) {\n\treturn text.split('\\n').map((line) => line.split(','));\n};\n",
	"test/ledger.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { totalsByCategory } from "../src/ledger.js";

test("totals by category", () => {
	assert.deepEqual(totalsByCategory([{ category: "a", amount_cents: -100 }, { category: "a", amount_cents: -50 }]), { a: -150 });
});
`,
};

export function materialize(dir) {
	const files = { ...FILES, "docs/SPEC.md": spec(), "data/transactions.json": `${JSON.stringify(transactions(), null, 1)}\n`, "logs/import-2026-10-20.log": importLog() };
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=eval@example.com", "-c", "user.name=eval", "commit", "-qm", "fixture"], { cwd: dir });
}
