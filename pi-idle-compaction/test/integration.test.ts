import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import idleCompaction, { ENTRY_TYPE } from "../index.ts";

/** About `tokens` tokens of text (Pi estimates four characters per token). */
const words = (tokens: number) => "word ".repeat(tokens).slice(0, tokens * 4);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real AgentSession on the faux provider, with a large window so Pi's own threshold never triggers. */
async function start(idleSettings: unknown) {
	const dir = await mkdtemp(join(tmpdir(), "pi-idle-compaction-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4000 }] });
	faux.setResponses(Array.from({ length: 20 }, (_, i) => () => fauxAssistantMessage(`reply ${i} ${words(2000)}`)));
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "test");
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1000 }, idleCompaction: idleSettings } as never);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		extensionFactories: [idleCompaction],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager,
		noTools: "all",
	});
	await modelRuntime.refresh({ allowNetwork: false });
	await session.bindExtensions({});
	return {
		session,
		entries: () => sessionManager.getEntries(),
		dispose: async () => {
			session.dispose();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

test("a real session over the threshold is compacted once idle, with a notice entry after it", async () => {
	const run = await start({ tokenThreshold: 5000, idleMinutes: 0.005 }); // 300 ms
	try {
		for (let i = 0; i < 4; i++) await run.session.prompt(`question ${i} ${words(500)}`);
		assert.equal(run.entries().some((entry) => entry.type === "compaction"), false, "not compacted while active");
		await sleep(1000);
		const types = run.entries().map((entry) => (entry.type === "custom" ? `custom:${entry.customType}` : entry.type));
		const compaction = types.indexOf("compaction");
		assert.notEqual(compaction, -1, "compacted while idle");
		assert.equal(types[compaction + 1], `custom:${ENTRY_TYPE}`, "notice follows the compaction");
		assert.equal(types.filter((type) => type === "compaction").length, 1, "compacts once");
	} finally {
		await run.dispose();
	}
});

test("a real session below the threshold, or with idle compaction off, is left alone", async () => {
	for (const settings of [{ tokenThreshold: 100_000, idleMinutes: 0.005 }, false]) {
		const run = await start(settings);
		try {
			for (let i = 0; i < 4; i++) await run.session.prompt(`question ${i} ${words(500)}`);
			await sleep(600);
			assert.equal(run.entries().some((entry) => entry.type === "compaction" || entry.type === "custom"), false);
		} finally {
			await run.dispose();
		}
	}
});
