import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentStore } from "../src/store.ts";
import { withLock } from "../src/storage.ts";
import { definition, fixture } from "./helpers.ts";

test("create/list/show and import Claude/Cursor without mutating original files", async t => {
  const { store, cwd } = await fixture(t);
  const dir = join(cwd, ".claude/agents");
  await mkdir(dir, { recursive: true });
  const raw = definition("reviewer", "model: inherit\ncolor: green");
  await writeFile(join(dir, "reviewer.md"), raw);
  assert.equal((await store.list(cwd)).agents[0].name, "reviewer");
  const imported = await store.ensure("reviewer", cwd);
  assert.equal(imported.home, join(store.homes, "reviewer"));
  assert.equal(await readFile(join(dir, "reviewer.md"), "utf8"), raw);
  assert.match(await store.source("reviewer"), /color: green/);
  assert.match(await store.source("reviewer"), /home:/);
  const other = new AgentStore(store.root, store.agentDir);
  assert.equal((await other.ensure("reviewer")).prompt, imported.prompt);
  await assert.rejects(store.create("reviewer", raw), /exists/);
});

test("proposals are not live; approval is exact-revision CAS and home cannot change", async t => {
  const { store } = await fixture(t);
  await store.create("tester", definition());
  const base = await store.source("tester");
  const first = await store.propose("tester", base.replace("Test specialist persona.", "First proposed persona."));
  assert.equal((await store.ensure("tester")).prompt, "Test specialist persona.");
  const second = await store.propose("tester", base.replace("Test specialist persona.", "Second proposed persona."));
  await assert.rejects(store.approve("tester", first.revision), /changed/);
  await store.approve("tester", second.revision);
  assert.equal((await store.ensure("tester")).prompt, "Second proposed persona.");
  assert.equal(await store.candidate("tester"), undefined);
  await assert.rejects(store.propose("tester", definition("tester", "home: /other")), /immutable/);
  await assert.rejects(store.propose("tester", definition("other")), /Renaming/);
});

test("external prompt edits stay inert, can be rejected or explicitly approved", async t => {
  const { store } = await fixture(t);
  await store.create("tester", definition());
  const base = await store.source("tester");
  await writeFile(store.file("tester"), base.replace("Test specialist persona.", "external edit"));
  assert.equal((await store.ensure("tester")).prompt, "Test specialist persona.");
  const candidate = (await store.candidate("tester"))!;
  await store.reject("tester", candidate.revision);
  assert.equal(await readFile(store.file("tester"), "utf8"), base);
  await writeFile(store.file("tester"), base.replace("Test specialist persona.", "approved external"));
  await store.approve("tester", (await store.candidate("tester"))!.revision);
  assert.equal((await store.ensure("tester")).prompt, "approved external");
});

test("archiving refuses active agents, keeps home intact, and prevents accidental resurrection", async t => {
  const { store } = await fixture(t);
  const def = await store.create("tester", definition());
  await mkdir(def.home, { recursive: true });
  await writeFile(join(def.home, "notes.md"), "memory");
  await withLock(store.root, "run:tester", async () => {
    await assert.rejects(store.archive("tester"), (e: NodeJS.ErrnoException) => e.code === "ELOCKED");
  });
  const archive = await store.archive("tester");
  assert.equal(await readFile(join(def.home, "notes.md"), "utf8"), "memory");
  assert.match(await readFile(join(archive, "tester.md"), "utf8"), /Test specialist/);
  assert.equal((await store.list()).agents.length, 0);
  await assert.rejects(store.ensure("tester"), /deleted/);
  await assert.rejects(store.create("tester", definition()), /archived/);
});

test("discovery precedence, malformed files and ancestor project definitions", async t => {
  const { store, cwd } = await fixture(t);
  await store.create("tester", definition());
  await mkdir(join(cwd, ".cursor/agents"), { recursive: true });
  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, ".cursor/agents/tester.md"), definition("tester", "", "shadow"));
  await writeFile(join(cwd, ".cursor/agents/bad.md"), "invalid");
  const list = await store.list(join(cwd, "src"));
  assert.equal(list.agents.find(a => a.name === "tester")!.file, store.file("tester"));
  assert.match(list.diagnostics.join("\n"), /Shadowed/);
  assert.match(list.diagnostics.join("\n"), /Expected Markdown/);
  await assert.rejects(store.ensure("missing"), /Unknown agent/);
});
