import { chmodSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

/** A temporary bots root exposed through PI_BOT_HOME for the duration of a test. */
export async function tempRoot(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bot-"));
  const previous = process.env.PI_BOT_HOME;
  process.env.PI_BOT_HOME = join(dir, "bots");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_BOT_HOME; else process.env.PI_BOT_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return join(dir, "bots");
}

export const persona = "You review code for correctness.\n\nBe direct.";

export const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

/** Route child Pi processes to the fake for one test; returns the invocation log path. */
export async function useFakePi(t: TestContext, mode = "ok"): Promise<string> {
  chmodSync(FAKE_PI, 0o755);
  const dir = await mkdtemp(join(tmpdir(), "pi-bot-run-"));
  const saved = { command: process.env.PI_BOT_PI_COMMAND, log: process.env.FAKE_PI_LOG, mode: process.env.FAKE_PI_MODE };
  Object.assign(process.env, { PI_BOT_PI_COMMAND: FAKE_PI, FAKE_PI_LOG: join(dir, "log.jsonl"), FAKE_PI_MODE: mode });
  t.after(async () => {
    for (const [key, value] of [["PI_BOT_PI_COMMAND", saved.command], ["FAKE_PI_LOG", saved.log], ["FAKE_PI_MODE", saved.mode]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return join(dir, "log.jsonl");
}

export const invocations = (log: string) => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; cwd: string; depth: string });
