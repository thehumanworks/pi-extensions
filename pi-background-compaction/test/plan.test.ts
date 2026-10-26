import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { findCut, keptTokens, misfit, planCompaction } from "../src/plan.ts";
import { assistant, session, words } from "./helpers.ts";

test("plans a summary of everything before the newest keepRecentTokens", () => {
	const { manager, ids } = session(10, 1000);
	const plan = planCompaction(manager.getBranch(), 4000)!;
	// Each message is ~1000 tokens: four kept, sixteen summarized.
	assert.equal(plan.firstKeptEntryId, ids[16]);
	assert.equal(plan.entryIds.length, 16);
	assert.equal(plan.messages.length, 16);
	assert.equal(plan.compactionId, null);
	assert.ok(plan.keptTokens >= 4000 && plan.keptTokens < 4100);
	assert.equal(plan.previousSummary, undefined);
});

test("returns nothing when everything fits in the kept tail", () => {
	const { manager } = session(2, 1000);
	assert.equal(planCompaction(manager.getBranch(), 10_000), undefined);
});

test("never cuts at a tool result", () => {
	const { manager } = session(4, 1000);
	const call = manager.appendMessage(
		assistant("", { content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }], stopReason: "toolUse" }),
	);
	manager.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: words(3000) }], isError: false, timestamp: Date.now() });
	const plan = planCompaction(manager.getBranch(), 2000)!;
	assert.equal(plan.firstKeptEntryId, call);
});

test("extends the latest compaction and carries its file lists", () => {
	const { manager, ids } = session(6, 1000);
	manager.appendCompaction("earlier summary", ids[8]!, 12000, { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] }, true);
	for (let i = 0; i < 4; i++) {
		manager.appendMessage({ role: "user", content: `more ${words(1000)}`, timestamp: Date.now() });
		manager.appendMessage(
			assistant("", { content: [{ type: "toolCall", id: `w${i}`, name: "write", arguments: { path: `c${i}.ts`, content: "" } }], stopReason: "toolUse" }),
		);
		manager.appendMessage({ role: "toolResult", toolCallId: `w${i}`, toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() });
	}
	const branch = manager.getBranch();
	const plan = planCompaction(branch, 2000)!;
	assert.equal(plan.previousSummary, "earlier summary");
	assert.equal(plan.compactionId, branch.find((entry) => entry.type === "compaction")!.id);
	// The summarized range starts at the previous compaction's first kept entry.
	assert.equal(plan.entryIds[0], ids[8]);
	assert.deepEqual(plan.files.readFiles, ["a.ts"]);
	assert.ok(plan.files.modifiedFiles.includes("b.ts") && plan.files.modifiedFiles.includes("c0.ts"));
});

test("extends a held checkpoint instead of the latest compaction", () => {
	const { manager, ids } = session(10, 1000);
	const plan = planCompaction(manager.getBranch(), 2000, { summary: "held", firstKeptEntryId: ids[12]!, files: { readFiles: [], modifiedFiles: [] } })!;
	assert.equal(plan.previousSummary, "held");
	assert.equal(plan.entryIds[0], ids[12]);
	assert.equal(plan.firstKeptEntryId, ids[18]);
});

test("uses a cut Pi already chose", () => {
	const { manager, ids } = session(10, 1000);
	const plan = planCompaction(manager.getBranch(), 2000, undefined, ids[14])!;
	assert.equal(plan.firstKeptEntryId, ids[14]);
	assert.equal(plan.entryIds.length, 14);
});

test("a plan stops fitting after a branch switch, a newer compaction, or an edit", () => {
	const { manager, ids } = session(10, 1000);
	const plan = planCompaction(manager.getBranch(), 4000)!;
	assert.equal(misfit(manager.getBranch(), plan), undefined);
	// More messages on the same branch keep it valid.
	manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
	assert.equal(misfit(manager.getBranch(), plan), undefined);

	manager.appendContextEdit(ids[2]!, { content: "redacted" });
	assert.match(misfit(manager.getBranch(), plan)!, /edited/);

	const fresh = planCompaction(manager.getBranch(), 4000)!;
	manager.branch(ids[10]!);
	manager.appendMessage({ role: "user", content: "other branch", timestamp: Date.now() });
	assert.match(misfit(manager.getBranch(), fresh)!, /not on the current branch/);

	const { manager: other } = session(10, 1000);
	const before = planCompaction(other.getBranch(), 4000)!;
	other.appendCompaction("summary", before.firstKeptEntryId, 20000);
	assert.match(misfit(other.getBranch(), before)!, /newer compaction/);
});

test("measures the kept tail as it grows", () => {
	const { manager } = session(10, 1000);
	const plan = planCompaction(manager.getBranch(), 4000)!;
	manager.appendMessage({ role: "user", content: words(2500), timestamp: Date.now() });
	const kept = keptTokens(manager.getBranch(), plan.firstKeptEntryId)!;
	assert.equal(kept - plan.keptTokens, 2500);
});

test("findCut keeps metadata entries with the kept messages", () => {
	const { manager, ids } = session(6, 1000);
	manager.appendModelChange("test", "other");
	manager.appendMessage({ role: "user", content: words(1000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(1000)));
	const entries = buildSessionProjection(manager.getBranch()).entries;
	const cut = findCut(entries, 0, 2000);
	assert.equal(entries[cut]!.sourceEntry.type, "model_change");
	assert.ok(ids.length > 0);
});
