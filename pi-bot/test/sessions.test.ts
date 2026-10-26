import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defaultSessionDir, describeSession, findSession, freshSessionFile, listSessions, sessionFileForId, storeSessionIn } from "../src/sessions.ts";
import { tempRoot } from "./helpers.ts";

function saveSession(dir: string, cwd: string, text: string): SessionManager {
  const manager = SessionManager.create(cwd, dir);
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  return manager;
}

test("a fresh session in the launch directory is left for Pi to write on the first message", async t => {
  const dir = join(await tempRoot(t), "a", "sessions");
  const path = await freshSessionFile(dir, process.cwd());
  assert.equal(dirname(path), dir);
  assert.match(basename(path), /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]{36}\.jsonl$/);
  assert.ok(!existsSync(path));
  assert.equal(SessionManager.open(path).getCwd(), process.cwd());
});

test("a fresh session for another directory gets a header recording that directory", async t => {
  const root = await tempRoot(t);
  const dir = join(root, "a", "sessions");
  const path = await freshSessionFile(dir, root);
  const header = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(header.type, "session");
  assert.equal(header.cwd, root);
  assert.ok(basename(path).endsWith(`_${header.id}.jsonl`));
  const opened = SessionManager.open(path);
  assert.equal(opened.getCwd(), root);
  assert.equal(opened.getSessionId(), header.id);
});

test("listing, lookup by id prefix and by JSON header id", async t => {
  const root = await tempRoot(t);
  const dir = join(root, "a", "sessions");
  const first = saveSession(dir, root, "first task");
  await new Promise(resolve => setTimeout(resolve, 15));
  const second = saveSession(dir, process.cwd(), "second task");
  const sessions = await listSessions(dir);
  assert.deepEqual(sessions.map(s => s.id), [second.getSessionId(), first.getSessionId()]);
  assert.equal(findSession(sessions, first.getSessionId())?.path, first.getSessionFile());
  assert.equal(findSession(sessions, second.getSessionFile()!)?.id, second.getSessionId());
  assert.equal(findSession(sessions, first.getSessionId().slice(0, -4))?.path, first.getSessionFile());
  // UUIDv7 ids created moments apart share a prefix; an ambiguous prefix matches nothing.
  assert.equal(findSession(sessions, first.getSessionId().slice(0, 4)), undefined);
  assert.equal(findSession(sessions, "zzz"), undefined);
  assert.equal(await sessionFileForId(dir, first.getSessionId()), first.getSessionFile());
  assert.equal(await sessionFileForId(join(root, "missing"), "x"), undefined);
  assert.match(describeSession(sessions[1]!), new RegExp(`· ${root} · first task$`));
});

test("redirecting storage preserves the entire tree, setup entries, identity and active leaf", async t => {
  const root = await tempRoot(t);
  const sessions = SessionManager.create(root, join(root, "ordinary"));
  sessions.appendModelChange("provider", "model");
  sessions.appendThinkingLevelChange("high");
  sessions.appendSessionInfo("A named review");
  const selected = sessions.appendMessage({ role: "user", content: "first branch", timestamp: Date.now() });
  sessions.appendMessage({ role: "user", content: "abandoned branch", timestamp: Date.now() });
  sessions.branch(selected);
  const original = sessions.getSessionFile()!;
  const originalText = readFileSync(original, "utf8");
  const header = JSON.parse(JSON.stringify(sessions.getHeader()));
  const entries = sessions.getEntries();
  const dir = join(root, "reviewer", "sessions");

  await storeSessionIn(sessions, dir);
  assert.equal(sessions.getSessionDir(), dir);
  assert.equal(sessions.usesDefaultSessionDir(), false);
  assert.deepEqual(sessions.getHeader(), header);
  assert.deepEqual(sessions.getEntries(), entries);
  assert.equal(sessions.getLeafId(), selected);
  assert.equal(sessions.getCwd(), root);
  assert.equal(sessions.getSessionName(), "A named review");
  assert.equal(await sessionFileForId(dir, sessions.getSessionId()), sessions.getSessionFile());
  sessions.appendMessage({ role: "user", content: "continued in bot home", timestamp: Date.now() });
  assert.match(readFileSync(sessions.getSessionFile()!, "utf8"), /continued in bot home/);
  assert.equal(readFileSync(original, "utf8"), originalText);
  assert.equal(sessions.getBranch().some(e => e.type === "message" && e.message.role === "user" && e.message.content === "abandoned branch"), false);

  const path = sessions.getSessionFile();
  await storeSessionIn(sessions, dir);
  assert.equal(sessions.getSessionFile(), path);
  assert.equal((await readdir(dir)).length, 1);
  const fork = sessions.createBranchedSession(selected)!;
  assert.equal(dirname(fork), dir);
  assert.equal(dirname(sessions.newSession()!), dir);
});

test("redirecting storage preserves a reset leaf", async t => {
  const root = await tempRoot(t);
  const sessions = saveSession(join(root, "ordinary"), root, "old root");
  sessions.resetLeaf();
  await storeSessionIn(sessions, join(root, "reviewer", "sessions"));
  assert.equal(sessions.getLeafId(), null);
  assert.deepEqual(sessions.getBranch(), []);
});

test("a bot-home file overrides a conflicting session directory without copying history", async t => {
  const root = await tempRoot(t);
  const dir = join(root, "reviewer", "sessions");
  const saved = saveSession(dir, root, "existing conversation");
  const file = saved.getSessionFile()!;
  const sessions = SessionManager.open(file, join(root, "elsewhere"));
  await storeSessionIn(sessions, dir);
  assert.equal(sessions.getSessionFile(), file);
  assert.equal(sessions.getSessionDir(), dir);
  assert.equal(sessions.usesDefaultSessionDir(), false);
  assert.equal((await readdir(dir)).length, 1);
  assert.equal(dirname(sessions.newSession()!), dir);
});

test("redirecting storage recognizes symlinked homes", async t => {
  const root = await tempRoot(t);
  const dir = join(root, "reviewer", "sessions");
  const sessions = saveSession(dir, root, "existing conversation");
  const link = join(root, "linked-home");
  await symlink(join(root, "reviewer"), link, "dir");
  const original = sessions.getSessionFile();
  await storeSessionIn(sessions, join(link, "sessions"));
  assert.equal(sessions.getSessionFile(), original);
  assert.equal((await readdir(dir)).length, 1);
});

test("redirecting storage never overwrites an existing destination", async t => {
  const root = await tempRoot(t);
  const sessions = saveSession(join(root, "ordinary"), root, "original conversation");
  const file = sessions.getSessionFile()!;
  const original = readFileSync(file, "utf8");
  const dir = join(root, "reviewer", "sessions");
  await freshSessionFile(dir, process.cwd());
  const target = join(dir, basename(file));
  await writeFile(target, "precious history");
  await assert.rejects(storeSessionIn(sessions, dir), { code: "EEXIST" });
  assert.equal(sessions.getSessionFile(), file);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readFileSync(target, "utf8"), "precious history");
});

test("explicit in-memory bot sessions remain ephemeral", async t => {
  const root = await tempRoot(t);
  const sessions = SessionManager.inMemory(root);
  const dir = join(root, "reviewer", "sessions");
  await storeSessionIn(sessions, dir);
  sessions.appendMessage({ role: "user", content: "ephemeral", timestamp: Date.now() });
  assert.equal(sessions.getSessionFile(), undefined);
  assert.equal(sessions.isPersisted(), false);
  assert.equal(existsSync(dir), false);
});

test("defaultSessionDir matches Pi's per-project layout and honors overrides", async t => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bot-agent-"));
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, session: process.env.PI_CODING_AGENT_SESSION_DIR };
  t.after(async () => {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["PI_CODING_AGENT_SESSION_DIR", saved.session]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(agentDir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const cwd = "/Users/someone/my project";
  assert.equal(defaultSessionDir(cwd, agentDir), SessionManager.create(cwd).getSessionDir());
  assert.equal(defaultSessionDir(cwd, agentDir, "/custom/sessions"), "/custom/sessions");
  process.env.PI_CODING_AGENT_SESSION_DIR = "/env/sessions";
  assert.equal(defaultSessionDir(cwd, agentDir, "/custom/sessions"), "/env/sessions");
});
