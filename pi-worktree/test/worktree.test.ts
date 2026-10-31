import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import worktreeExtension from "../index.ts";

const dirs: string[] = [];
after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));

function repo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-worktree-test-")));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

function harness(cwd: string) {
  const events = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notices: { message: string; level: string }[] = [];
  const pi = {
    on: (name: string, handler: any) => events.set(name, handler),
    registerFlag: () => {},
    registerCommand: (name: string, options: any) => commands.set(name, options.handler),
    getFlag: () => false,
  };
  worktreeExtension(pi as any);
  const ctx = {
    cwd,
    hasUI: false,
    waitForIdle: async () => {},
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
  };
  return { events, commands, notices, ctx };
}

test("/worktree creates a named worktree and redirects tools into it", async () => {
  const root = repo();
  const { events, commands, ctx } = harness(root);
  await commands.get("worktree")!("feature-x", ctx);

  const wt = path.join(root, ".pi", "worktrees", "feature-x");
  assert.ok(existsSync(path.join(wt, ".git")));
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: wt, encoding: "utf8" }).trim(), "pi/feature-x");
  assert.match(readFileSync(path.join(root, ".git", "info", "exclude"), "utf8"), /^\.pi\/worktrees\/$/m);

  const read = { toolName: "read", input: { path: "src/a.ts" } };
  events.get("tool_call")!(read, ctx);
  assert.equal(read.input.path, path.join(wt, "src/a.ts"));

  const ls = { toolName: "ls", input: {} as { path?: string } };
  events.get("tool_call")!(ls, ctx);
  assert.equal(ls.input.path, wt);

  const bash = { toolName: "bash", input: { command: "pwd" } };
  events.get("tool_call")!(bash, ctx);
  assert.equal(bash.input.command, `cd ${JSON.stringify(wt)}\npwd`);

  const prompt = await events.get("before_agent_start")!({ systemPrompt: "base" }, ctx);
  assert.match(prompt.systemPrompt, /Git worktree mode/);
});

test("/worktree rejects invalid names without creating anything", async () => {
  const root = repo();
  const { events, commands, notices, ctx } = harness(root);
  await commands.get("worktree")!("../escape", ctx);
  assert.equal(notices.at(-1)?.level, "error");
  assert.ok(!existsSync(path.join(root, ".pi")));

  const read = { toolName: "read", input: { path: "a.ts" } };
  events.get("tool_call")!(read, ctx);
  assert.equal(read.input.path, "a.ts");
});
