/**
 * Minimal path globs: `**` crosses directories, `*` and `?` stay within one segment,
 * `{a,b}` is alternation. Enough for rule `globs` and `tool:<name>(<glob>)` scopes.
 */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	let depth = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				// `**/` also matches zero directories.
				if (glob[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else out += ".*";
			} else out += "[^/]*";
		} else if (c === "?") out += "[^/]";
		else if (c === "{") {
			depth++;
			out += "(?:";
		} else if (c === "}" && depth > 0) {
			depth--;
			out += ")";
		} else if (c === "," && depth > 0) out += "|";
		else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/** Whether `path` (relative, `/`-separated) or its basename matches any glob. */
export function matchesAnyGlob(globs: RegExp[], path: string): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	return globs.some((glob) => glob.test(normalized) || glob.test(base));
}
