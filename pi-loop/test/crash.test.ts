import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

test("SIGKILL mid-tool resumes the run without replaying its unsafe host side effect", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-crash-"));
  let child: ChildProcess | undefined;
  const start = (mode: string) => spawn(process.execPath,
    ["--experimental-strip-types", "test/fixtures/crash-runner.ts", mode, dir],
    { stdio: ["ignore", "pipe", "pipe"] });
  try {
    child = start("init");
    const end = Date.now() + 8000;
    while (true) {
      try { if ((await readFile(join(dir, "effect.txt"), "utf8")).includes("once")) break; } catch {}
      if (Date.now() > end) throw new Error("Tool did not start");
      await delay(20);
    }
    child.kill("SIGKILL");
    await once(child, "exit");
    child = start("recover");
    let errorOutput = "";
    child.stderr!.on("data", data => { errorOutput += data; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errorOutput);
    assert.equal(await readFile(join(dir, "effect.txt"), "utf8"), "once\n");
    assert.equal(await readFile(join(dir, "recovered.txt"), "utf8"), "Recovered after crash");
  } finally {
    child?.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
