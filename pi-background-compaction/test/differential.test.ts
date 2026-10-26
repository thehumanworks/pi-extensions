import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { planCompaction } from "../src/plan.ts";
import { assistant, words } from "./helpers.ts";

// prepareCompaction is internal to Pi; load it from the installed package to compare cut points.
const compactionModule = new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { prepareCompaction } = (await import(compactionModule.href)) as {
	prepareCompaction: (entries: unknown[], settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }) =>
		| { firstKeptEntryId: string; messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; previousSummary?: string }
		| undefined;
};

function random(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
}

function randomSession(seed: number) {
	const next = random(seed);
	const manager = SessionManager.inMemory("/tmp/project");
	let calls = 0;
	for (let turn = 0; turn < 12 + Math.floor(next() * 12); turn++) {
		manager.appendMessage({ role: "user", content: words(50 + Math.floor(next() * 1500)), timestamp: Date.now() });
		for (let step = 0; step < Math.floor(next() * 4); step++) {
			const id = `call${calls++}`;
			manager.appendMessage(assistant(words(20), { content: [{ type: "toolCall", id, name: "read", arguments: { path: `f${id}.ts` } }], stopReason: "toolUse" }));
			manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: words(Math.floor(next() * 3000)) }], isError: false, timestamp: Date.now() });
		}
		manager.appendMessage(assistant(words(30 + Math.floor(next() * 800))));
		if (next() < 0.08) manager.appendModelChange("test", `m${turn}`);
		if (turn === 9 && next() < 0.5) {
			const branch = manager.getBranch();
			const pi = prepareCompaction(branch, { enabled: true, reserveTokens: 0, keepRecentTokens: 3000 });
			if (pi) manager.appendCompaction("checkpoint", pi.firstKeptEntryId, 1, undefined, true);
		}
	}
	return manager;
}

test("cut points and summarized messages match Pi's prepareCompaction", () => {
	let compared = 0;
	for (let seed = 1; seed <= 200; seed++) {
		const branch = randomSession(seed).getBranch();
		for (const keep of [1000, 4000, 12000]) {
			const pi = prepareCompaction(branch, { enabled: true, reserveTokens: 0, keepRecentTokens: keep });
			const ours = planCompaction(branch, keep);
			assert.equal(ours?.firstKeptEntryId, pi?.firstKeptEntryId, `seed ${seed} keep ${keep}`);
			if (!pi || !ours) continue;
			assert.deepEqual(ours.messages, [...pi.messagesToSummarize, ...pi.turnPrefixMessages], `seed ${seed} keep ${keep}`);
			assert.equal(ours.previousSummary, pi.previousSummary);
			compared++;
		}
	}
	assert.ok(compared > 300, `compared ${compared}`);
});
