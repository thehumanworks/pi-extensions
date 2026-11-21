import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { conditionMatch, inScope, type Output } from "../src/matcher.ts";
import { loadRules, parseRule } from "../src/rules.ts";
import { NewFiles, viewToolCall } from "../src/tools.ts";

const rule = (frontmatter: string, body = "Use pnpm.") => parseRule("r", "/r.md", `---\n${frontmatter}\n---\n${body}\n`);
const tool = (name: string, input: unknown, cwd = "/repo"): Output => {
	const view = viewToolCall(name, input, cwd);
	return { source: "tool", text: view.text, view };
};

test("parses omp's frontmatter: conditions, scope, globs, interruptMode, question", () => {
	const { rule: parsed, warnings } = rule(`description: pnpm only
condition:
  - '\\bnpm\\s+install\\b'
  - '/YARN add/i'
scope: [text, "tool:bash"]
interruptMode: tool-only
question: Does it use npm?`);
	assert.deepEqual(warnings, []);
	assert.equal(parsed?.conditions.length, 2);
	assert.equal(parsed?.conditions[1]!.flags, "i");
	assert.equal(parsed?.interruptMode, "tool-only");
	assert.equal(parsed?.question, "Does it use npm?");
	assert.equal(parsed?.scope.text, true);
	assert.equal(parsed?.scope.tools.has("bash"), true);
	assert.equal(parsed?.body, "Use pnpm.");
});

test("invalid parts are warned about and ignored, like omp", () => {
	const { rule: parsed, warnings } = rule(`condition: ['(unclosed', 'ok']\nastCondition: 'x'\nscope: tool, sideways\ninterruptMode: sometimes`);
	assert.equal(parsed?.conditions.length, 1);
	assert.equal(warnings.length, 4);
	for (const expected of [/invalid regex/, /astCondition/, /unknown scope "sideways"/, /interruptMode/]) assert.match(warnings.join("\n"), expected);
});

test("a rule needs a trigger or alwaysApply, a body, and a reachable scope", () => {
	assert.equal(rule("description: nothing").rule, undefined);
	assert.equal(rule("condition: x", "").rule, undefined);
	assert.equal(rule("condition: x\nscope: nowhere").rule, undefined);
	assert.ok(rule("alwaysApply: true").rule, "an up-front rule needs no trigger");
	assert.equal(rule("condition: x").rule?.scope.thinking, false, "the default scope is text and tools, not thinking");
});

test("tool scopes match Pi's and Claude Code's tool names, and path globs", () => {
	const { rule: tests } = rule(`condition: '\\.skip\\('\nscope: tool:edit(**/*.test.*)`);
	assert.ok(tests);
	const edit = (name: string, input: object) => inScope(tests, tool(name, input));
	assert.equal(edit("edit", { path: "src/a.test.ts", edits: [{ oldText: "it(", newText: "it.skip(" }] }), true);
	assert.equal(edit("Edit", { file_path: "/repo/src/a.test.ts", old_string: "it(", new_string: "it.skip(" }), true);
	assert.equal(edit("MultiEdit", { file_path: "/repo/a.test.js", edits: [{ new_string: "x" }] }), true);
	assert.equal(edit("Edit", { file_path: "/repo/src/a.ts", new_string: "it.skip(" }), false);
	assert.equal(edit("Write", { file_path: "/repo/src/a.test.ts", content: "x" }), false, "write is a different tool");
	const { rule: several } = rule(`condition: x\nscope: tool:write(test/**, **/*.spec.*), text`);
	assert.equal(several?.scope.text, true);
	assert.equal(several?.scope.tools.get("write")?.length, 2, "commas inside the parentheses separate globs, not scopes");
	assert.equal(inScope(several!, tool("write", { path: "src/a.spec.ts", content: "x" })), true);
	const { rule: bash } = rule("condition: npm\nscope: tool:Bash");
	assert.equal(inScope(bash!, tool("bash", { command: "npm i" })), true);
	assert.equal(inScope(bash!, { source: "text", text: "npm i" }), false);
});

test("edits expose only the text they add", () => {
	const { rule: anyType } = rule(`condition: ': any\\b'\nscope: tool:edit`);
	const removing = tool("edit", { path: "a.ts", edits: [{ oldText: "x: any", newText: "x: unknown" }] });
	const adding = tool("Edit", { file_path: "/repo/a.ts", old_string: "x: unknown", new_string: "x: any" });
	assert.equal(conditionMatch(anyType!, removing), undefined);
	assert.equal(conditionMatch(anyType!, adding), "x: any");
});

test("rule globs gate on the paths a call touches", () => {
	const { rule: generated } = rule(`condition: '[\\s\\S]'\nscope: tool\nglobs: ['src/generated/**']`);
	assert.equal(inScope(generated!, tool("write", { path: "src/generated/api.js", content: "x" })), true);
	assert.equal(inScope(generated!, tool("Write", { file_path: "/repo/src/generated/deep/api.js", content: "x" })), true);
	assert.equal(inScope(generated!, tool("write", { path: "src/api.js", content: "x" })), false);
	assert.equal(inScope(generated!, tool("bash", { command: "ls" })), false, "no path, no match");
});

test("ignoreNewFiles: files the agent created this session do not count", async () => {
	const repo = await mkdtemp(join(tmpdir(), "pi-time-travel-new-"));
	try {
		await mkdir(join(repo, "test"));
		await writeFile(join(repo, "test", "old.test.js"), "test('x', () => {})");
		const { rule: tests } = rule("condition: '^'\nscope: tool:edit(test/**), tool:write(test/**)\nignoreNewFiles: true");
		const { rule: strict } = rule("condition: '^'\nscope: tool:edit(test/**), tool:write(test/**)");
		assert.equal(tests!.ignoreNewFiles, true);
		assert.equal(strict!.ignoreNewFiles, false);
		const files = new NewFiles();
		const call = (name: string, input: object) => {
			const output = tool(name, input, repo);
			files.mark(output.view!, repo);
			return output;
		};
		const created = call("write", { path: "test/new.test.js", content: "x" });
		assert.deepEqual(created.view!.newPaths, ["test/new.test.js"]);
		assert.equal(inScope(tests!, created), false, "writing a new test file");
		await writeFile(join(repo, "test", "new.test.js"), "x");
		assert.equal(inScope(tests!, call("edit", { path: "test/new.test.js", edits: [{ oldText: "x", newText: "y" }] })), false, "editing it later: it existed only because the agent wrote it");
		assert.equal(inScope(tests!, call("edit", { path: "test/old.test.js", edits: [{ oldText: "x", newText: "y" }] })), true, "an existing test");
		assert.equal(inScope(strict!, call("edit", { path: "test/new.test.js", edits: [{ oldText: "x", newText: "y" }] })), true, "rules without the key still see new files");
		assert.deepEqual(new NewFiles(files.toJSON()).toJSON(), { "test/new.test.js": false, "test/old.test.js": true }, "the record survives serialisation");
		assert.match(rule("condition: x\nignoreNewFiles: yes").warnings.join(), /ignoreNewFiles must be true or false/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("excerpts show the matching line, trimmed", () => {
	const { rule: npm } = rule("condition: npm install");
	const text = `first line\n${"x".repeat(300)} npm install lodash ${"y".repeat(300)}\nlast`;
	const excerpt = conditionMatch(npm!, { source: "text", text })!;
	assert.match(excerpt, /^…x+ npm install lodash y+…$/);
	assert.ok(excerpt.length < 210);
});

test("project rules shadow user rules by name; disabled rules and untrusted projects are skipped", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-time-travel-rules-"));
	try {
		const home = join(root, "home");
		const repo = join(root, "repo");
		await mkdir(join(home, ".agents", "ttsr"), { recursive: true });
		await mkdir(join(repo, ".git"), { recursive: true });
		await mkdir(join(repo, ".agents", "ttsr"), { recursive: true });
		await mkdir(join(repo, "pkg"), { recursive: true });
		await mkdir(join(repo, ".omp", "rules"), { recursive: true });
		await writeFile(join(home, ".agents", "ttsr", "shared.md"), "---\ncondition: user\n---\nUser version.");
		await writeFile(join(home, ".agents", "ttsr", "off.md"), "---\ncondition: x\n---\nOff.");
		await writeFile(join(repo, ".agents", "ttsr", "shared.md"), "---\ncondition: project\n---\nProject version.");
		await writeFile(join(repo, ".agents", "ttsr", "notes.txt"), "not a rule");
		await writeFile(join(repo, ".omp", "rules", "triggered.mdc"), "---\ncondition: y\n---\nFrom omp.");
		await writeFile(join(repo, ".omp", "rules", "always.md"), "---\nalwaysApply: true\n---\nomp rulebook.");

		const trusted = loadRules({ cwd: join(repo, "pkg"), home, project: true, omp: true }, ["off"]);
		assert.deepEqual(trusted.rules.map((r) => r.name).sort(), ["shared", "triggered"]);
		assert.equal(trusted.rules.find((r) => r.name === "shared")!.body, "Project version.");

		const untrusted = loadRules({ cwd: repo, home, project: false });
		assert.deepEqual(untrusted.rules.map((r) => [r.name, r.body]).sort(), [["off", "Off."], ["shared", "User version."]]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
