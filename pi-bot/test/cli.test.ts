import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBot } from "../src/bots.ts";
import { persona, tempRoot } from "./helpers.ts";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const EXTENSION = fileURLToPath(new URL("../index.ts", import.meta.url));
const CHECK_STORAGE = fileURLToPath(new URL("./fixtures/check-storage.ts", import.meta.url));

test("pi --bot stores history in one bot home across working directories and storage overrides", async t => {
  const root = await tempRoot(t);
  const bot = await createBot({ name: "reviewer", description: "Reviews diffs", prompt: persona });
  const agentDir = join(root, "agent");
  const configuredDir = join(root, "configured-sessions");
  await mkdir(agentDir, { recursive: true });

  for (const override of ["default", "setting", "env", "cli"]) {
    const settings = override === "default" ? {} : { sessionDir: configuredDir };
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
    const cwd = join(root, `project-${override}`);
    const report = join(root, `report-${override}.json`);
    const overrideDir = join(root, `${override}-sessions`);
    await mkdir(cwd);
    const args = [CLI, "--offline", "-ne", "-e", EXTENSION, "-e", CHECK_STORAGE, "--bot", "reviewer", "--mode", "json", "-p"];
    if (override === "cli") args.push("--session-dir", overrideDir);
    args.push("/check-storage");
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_BOT_TEST_REPORT: report };
    delete env.PI_CODING_AGENT_SESSION_DIR;
    if (override === "env") env.PI_CODING_AGENT_SESSION_DIR = overrideDir;
    const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const saved = JSON.parse(await readFile(report, "utf8"));
    assert.equal(saved.cwd, cwd);
    assert.equal(saved.dir, join(bot.home, "sessions"));
    assert.equal(dirname(saved.file), saved.dir);
    const entries = (await readFile(saved.file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries[0].cwd, cwd);
    assert.equal(entries[0].id, saved.id);
    assert.ok(entries.some(entry => entry.type === "custom" && entry.customType === "storage-check"));
    // JSON mode emits the header before extension startup. Redirection must preserve its ID.
    assert.equal(JSON.parse(result.stdout.trim().split("\n")[0]!).id, saved.id);
    const outsideDir = override === "default" ? join(agentDir, "sessions") : override === "setting" ? configuredDir : overrideDir;
    const outsideFiles = await readdir(outsideDir, { recursive: true });
    assert.deepEqual(outsideFiles.filter(file => file.endsWith(".jsonl")), []);
    assert.doesNotMatch(result.stderr, /not in the bot's home|Start with `pi-bot/);
  }
  assert.equal((await readdir(join(bot.home, "sessions"))).length, 4);
});
