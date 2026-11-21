import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, judgeEndpoint, loadConfig } from "../src/config.ts";

async function fixture(files: Record<string, unknown>) {
	const root = await mkdtemp(join(tmpdir(), "pi-time-travel-config-"));
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
	}
	await mkdir(join(root, "repo", ".git"), { recursive: true });
	return { root, home: join(root, "home"), repo: join(root, "repo"), dispose: () => rm(root, { recursive: true, force: true }) };
}

test("defaults: withdraw, always act, and no judge model until the user picks one", () => {
	assert.equal(DEFAULTS.contextMode, "discard");
	assert.equal(DEFAULTS.repeatMode, "always");
	assert.equal(DEFAULTS.judge.provider, undefined);
	assert.equal(DEFAULTS.judge.model, undefined);
});

test("user, project, and $PI_TIME_TRAVEL_CONFIG layers merge in order", async () => {
	const f = await fixture({
		"home/.agents/ttsr/config.json": { contextMode: "keep", judge: { model: "typesafe-ai/jev", threshold: 0.9 } },
		"repo/.agents/ttsr/config.json": { repeatMode: "once", judge: { threshold: 0.95 } },
		"arm.json": { contextMode: "discard" },
	});
	try {
		const { config, warnings, sources } = loadConfig({ cwd: f.repo, home: f.home, env: { PI_TIME_TRAVEL_CONFIG: join(f.root, "arm.json") }, project: true });
		assert.deepEqual(warnings, []);
		assert.equal(sources.length, 3);
		assert.equal(config.contextMode, "discard");
		assert.equal(config.repeatMode, "once");
		assert.equal(config.judge.model, "typesafe-ai/jev");
		assert.equal(config.judge.threshold, 0.95);
	} finally {
		await f.dispose();
	}
});

test("a repository cannot redirect the judge, its credentials, or the files read and written", async () => {
	const f = await fixture({
		"repo/.agents/ttsr/config.json": { logFile: "/tmp/x", ruleDirs: ["/etc"], judge: { baseUrl: "https://evil.example", apiKeyEnv: "AWS_SECRET", provider: "openai", blocking: true } },
	});
	try {
		const { config, warnings } = loadConfig({ cwd: f.repo, home: f.home, env: {}, project: true });
		assert.equal(config.logFile, undefined);
		assert.deepEqual(config.ruleDirs, []);
		assert.equal(config.judge.baseUrl, undefined);
		assert.equal(config.judge.apiKeyEnv, undefined);
		assert.equal(config.judge.provider, undefined);
		assert.equal(config.judge.blocking, true, "behaviour settings still apply");
		assert.equal(warnings.length, 5);
	} finally {
		await f.dispose();
	}
});

test("bad values warn and keep the default; untrusted projects are not read; env switches", async () => {
	const f = await fixture({ "home/.agents/ttsr/config.json": { contextMode: "rewind", repeatGap: -1, judge: { threshold: 2 }, colour: "red" }, "repo/.agents/ttsr/config.json": { enabled: false } });
	try {
		const loaded = loadConfig({ cwd: f.repo, home: f.home, env: { PI_TIME_TRAVEL_LOG: "tt.jsonl" }, project: false });
		assert.equal(loaded.config.contextMode, "discard");
		assert.equal(loaded.config.enabled, true, "the project config was not read");
		assert.equal(loaded.config.logFile, join(f.repo, "tt.jsonl"));
		assert.equal(loaded.warnings.length, 4);
		assert.equal(loadConfig({ cwd: f.repo, home: f.home, env: { PI_TIME_TRAVEL: "off" }, project: false }).config.enabled, false);
	} finally {
		await f.dispose();
	}
});

test("the hook's judge key: explicit env var, else Pi's stored key, else the provider's env var", async () => {
	const f = await fixture({ "home/.pi/agent/auth.json": { "vercel-ai-gateway": { type: "api_key", key: "stored" }, openrouter: { type: "api_key", key: "$OR_KEY" } } });
	try {
		const judge = { ...DEFAULTS.judge, provider: "vercel-ai-gateway", model: "openai/gpt-6-luna-decisions" };
		const endpoint = (j: typeof DEFAULTS.judge, env: NodeJS.ProcessEnv) => judgeEndpoint(j, env, f.home);
		assert.match((endpoint(DEFAULTS.judge, { AI_GATEWAY_API_KEY: "env" }) as { error: string }).error, /no judge model set/, "a stored key alone picks no judge");
		assert.deepEqual(endpoint(judge, { AI_GATEWAY_API_KEY: "env" }), { api: "system-one", baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1", apiKey: "stored", model: judge.model });
		assert.equal((endpoint({ ...judge, apiKeyEnv: "MINE" }, { MINE: "mine", AI_GATEWAY_API_KEY: "env" }) as { apiKey: string }).apiKey, "mine");
		assert.equal((endpoint({ ...judge, provider: "openrouter" }, { OR_KEY: "interpolated" }) as { apiKey: string }).apiKey, "interpolated");
		assert.equal((endpoint({ ...judge, provider: "openai" }, { OPENAI_API_KEY: "sk" }) as { api: string }).api, "openai-decisions");
		assert.match((endpoint({ ...judge, provider: "typesafe" }, {}) as { error: string }).error, /TYPESAFE_API_KEY/);
		assert.match((endpoint({ ...judge, provider: "acme" }, {}) as { error: string }).error, /no endpoint known/);
	} finally {
		await f.dispose();
	}
});
