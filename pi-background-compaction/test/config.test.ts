import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compactionSettings, readConfig } from "../src/config.ts";
import { PI_PROMPTS } from "../src/prompts.ts";

test("defaults", () => {
	const config = readConfig({}, "/tmp", {});
	assert.equal(config.enabled, false);
	assert.equal(config.trigger, 0.7);
	assert.equal(config.swap, "threshold");
	assert.equal(config.request, "auto");
	assert.equal(config.model, undefined);
	assert.equal(config.promptName, "coding");
	assert.equal(config.toolResultChars, 16_000);
});

test("settings and environment overrides", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bg-config-"));
	await writeFile(join(dir, "focus.md"), "Keep test names.\n");
	const config = readConfig(
		{ backgroundCompaction: { trigger: 0.7, model: "openai/gpt-6.1-sol", prompt: "pi", focus: "@focus.md", keepRecentTokens: 8000 } },
		dir,
		{ PI_BACKGROUND_COMPACTION_TRIGGER: "0.9", PI_BACKGROUND_COMPACTION_REQUEST: "transcript", PI_BACKGROUND_COMPACTION_TRACE: "/tmp/t.jsonl" },
	);
	assert.equal(config.trigger, 0.9);
	assert.equal(config.model, "openai/gpt-6.1-sol");
	assert.equal(config.request, "transcript");
	assert.equal(config.prompts.initial, PI_PROMPTS.initial);
	assert.equal(config.focus, "Keep test names.");
	assert.equal(config.keepRecentTokens, 8000);
	assert.equal(config.trace, "/tmp/t.jsonl");
	assert.equal(readConfig({}, dir, { PI_BACKGROUND_COMPACTION: "0" }).enabled, false);
	assert.throws(() => readConfig({ backgroundCompaction: { model: "session" } }, dir, {}), /explicit provider\/modelId/);
});

test("enabling requires an explicit model, and a model alone does not enable", () => {
	assert.equal(readConfig({ backgroundCompaction: { model: "test/cheap" } }, "/tmp", {}).enabled, false);
	assert.throws(() => readConfig({ backgroundCompaction: { enabled: true } }, "/tmp", {}), /set a compaction model/);
	assert.throws(() => readConfig({}, "/tmp", { PI_BACKGROUND_COMPACTION: "1" }), /set a compaction model/);
	assert.equal(readConfig({}, "/tmp", { PI_BACKGROUND_COMPACTION: "1", PI_BACKGROUND_COMPACTION_MODEL: "test/cheap" }).enabled, true);
});

test("session commands override environment and file controls", () => {
	const config = readConfig(
		{ backgroundCompaction: { enabled: true, model: "test/file" } }, "/tmp",
		{ PI_BACKGROUND_COMPACTION: "1", PI_BACKGROUND_COMPACTION_MODEL: "test/env" },
		{ enabled: false, model: "test/command" },
	);
	assert.equal(config.enabled, false);
	assert.equal(config.model, "test/command");
});

test("invalid settings are rejected", () => {
	assert.throws(() => readConfig({ backgroundCompaction: { trigger: 2 } }, "/tmp", {}), /trigger/);
	assert.throws(() => readConfig({ backgroundCompaction: { swap: "later" } }, "/tmp", {}), /swap/);
	assert.throws(() => readConfig({ backgroundCompaction: { model: "gpt" } }, "/tmp", {}), /model/);
	assert.throws(() => readConfig({ backgroundCompaction: { prompt: "nope" } }, "/tmp", {}), /prompt/);
	assert.throws(() => readConfig({ backgroundCompaction: [] }, "/tmp", {}), /object/);
});

test("compaction settings follow Pi's model overrides", () => {
	const settings = { compaction: { reserveTokens: 20000, modelOverrides: { "openai/big": { reserveTokens: 400000 } } } };
	assert.deepEqual(compactionSettings(settings, { provider: "openai", id: "big" }), { enabled: true, reserveTokens: 400000, keepRecentTokens: 20000 });
	assert.deepEqual(compactionSettings(settings, { provider: "openai", id: "small" }), { enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 });
	assert.deepEqual(compactionSettings(undefined), { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
	assert.equal(compactionSettings({ compaction: { enabled: false } }).enabled, false);
});
