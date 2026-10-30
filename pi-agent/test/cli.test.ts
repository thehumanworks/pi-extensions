import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definition, fixture } from "./helpers.ts";
const execAsync = promisify(execFile);
const exec: typeof execAsync = ((...args: Parameters<typeof execAsync>) => {
  const promise = execAsync(...args);
  promise.child.stdin?.end();
  return promise;
}) as typeof execAsync;
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const extension = fileURLToPath(new URL("../index.ts", import.meta.url));

test("SIGINT cancels a selected print-mode agent even before the outer Pi turn starts", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition("tester", "tools: [bash]\nskills: []"));
  await mkdir(join(f.agentDir, "extensions"));
  await writeFile(join(f.agentDir, "mcp.json"), '{"mcpServers":{}}');
  const marker = join(f.root, "started");
  await writeFile(join(f.agentDir, "extensions/faux.ts"), `import {fauxProvider, fauxAssistantMessage as answer, fauxToolCall as call} from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux")))};
export default pi => { const faux=fauxProvider({tokensPerSecond:100000});
  faux.setResponses([answer(call('bash',{command:${JSON.stringify(`printf ready > '${marker}'; sleep 30`)}}),{stopReason:'toolUse'})]);
  pi.registerProvider(faux.provider);
};`);
  const pending = exec(process.execPath, [cli, "-e", extension, "--agent", "tester", "-p", "wait"], { cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, PI_AGENT_HOME: f.store.root }, timeout: 15_000 });
  t.after(() => { pending.child.kill("SIGKILL"); });
  const rejected = assert.rejects(pending, (error: any) => {
    assert.match(error.stderr, /interrupted by process signal/);
    return true;
  });
  const until = Date.now() + 10_000;
  while (!(await readFile(marker, "utf8").catch(() => ""))) {
    if (Date.now() > until) throw new Error("Timed out waiting for child tool");
    await new Promise(r => setTimeout(r, 20));
  }
  pending.child.kill("SIGINT");
  await rejected;
});

test("real Pi CLI --agent works in print and JSON modes, persists history, and fails closed", { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  await f.store.create("tester", definition("tester", "tools: []\nskills: []"));
  await mkdir(join(f.agentDir, "extensions"));
  // Installed globally as well as explicit -e: child SDK discovery must not recursively load the adapter.
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", extensions: [extension], retry: { enabled: false } }));
  await writeFile(join(f.agentDir, "mcp.json"), '{"mcpServers":{}}');
  await writeFile(join(f.agentDir, "extensions/faux.ts"), `import {fauxProvider, fauxAssistantMessage} from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux")))};
export default pi => { const faux=fauxProvider({tokensPerSecond:100000});
  faux.setResponses([ctx => fauxAssistantMessage('native reply '+ctx.messages.filter(m=>m.role==='user').length)]);
  pi.registerProvider(faux.provider);
};`);
  const options = { cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, PI_AGENT_HOME: f.store.root }, timeout: 20_000, maxBuffer: 1024 * 1024 };
  const first = await exec(process.execPath, [cli, "-e", extension, "--agent", "tester", "-p", "hello"], options);
  assert.match(first.stdout, /native reply 1/, JSON.stringify(first));
  const second = await exec(process.execPath, [cli, "-e", extension, "--agent", "tester", "--mode", "json", "second"], options);
  const events = second.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(e => JSON.stringify(e).includes("native reply 2")), second.stdout);
  await assert.rejects(exec(process.execPath, [cli, "-e", extension, "--agent", "missing", "-p", "must not reach outer model"], options), (error: any) => {
    assert.match(error.stderr, /Unknown agent/);
    assert.doesNotMatch(error.stdout, /native reply/);
    return true;
  });
});
