import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defaultSessionDir, describeSession, findSession, freshSessionFile, listSessions, sessionFileForId } from "../src/sessions.ts";
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
