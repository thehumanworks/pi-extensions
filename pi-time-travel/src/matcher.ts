import { matchesAnyGlob } from "./glob.ts";
import type { Rule, Source } from "./rules.ts";
import { toolNameMatches, type ToolView } from "./tools.ts";

/** One finished piece of agent output: its prose, its thinking, or one tool call. */
export interface Output {
	source: Source;
	text: string;
	/** Set for tool calls. */
	view?: ToolView;
	/** The tool call id, when there is one. */
	id?: string;
}

/** Longest text a regex runs over. Larger outputs are checked by their head and tail. */
const MAX_TEXT = 200_000;
const MAX_EXCERPT = 200;

export function inScope(rule: Rule, output: Output): boolean {
	const { scope, ignoreNewFiles } = rule;
	const view = output.view;
	const paths = view ? (ignoreNewFiles ? view.paths.filter((path) => !view.newPaths?.includes(path)) : view.paths) : [];
	// A call that only touches files the agent created is outside an ignoreNewFiles rule.
	if (view && ignoreNewFiles && view.paths.length > 0 && paths.length === 0) return false;
	let reachable = false;
	if (output.source === "text") reachable = scope.text;
	else if (output.source === "thinking") reachable = scope.thinking;
	else if (view) {
		for (const [name, globs] of scope.tools) {
			if (!toolNameMatches(name, view)) continue;
			if (!globs || paths.some((path) => matchesAnyGlob(globs, path))) {
				reachable = true;
				break;
			}
		}
	}
	if (!reachable) return false;
	if (rule.globs.length === 0) return true;
	return paths.some((path) => matchesAnyGlob(rule.globs, path));
}

function bounded(text: string): string {
	return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT / 2)}\n${text.slice(-MAX_TEXT / 2)}`;
}

/** The line around a match, trimmed to a readable length. */
export function excerptAround(text: string, index: number, length: number): string {
	const start = text.lastIndexOf("\n", index) + 1;
	const newline = text.indexOf("\n", index + length);
	const end = newline === -1 ? text.length : newline;
	let line = text.slice(start, end).trim();
	if (line.length > MAX_EXCERPT) {
		const offset = Math.max(0, index - start - 60);
		line = `${offset > 0 ? "…" : ""}${line.slice(offset, offset + MAX_EXCERPT)}…`;
	}
	return line;
}

/** The excerpt of the first condition that matches, or undefined. Rules without conditions never match here. */
export function conditionMatch(rule: Rule, output: Output): string | undefined {
	const text = bounded(output.text);
	for (const condition of rule.conditions) {
		condition.lastIndex = 0;
		const match = condition.exec(text);
		if (match) return excerptAround(text, match.index, match[0].length);
	}
	return undefined;
}

/** A trimmed copy of an output for a judge or a log. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max / 2)}\n…\n${text.slice(-max / 2)}`;
}
