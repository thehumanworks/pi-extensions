import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBot } from "../src/bots.ts";
import { invocations, persona, tempRoot, useFakePi } from "./helpers.ts";
// @ts-expect-error The launcher is plain JavaScript without type declarations.
import { botsRoot, launchArgs } from "../bin/pi-bot.mjs";

const BIN = fileURLToPath(new URL("../bin/pi-bot.mjs", import.meta.url));
const launch = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: process.env });

test("the launcher resolves the bots root like the extension", () => {
  assert.equal(botsRoot({ PI_BOT_HOME: "/x/bots" }), "/x/bots");
  assert.equal(botsRoot({ PI_CODING_AGENT_DIR: "/agent" }), "/agent/bots");
  assert.deepEqual(launchArgs("a", ["-c"], "/r"), ["--session-dir", "/r/a/sessions", "--bot", "a", "-c"]);
});

test("pi-bot starts pi with the bot's session directory and passes options through", async t => {
  const root = await tempRoot(t);
  await createBot({ name: "reviewer", description: "Reviews: diffs", prompt: persona });
  const log = await useFakePi(t);
  const run = launch(["reviewer", "-c", "--model", "x"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(invocations(log)[0]!.args, ["--session-dir", join(root, "reviewer", "sessions"), "--bot", "reviewer", "-c", "--model", "x"]);
  const listed = launch(["list"]);
  assert.equal(listed.stdout.trim(), "reviewer — Reviews: diffs");
  assert.match(launch([]).stdout, /Usage: pi-bot <name>[\s\S]*reviewer — Reviews: diffs/);
  const unknown = launch(["ghost"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown bot "ghost"/);
});
