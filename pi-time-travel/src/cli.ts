#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type ClaudeHookInput, handleClaudeHook } from "./claude.ts";
import { type Config, judgeEndpoint } from "./config.ts";
import { Engine, FiredState } from "./engine.ts";
import { type Classify, httpClassifier } from "./judge.ts";
import { conditionMatch, inScope, type Output } from "./matcher.ts";
import { parseRule, type Rule, type Source } from "./rules.ts";
import { loadRuntime } from "./runtime.ts";
import { NewFiles, viewToolCall } from "./tools.ts";

const USAGE = `pi-time-travel: time-traveling stream rules for Pi and Claude Code

Usage:
  pi-time-travel list [--cwd DIR]
      Show the rules, settings, and judge in effect for a directory.
  pi-time-travel test <rule name or file> [--tool NAME | --source text|thinking] [--path P] [--judge [--facts JSON]] [--cwd DIR] [sample...]
      Check a sample (arguments, or stdin) against one rule. Exits 0 on a match, 1 otherwise.
      --judge asks the configured judge; --facts is the session facts it sees, e.g. '{"commandsRunThisSession":[]}'.
  pi-time-travel install claude [--settings FILE] [--print]
      Add the hooks to Claude Code's user settings (~/.claude/settings.json by default).
  pi-time-travel uninstall claude [--settings FILE]
      Remove them again.
  pi-time-travel hook claude
      The hook itself: reads Claude Code's hook input on stdin.
`;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function buildJudge(config: Config): Classify | { error: string } {
	const endpoint = judgeEndpoint(config.judge, process.env, homedir());
	return "error" in endpoint ? endpoint : httpClassifier(endpoint, config.judge.timeoutMs);
}

function runtimeFor(cwd: string, judge: boolean) {
	return loadRuntime({
		cwd,
		home: homedir(),
		env: process.env,
		project: true,
		judge: (config) => (judge ? buildJudge(config) : { error: "not requested (pass --judge)" }),
	});
}

function describeRule(rule: Rule): string {
	const scope = [rule.scope.text && "text", rule.scope.thinking && "thinking", ...[...rule.scope.tools.keys()].map((tool) => (tool === "*" ? "tool" : `tool:${tool}`))].filter(Boolean).join(", ");
	const parts = [`${rule.name}  (${rule.path})`, `  scope: ${scope}`];
	if (rule.conditions.length) parts.push(`  condition: ${rule.conditions.map(String).join("  ")}`);
	if (rule.question) parts.push(`  question: ${rule.question}`);
	if (rule.interruptMode) parts.push(`  interruptMode: ${rule.interruptMode}`);
	if (rule.alwaysApply) parts.push("  alwaysApply: true");
	if (rule.ignoreNewFiles) parts.push("  ignoreNewFiles: true");
	return parts.join("\n");
}

async function list(argv: string[]): Promise<number> {
	const { values } = parseArgs({ args: argv, options: { cwd: { type: "string" } } });
	const runtime = runtimeFor(resolve(values.cwd ?? process.cwd()), true);
	const { config } = runtime;
	console.log(`config: ${runtime.configSources.length ? runtime.configSources.join(", ") : "defaults"}`);
	console.log(`enabled: ${config.enabled}  contextMode: ${config.contextMode}  interruptMode: ${config.interruptMode}  repeatMode: ${config.repeatMode}`);
	console.log(`judge: ${runtime.judgeStatus}${config.judge.confirm ? " (confirms regex matches)" : ""}`);
	console.log(runtime.rules.length ? `\n${runtime.rules.map(describeRule).join("\n\n")}` : "\nno rules found");
	if (runtime.warnings.length) console.log(`\nwarnings:\n${runtime.warnings.map((w) => `  ${w}`).join("\n")}`);
	return 0;
}

async function test(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { tool: { type: "string" }, source: { type: "string" }, path: { type: "string" }, judge: { type: "boolean" }, facts: { type: "string" }, cwd: { type: "string" } },
	});
	const [target, ...sample] = positionals;
	if (!target) {
		console.error(USAGE);
		return 2;
	}
	const cwd = resolve(values.cwd ?? process.cwd());
	const runtime = runtimeFor(cwd, values.judge === true);
	let rule = runtime.rules.find((candidate) => candidate.name === target);
	if (!rule && existsSync(target)) {
		const parsed = parseRule(target.replace(/^.*\/|\.mdc?$/g, ""), resolve(target), readFileSync(target, "utf8"));
		for (const warning of parsed.warnings) console.error(`warning: ${warning}`);
		rule = parsed.rule;
	}
	if (!rule) {
		console.error(`no rule named "${target}"`);
		return 2;
	}
	const text = sample.length ? sample.join(" ") : await readStdin();
	let output: Output;
	if (values.tool) {
		const input = values.tool.toLowerCase() === "bash" ? { command: text } : { path: values.path ?? "file", content: text, new_string: text };
		const view = viewToolCall(values.tool, input, cwd);
		new NewFiles().mark(view, cwd);
		output = { source: "tool", text: view.text, view };
	} else output = { source: (values.source as Source | undefined) ?? "text", text };

	if (rule.ignoreNewFiles && output.view?.newPaths) {
		console.log(`no match: ${output.view.newPaths.join(", ")} does not exist under ${cwd}, so the agent would be creating it, and ${rule.name} ignores new files`);
		return 1;
	}
	if (!inScope(rule, output)) {
		console.log(`no match: ${rule.name} does not watch this ${output.view ? `${output.view.rawTool} call` : output.source}`);
		return 1;
	}
	const excerpt = conditionMatch(rule, output);
	if (rule.question && !values.judge) {
		console.log(`${excerpt !== undefined || rule.conditions.length === 0 ? "would ask the judge" : "no match (pre-filter)"}: ${rule.question}`);
		return excerpt !== undefined || rule.conditions.length === 0 ? 0 : 1;
	}
	// A rule given as a file is not among the directory's rules, so the runtime may not have built a judge for it.
	let classify = runtime.engine.classify;
	if (values.judge && !classify && runtime.config.judge.mode !== "off") {
		const built = buildJudge(runtime.config);
		if (typeof built === "function") classify = built;
		else console.error(`judge unavailable: ${built.error}`);
	}
	const engine = new Engine({ config: runtime.config, rules: [rule], classify });
	const facts = values.facts ? JSON.parse(values.facts) : undefined;
	const evaluation = await engine.evaluate([output], new FiredState(), () => facts);
	for (const error of evaluation.judgeErrors) console.error(`judge error: ${error}`);
	for (const verdict of evaluation.verdicts) console.log(`judge (${verdict.kind}): p=${verdict.probability.toFixed(2)} (threshold ${runtime.config.judge.threshold})`);
	for (const cleared of evaluation.cleared) console.log(`cleared by judge (p=${cleared.probability.toFixed(2)}): ${cleared.excerpt}`);
	const finding = evaluation.findings[0];
	if (!finding) {
		console.log("no match");
		return 1;
	}
	console.log(`match (${finding.how}${finding.probability !== undefined ? `, p=${finding.probability.toFixed(2)}` : ""}, ${finding.action}): ${finding.excerpt}`);
	return 0;
}

const HOOK_EVENTS = { SessionStart: 10, PreToolUse: 30, Stop: 30 } as const;
const isOurs = (hook: unknown) => {
	const command = (hook as { command?: unknown } | undefined)?.command;
	return typeof command === "string" && command.includes("pi-time-travel") && command.includes("hook claude");
};

export function hookCommand(cliPath: string): string {
	return `node ${JSON.stringify(cliPath)} hook claude`;
}

/** Settings with this package's hooks removed, then (unless removing) added once per event. */
export function withHooks(settings: Record<string, unknown>, command: string | undefined): Record<string, unknown> {
	const hooks = { ...((settings.hooks as Record<string, unknown[]> | undefined) ?? {}) };
	for (const event of Object.keys(HOOK_EVENTS)) {
		const groups = (hooks[event] ?? [])
			.map((group) => {
				const g = group as { hooks?: unknown[] };
				return Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((hook) => !isOurs(hook)) } : g;
			})
			.filter((group) => !Array.isArray((group as { hooks?: unknown[] }).hooks) || (group as { hooks: unknown[] }).hooks.length > 0);
		if (command) groups.push({ hooks: [{ type: "command", command, timeout: HOOK_EVENTS[event as keyof typeof HOOK_EVENTS] }] });
		if (groups.length) hooks[event] = groups;
		else delete hooks[event];
	}
	const next = { ...settings, hooks };
	if (Object.keys(hooks).length === 0) delete (next as { hooks?: unknown }).hooks;
	return next;
}

async function install(argv: string[], remove: boolean): Promise<number> {
	const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { settings: { type: "string" }, print: { type: "boolean" } } });
	if (positionals[0] !== "claude") {
		console.error(USAGE);
		return 2;
	}
	const cliPath = fileURLToPath(import.meta.url);
	const command = remove ? undefined : hookCommand(cliPath);
	if (values.print) {
		console.log(JSON.stringify(withHooks({}, command), null, 2));
		return 0;
	}
	const path = resolve(values.settings ?? join(homedir(), ".claude", "settings.json"));
	let settings: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			settings = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			console.error(`${path} is not valid JSON; not changed: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	}
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.pi-time-travel.tmp`;
	writeFileSync(temp, `${JSON.stringify(withHooks(settings, command), null, 2)}\n`);
	renameSync(temp, path);
	console.log(remove ? `Removed pi-time-travel hooks from ${path}` : `Added pi-time-travel hooks to ${path}:\n  ${command}`);
	return 0;
}

async function hook(argv: string[]): Promise<number> {
	if (argv[0] !== "claude") {
		console.error(USAGE);
		return 2;
	}
	// Fail open: an error here must never block the user's agent.
	try {
		const input = JSON.parse(await readStdin()) as ClaudeHookInput;
		const output = await handleClaudeHook(input, { home: homedir(), env: process.env });
		if (output) process.stdout.write(`${output}\n`);
	} catch (error) {
		process.stderr.write(`pi-time-travel: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	}
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	switch (command) {
		case "hook":
			return hook(rest);
		case "list":
			return list(rest);
		case "test":
			return test(rest);
		case "install":
			return install(rest, false);
		case "uninstall":
			return install(rest, true);
		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return command === undefined ? 2 : 0;
		default:
			console.error(`unknown command: ${command}\n\n${USAGE}`);
			return 2;
	}
}

const invokedDirectly = (() => {
	try {
		return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();
if (invokedDirectly) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
