import {
	buildSessionProjection,
	type CompactionEntry,
	estimateTokens,
	type ProjectedSessionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type AgentMessage = ProjectedSessionEntry["messages"][number];

export interface FileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

/** A summary standing in for every entry before `firstKeptEntryId`. */
export interface Checkpoint {
	summary: string;
	firstKeptEntryId: string;
	files: FileLists;
}

/** What one summary request covers, fixed when the request starts. */
export interface Plan {
	/** Latest compaction on the branch when planned. The plan only applies while it is still the latest. */
	compactionId: string | null;
	/** Summary this plan extends: the latest compaction's, or a held background summary's. */
	previousSummary?: string;
	/** Raw entries whose messages are summarized, oldest first. */
	entryIds: string[];
	/** Context edits on the branch when planned; a later edit of a summarized entry invalidates the plan. */
	editIds: string[];
	messages: AgentMessage[];
	/** First entry kept verbatim after the summary. */
	firstKeptEntryId: string;
	files: FileLists;
	summarizedTokens: number;
	/** Estimated tokens from `firstKeptEntryId` to the end of the branch when planned. */
	keptTokens: number;
}

const CUT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

const entryTokens = (entry: ProjectedSessionEntry) =>
	entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

const isCutPoint = (entry: ProjectedSessionEntry) =>
	entry.sourceEntry.type !== "compaction" && entry.messages.some((message) => CUT_ROLES.has(message.role));

/** The newest compaction contributes the projection's summary; older ones in its kept range project nothing. */
function latestCompaction(entries: ProjectedSessionEntry[]): number {
	return entries.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
}

function readFileLists(details: unknown): FileLists {
	const value = details as Partial<FileLists> | undefined;
	const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item) => typeof item === "string") : []);
	return { readFiles: strings(value?.readFiles), modifiedFiles: strings(value?.modifiedFiles) };
}

/**
 * Pick the first kept entry the way Pi does: walk back from the newest entry until `keepRecentTokens`
 * are kept, then cut at the nearest user, assistant, or custom message at or after that point. Tool
 * results stay with their call. Returns `start` when everything fits.
 */
export function findCut(entries: ProjectedSessionEntry[], start: number, keepRecentTokens: number): number {
	const cutPoints: number[] = [];
	for (let i = start; i < entries.length; i++) if (isCutPoint(entries[i]!)) cutPoints.push(i);
	if (cutPoints.length === 0) return start;
	let total = 0;
	for (let i = entries.length - 1; i >= start; i--) {
		const tokens = entryTokens(entries[i]!);
		if (tokens === 0) continue;
		total += tokens;
		if (total < keepRecentTokens) continue;
		let cut = cutPoints.find((candidate) => candidate >= i) ?? cutPoints.at(-1)!;
		// Metadata entries just before the cut stay with the kept messages.
		while (cut > start && entries[cut - 1]!.messages.length === 0 && entries[cut - 1]!.sourceEntry.type !== "compaction") cut--;
		return cut;
	}
	return start;
}

function fileLists(messages: AgentMessage[], previous: FileLists): FileLists {
	const read = new Set(previous.readFiles);
	const modified = new Set(previous.modifiedFiles);
	const add = (name: string, args: unknown) => {
		const path = (args as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string") return;
		if (name === "read") read.add(path);
		else if (name === "write" || name === "edit") modified.add(path);
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") add(block.name, block.arguments);
		} else if (message.role === "toolResult") {
			// Codemode scripts record the tools they called on their result.
			for (const call of message.nestedCalls?.calls ?? []) add(call.name, call.arguments);
		}
	}
	return { readFiles: [...read].filter((path) => !modified.has(path)).sort(), modifiedFiles: [...modified].sort() };
}

/**
 * Plan a summary of the branch up to a cut that keeps about `keepRecentTokens` verbatim, or up to
 * `cutEntryId` when Pi already chose the cut. With `base`, extend that checkpoint instead of the latest
 * compaction, summarizing only what lies between its first kept entry and the new cut.
 */
export function planCompaction(branch: SessionEntry[], keepRecentTokens: number, base?: Checkpoint, cutEntryId?: string): Plan | undefined {
	if (branch.length === 0 || branch.at(-1)!.type === "compaction") return undefined;
	const entries = buildSessionProjection(branch).entries;
	const compactionIndex = latestCompaction(entries);
	const compaction = compactionIndex >= 0 ? (entries[compactionIndex]!.sourceEntry as CompactionEntry) : undefined;
	let start = compactionIndex + 1;
	let previousSummary = compaction?.summary;
	let previousFiles = readFileLists(compaction?.details);
	if (base) {
		const index = entries.findIndex((entry) => entry.sourceEntry.id === base.firstKeptEntryId);
		if (index < start) return undefined;
		start = index;
		previousSummary = base.summary;
		previousFiles = base.files;
	}
	const cut = cutEntryId ? entries.findIndex((entry) => entry.sourceEntry.id === cutEntryId) : findCut(entries, start, keepRecentTokens);
	if (cut <= start) return undefined;
	const summarized = entries.slice(start, cut).filter((entry) => entry.sourceEntry.type !== "compaction");
	const messages = summarized.flatMap((entry) => entry.messages.filter((message) => message.role !== "system"));
	if (messages.length === 0) return undefined;
	return {
		compactionId: compaction?.id ?? null,
		previousSummary,
		entryIds: summarized.map((entry) => entry.sourceEntry.id),
		editIds: branch.filter((entry) => entry.type === "context_edit").map((entry) => entry.id),
		messages,
		firstKeptEntryId: entries[cut]!.sourceEntry.id,
		files: fileLists(messages, previousFiles),
		summarizedTokens: messages.reduce((sum, message) => sum + estimateTokens(message), 0),
		keptTokens: entries.slice(cut).reduce((sum, entry) => sum + entryTokens(entry), 0),
	};
}

/**
 * Why `plan` no longer fits `branch`, or undefined when its summary can still replace the entries it
 * covers: the same compaction is the latest, the first kept entry is on this branch after it, and no
 * summarized entry was edited since.
 */
export function misfit(branch: SessionEntry[], plan: Pick<Plan, "compactionId" | "entryIds" | "editIds" | "firstKeptEntryId">): string | undefined {
	let compactionId: string | null = null;
	let compactionIndex = -1;
	let keptIndex = -1;
	branch.forEach((entry, index) => {
		if (entry.type === "compaction") {
			compactionId = entry.id;
			compactionIndex = index;
		}
		if (entry.id === plan.firstKeptEntryId) keptIndex = index;
	});
	if (compactionId !== plan.compactionId) return "a newer compaction replaced the summarized history";
	if (keptIndex < 0) return "the summarized history is not on the current branch";
	if (compactionIndex >= 0) {
		const kept = (branch[compactionIndex] as CompactionEntry).firstKeptEntryId;
		const keptStart = branch.findIndex((entry) => entry.id === kept);
		if (keptIndex < Math.max(keptStart, 0)) return "the kept history starts before the latest compaction";
	}
	const known = new Set(plan.editIds);
	const summarized = new Set(plan.entryIds);
	for (const entry of branch) {
		if (entry.type === "context_edit" && !known.has(entry.id) && summarized.has(entry.targetId)) return "a summarized message was edited";
	}
	return undefined;
}

/** Estimated tokens Pi would send from `firstKeptEntryId` onwards, or undefined when it is not projected. */
export function keptTokens(branch: SessionEntry[], firstKeptEntryId: string): number | undefined {
	const entries = buildSessionProjection(branch).entries;
	const index = entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	if (index < 0) return undefined;
	return entries.slice(index).reduce((sum, entry) => sum + entryTokens(entry), 0);
}

/** Every model-visible message on the branch, as Pi would send it next. */
export function projectedMessages(branch: SessionEntry[]): AgentMessage[] {
	return buildSessionProjection(branch).messages;
}
