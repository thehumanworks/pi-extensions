import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * What a rule sees of one tool call: the text it would act on, and the paths it touches.
 * File edits expose only the text they add, so a rule about new code ignores the old code it replaces.
 */
export interface ToolView {
	/** Canonical lowercase name, shared by Pi and Claude Code (`bash`, `edit`, `write`, ...). */
	tool: string;
	/** The harness's own name, e.g. `Bash`. */
	rawTool: string;
	text: string;
	/** Paths relative to the working directory when inside it. */
	paths: string[];
	/** Those of `paths` the agent created this session, set by NewFiles. */
	newPaths?: string[];
}

/**
 * Which paths the agent created this session. A path is new when it did not exist the first time
 * the agent touched it. Both harnesses check a tool call before it runs, so a path that does not
 * exist yet is one the agent is about to create.
 */
export class NewFiles {
	private readonly existed = new Map<string, boolean>();

	constructor(known: Record<string, boolean> = {}) {
		for (const [path, existed] of Object.entries(known)) this.existed.set(path, existed);
	}

	/** Sets `view.newPaths`. Call before the tool runs. */
	mark(view: ToolView, cwd: string): void {
		const created = view.paths.filter((path) => {
			let existed = this.existed.get(path);
			if (existed === undefined) {
				existed = existsSync(resolve(cwd, path));
				this.existed.set(path, existed);
			}
			return !existed;
		});
		if (created.length > 0) view.newPaths = created;
	}

	toJSON(): Record<string, boolean> {
		return Object.fromEntries(this.existed);
	}
}

const ALIASES: Record<string, string> = {
	bash: "bash",
	edit: "edit",
	multiedit: "edit",
	notebookedit: "edit",
	write: "write",
	read: "read",
	grep: "grep",
	glob: "find",
	find: "find",
	ls: "ls",
	webfetch: "fetch",
	websearch: "search",
};

export function canonicalTool(name: string): string {
	const lower = name.toLowerCase();
	return ALIASES[lower] ?? lower;
}

/** Whether a scope entry (`tool:<name>`) names this tool, by canonical or own name. */
export function toolNameMatches(scopeName: string, view: Pick<ToolView, "tool" | "rawTool">): boolean {
	return scopeName === "*" || scopeName === view.tool || scopeName === view.rawTool.toLowerCase() || canonicalTool(scopeName) === view.tool;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function displayPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path.replace(/\\/g, "/");
	const rel = relative(cwd, path);
	return (rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path).replace(/\\/g, "/");
}

export function viewToolCall(name: string, input: unknown, cwd: string): ToolView {
	const args = record(input);
	const tool = canonicalTool(name);
	const path = str(args.path) ?? str(args.file_path) ?? str(args.notebook_path);
	const paths = path ? [displayPath(path, cwd)] : [];
	const view = (text: string): ToolView => ({ tool, rawTool: name, text, paths });

	if (tool === "bash") return view(str(args.command) ?? "");
	if (tool === "write") return view(str(args.content) ?? "");
	if (tool === "edit") {
		if (Array.isArray(args.edits)) {
			// Pi: edits[].newText. Claude Code MultiEdit: edits[].new_string.
			return view(args.edits.map((edit) => str(record(edit).newText) ?? str(record(edit).new_string) ?? "").join("\n"));
		}
		return view(str(args.new_string) ?? str(args.newText) ?? str(args.new_source) ?? "");
	}
	if (Array.isArray(args.paths)) paths.push(...args.paths.filter((p): p is string => typeof p === "string").map((p) => displayPath(p, cwd)));
	return view(JSON.stringify(input ?? {}));
}
