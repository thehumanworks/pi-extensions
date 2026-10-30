// Offline acceptance test of the *installed wrapper*, not the source checkout.
// Usage: node nix/smoke-test.mjs /absolute/out/bin/workflow
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const executable = process.argv[2];
assert.ok(process.argv.length === 3 && executable && isAbsolute(executable),
  "Usage: node nix/smoke-test.mjs /absolute/out/bin/workflow");
await access(executable, constants.X_OK);

// Do not use TMPDIR from the caller: Nix build directories can exceed the Unix
// socket path limit. Nothing in this test reads the user's Pi home or credentials.
const root = await realpath(await mkdtemp("/tmp/pw-"));
const project = join(root, "p");
const home = join(root, "w");
const socket = join(home, "worker.sock");
const env = {
  PATH: "", HOME: join(root, "h"), TMPDIR: join(root, "t"),
  PI_CODING_AGENT_DIR: join(root, "a"), PI_WORKFLOW_HOME: home, PI_OFFLINE: "1",
  XDG_CONFIG_HOME: join(root, "h", ".config"), XDG_CACHE_HOME: join(root, "h", ".cache"),
  LANG: "C", LC_ALL: "C", TZ: "UTC", TERM: "dumb", NO_COLOR: "1",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Nix smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid",
  GIT_COMMITTER_NAME: "Nix smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid",
};
// In particular, no caller PATH, NODE_PATH, NODE_OPTIONS, PI_WORKFLOW_NODE,
// proxy variables, provider keys or Git configuration leaks in.
const abort = new AbortController();
const interrupted = () => abort.abort(new Error("Smoke test interrupted"));
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
const workers = new Set();

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function invoke(args, { json = true, cleanup = false, timeout = 45_000 } = {}) {
  return new Promise(resolve => {
    execFile(executable, [...args, "--home", home, ...(json ? ["--json"] : [])], {
      cwd: project, env,
      encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
      ...(cleanup ? {} : { signal: abort.signal }),
    }, (error, stdout, stderr) => {
      let data;
      try { data = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { /* human output or failed startup */ }
      resolve({ code: error ? error.code ?? error.signal ?? 1 : 0, stdout, stderr, data });
    });
  });
}

async function cli(args, options = {}) {
  const reply = await invoke(args, options);
  assert.equal(reply.code, options.code ?? 0,
    `workflow ${args.join(" ")}\n${reply.stdout}\n${reply.stderr}`);
  if (options.json !== false) assert.notEqual(reply.data, undefined, `Missing JSON reply: ${reply.stdout}`);
  return options.json === false ? reply.stdout : reply.data;
}

function remember(status) {
  // Never stop or signal a worker belonging to any other home, even if a broken
  // wrapper accidentally discards our environment/--home argument.
  assert.equal(status.home, home, "worker must use the isolated workflow home");
  assert.ok(Number.isSafeInteger(status.pid) && status.pid > 1 && status.pid !== process.pid);
  workers.add(status.pid);
  return status;
}

async function live(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
  if (process.platform === "linux") {
    try {
      // Detached children may remain zombies under a container's non-reaping PID 1.
      const state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.[0];
      if (state === "Z" || state === "X") return false;
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  return true;
}

async function isolatedWorker(pid) {
  // Also find a worker that was spawned but failed before answering its first
  // ping. Verify both its role and unique home before any fallback SIGTERM.
  try {
    const [environment, command] = await Promise.all([
      readFile(`/proc/${pid}/environ`, "utf8"), readFile(`/proc/${pid}/cmdline`, "utf8"),
    ]);
    return environment.split("\0").includes(`PI_WORKFLOW_HOME=${home}`)
      && command.split("\0").some(arg => arg.endsWith("/dist/worker.js"));
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return false;
    throw error;
  }
}

async function stopWorker() {
  const status = await invoke(["worker", "status"], { cleanup: true, timeout: 5_000 });
  if (status.code === 0) {
    remember(status.data);
    await cli(["worker", "stop"], { cleanup: true, timeout: 10_000 });
  } else if (process.platform === "linux") {
    for (const entry of await readdir("/proc")) {
      if (/^\d+$/.test(entry) && await isolatedWorker(Number(entry))) workers.add(Number(entry));
    }
  }
  for (const pid of workers) {
    // RPC stop is preferred. If startup/IPC failed, SIGTERM follows the worker's
    // own graceful close handler; never use SIGKILL or a process-name-wide kill.
    if (await live(pid) && status.code !== 0 && await isolatedWorker(pid)) process.kill(pid, "SIGTERM");
  }
  const deadline = Date.now() + 15_000;
  while (await exists(socket) || (await Promise.all([...workers].map(live))).some(Boolean)) {
    assert.ok(Date.now() < deadline, `Isolated worker did not stop; retaining ${root} for diagnosis`);
    await delay(50);
  }
  workers.clear();
}

// This is an ordinary external TypeScript workflow: public package exports only,
// no symlinked dependencies and no imports of dist/loader or engine internals.
const source = String.raw`
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";
import { bestOf } from "@nothumanwork/pi-orchestration/recipes";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";

assert.equal(typeof bestOf, "function");
assert.equal(typeof defineTool, "function");
assert.equal(Value.Check(Type.Number(), 42), true);

export default defineWorkflow({
  name: "nix-smoke",
  args: Type.Object({ n: Type.Number() }),
  async run(ctx) {
    const tools = await ctx.step("tools", async ({ cwd, signal }) => {
      await appendFile(join(cwd, "effects"), "tools\n");
      const execute = promisify(execFile);
      const command = async (file: string, args: string[]) =>
        (await execute(file, args, { cwd, signal, timeout: 15_000, encoding: "utf8" })).stdout.trim();
      const paths: Record<string, string> = {};
      // Resolve commands by name in the detached worker, with no test-supplied
      // PATH or PI_WORKFLOW_NODE. Every executable must come from the Nix closure.
      for (const name of ["node", "bash", "which", "env", "cat", "mkdir", "rm", "git"]) {
        paths[name] = await command("which", [name]);
        assert.match(paths[name], /^\/nix\/store\/[^/]+\/bin\//);
      }
      const childNode = JSON.parse(await command("node", ["-p", "JSON.stringify({execPath:process.execPath,version:process.version})"]));
      assert.equal(await realpath(childNode.execPath), await realpath(process.execPath));
      assert.equal(childNode.version, process.version);
      assert.ok(Number(process.versions.node.split(".")[0]) >= 22);
      assert.match(await command("bash", ["--version"]), /GNU bash/);
      assert.match(await command("env", ["--version"]), /GNU coreutils/);
      assert.match(await command("git", ["--version"]), /^git version /);
      assert.equal(await command("bash", ["--noprofile", "--norc", "-c", "set -eu; mkdir shell-test; printf pinned > shell-test/value; cat shell-test/value; rm -r shell-test"]), "pinned");
      assert.equal(process.env.PI_OFFLINE, "1");

      // Real Git worktree creation/use/removal, without a remote, signing, user
      // configuration or an agent/model. Worktrees are private to this fixture.
      const git = (args: string[]) => command("git", args);
      await git(["init", "--quiet", "--initial-branch=main"]);
      await writeFile(join(cwd, "tracked"), "initial\n");
      await git(["add", "tracked"]);
      await git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial"]);
      const worktree = join(cwd, "worktree");
      await git(["worktree", "add", "--quiet", "-b", "smoke-branch", worktree]);
      try {
        assert.equal(await readFile(join(worktree, "tracked"), "utf8"), "initial\n");
        await writeFile(join(worktree, "tracked"), "worktree\n");
        await git(["-C", worktree, "-c", "commit.gpgsign=false", "commit", "--quiet", "-am", "worktree"]);
        assert.equal(await readFile(join(cwd, "tracked"), "utf8"), "initial\n");
        assert.equal(await git(["-C", worktree, "branch", "--show-current"]), "smoke-branch");
      } finally {
        await git(["worktree", "remove", "--force", worktree]);
        await git(["branch", "-D", "smoke-branch"]);
      }
      assert.equal((await git(["worktree", "list", "--porcelain"])).split("\n").filter(line => line.startsWith("worktree ")).length, 1);
      await assert.rejects(stat(worktree), { code: "ENOENT" });

      // Execute the installed durable bash tool directly with a minimal output
      // sink, not a conversation or a faux model. Select the pinned shell
      // explicitly so a host /bin/bash cannot mask a missing packaged bash.
      const executionEnv = new NodeExecutionEnv({ cwd, shellPath: paths.bash });
      const context = { abortSignal: signal } as Parameters<NodeExecutionEnv["exec"]>[2];
      let output = "";
      const api = {
        env: executionEnv,
        output(chunk: string | Uint8Array) { output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(); },
        retainedOutput() { return { text: output, truncated: false }; },
        diagnostic(value: unknown) { throw new Error(JSON.stringify(value)); },
      } as ToolExecutionApi;
      try {
        const result = await createBashTool().execute({
          command: "set -eu; test -n \"$BASH_VERSION\"; test \"$(which node)\" = " + JSON.stringify(paths.node)
            + "; node -e 'process.stdout.write(\"durable-bash-ok\")'; git rev-parse --is-inside-work-tree > /dev/null",
          timeout: 10,
        }, api, context);
        assert.ok(!result.isError, JSON.stringify(result));
        assert.equal(result.structuredOutput?.exitCode, 0);
        assert.equal(output, "durable-bash-ok");
      } finally { await executionEnv.cleanup(context); }
      return { pid: process.pid, node: childNode, paths, bashTool: output, gitWorktree: true };
    });
    const multiplier = await ctx.signal("continue", { schema: Type.Number() });
    const pid = await ctx.step("finish", async ({ cwd }) => {
      await appendFile(join(cwd, "effects"), "finish\n");
      return process.pid;
    });
    return { answer: ctx.args.n * multiplier, tools, pid };
  },
});
`;

let failure;
try {
  for (const directory of [project, home, env.HOME, env.TMPDIR, env.PI_CODING_AGENT_DIR]) await mkdir(directory, { recursive: true });
  for (let directory = project; ; directory = dirname(directory)) {
    assert.equal(await exists(join(directory, "node_modules")), false, "external project must not resolve checkout/hoisted dependencies");
    if (dirname(directory) === directory) break;
  }
  const help = await cli(["--help"], { json: false });
  assert.match(help, /^workflow guide/m);
  assert.match(help, /workflow worker start\|stop\|status/);
  const guide = await cli(["guide"], { json: false });
  assert.match(guide, /ctx\.step/);
  for (const pattern of [/ (\/\S+\/README\.md)$/m, / (\/\S+\/examples\/workflows\/)$/m]) {
    const path = pattern.exec(guide)?.[1];
    assert.ok(path, "guide must reference installed documentation");
    assert.match(await realpath(path), /^\/nix\/store\//);
    await access(path);
  }
  const initialized = await cli(["init", "starter"]);
  assert.equal(initialized.path, join(project, ".pi", "workflows", "starter.ts"));
  assert.match(await readFile(initialized.path, "utf8"), /defineWorkflow/);
  // Never run the generated agent-based example: this test makes no model calls.
  await writeFile(join(project, ".pi", "workflows", "nix-smoke.ts"), source);

  assert.equal(await exists(socket), false, "help, guide and init must not start a worker");
  const first = remember(await cli(["worker", "start"]));
  assert.equal(remember(await cli(["worker", "status"])).pid, first.pid);
  const validation = await cli(["validate", "nix-smoke"]);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  assert.equal(validation.name, "nix-smoke");
  const catalog = await cli(["catalog"]);
  assert.ok(catalog.some(entry => entry.name === "nix-smoke" && !entry.error));
  const launched = await cli(["run", "nix-smoke", "--bg", "--args", '{"n":21}']);
  const id = launched.runId;
  assert.equal(typeof id, "string");
  const waiting = await cli(["poll", id, "--until", "signal", "--interval", "50ms"]);
  assert.equal(waiting.status, "waiting_signal");
  assert.ok(waiting.steps.some(step => step.key === "root/tools" && step.status === "completed"), JSON.stringify(waiting));
  assert.equal(await readFile(join(project, "effects"), "utf8"), "tools\n");
  assert.equal((await readFile(join(home, "runs.sqlite"))).subarray(0, 16).toString(), "SQLite format 3\0");

  await stopWorker();
  const second = remember(await cli(["worker", "start"]));
  assert.notEqual(second.pid, first.pid, "restart must use a new detached worker");
  const recovered = await cli(["poll", id, "--until", "signal", "--interval", "50ms"]);
  assert.equal(recovered.status, "waiting_signal");
  assert.equal(recovered.steps.find(step => step.key === "root/tools")?.attempts, 1);
  assert.equal(await readFile(join(project, "effects"), "utf8"), "tools\n", "committed effects must not replay");
  assert.equal((await cli(["signal", id, "continue", '"wrong-type"'], { code: 1 })).error.code, "invalid_signal");
  await cli(["signal", id, "continue", "2"]);
  const done = await cli(["poll", id, "--interval", "50ms"]);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.result.answer, 42);
  assert.equal(done.result.tools.pid, first.pid);
  assert.equal(done.result.pid, second.pid);
  assert.equal(done.result.tools.bashTool, "durable-bash-ok");
  assert.equal(done.result.tools.gitWorktree, true);
  assert.equal(done.usage.agents, 0, "smoke must not invoke providers");
  assert.equal(await readFile(join(project, "effects"), "utf8"), "tools\nfinish\n");
  assert.deepEqual(await cli(["result", id]), done.result);
  await stopWorker();
  remember(await cli(["worker", "start"]));
  assert.deepEqual(await cli(["result", id]), done.result, "completed result must survive restart");
  assert.equal((await cli(["list", "--all"])).length, 1);
  console.log("Installed Nix smoke passed: aliases, pinned tools, Git worktree, durable bash, detached worker, signal, replay and persisted result (offline, zero agents).");
} catch (error) {
  failure = error;
  try { console.error("--- isolated worker.log ---\n" + await readFile(join(home, "worker.log"), "utf8")); }
  catch { /* worker may not have started */ }
} finally {
  try {
    await stopWorker();
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    // Do not delete a live worker's home underneath it. Surface cleanup failure
    // as a failed test rather than leaking silently or killing unrelated PIDs.
    failure = failure ? new AggregateError([failure, error], `Smoke/cleanup failed; retained ${root}`) : error;
  }
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
