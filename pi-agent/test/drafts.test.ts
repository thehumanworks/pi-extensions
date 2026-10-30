import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { DraftWorkflow, draftPreview, type DraftHost } from "../src/drafts.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { registerDraftTools } from "../src/draft-tools.ts";
import { definition, fixture, scripted } from "./helpers.ts";

const host = (confirmEvaluation: DraftHost["confirmEvaluation"] = async () => false): DraftHost => ({ changed: () => {}, confirmEvaluation });

test("creation stays outside the roster through iteration and saves only an accepted exact revision", async t => {
  const f = await fixture(t);
  const runtime = new AgentRuntime(f.store);
  const changes: (string | undefined)[] = [];
  const drafts = new DraftWorkflow(f.store, runtime, { ...host(), changed: id => changes.push(id) });
  const first = await drafts.start("Review security changes");
  assert.equal(first.source, undefined);
  const v1 = await drafts.propose(definition("reviewer", "", "First persona"));
  assert.equal((await f.store.list()).agents.length, 0);
  await assert.rejects(f.store.ensure("reviewer"), /Unknown agent/);
  const v2 = await drafts.propose(definition("reviewer", "", "Better persona"));
  await assert.rejects(drafts.accept(first.id, v1.revision!), /changed/);
  assert.equal(await drafts.accept(first.id, v2.revision!), "reviewer");
  assert.equal((await f.store.ensure("reviewer")).prompt, "Better persona");
  assert.equal(await f.store.source("reviewer"), v2.source);
  assert.equal(await drafts.current(), undefined);
  assert.deepEqual(changes, [first.id, undefined]);
});

test("workflow restores without regenerating or running anything; rejection never creates an agent", async t => {
  const f = await fixture(t);
  const runtime = new AgentRuntime(f.store);
  const original = new DraftWorkflow(f.store, runtime, host());
  const draft = await original.start("Review code", "reviewer", "mentor");
  await assert.rejects(original.propose(definition("reviewer")), /another active agent/);
  await original.propose(definition("reviewer"), "mentor");
  const reopened = new DraftWorkflow(f.store, runtime, host());
  await reopened.restore(draft.id);
  assert.equal((await reopened.current())!.author, "mentor");
  const snapshot = (await reopened.current())!;
  await reopened.reject(snapshot.id, snapshot.revision);
  assert.equal(await reopened.current(), undefined);
  assert.equal((await f.store.list()).agents.length, 0);
  assert.match(await readFile(join(f.store.root, ".drafts", draft.id, "draft.json"), "utf8"), /rejected/);
  await assert.rejects(original.propose(definition("reviewer"), "mentor"), /closed/);
});

test("proposal validation rejects incomplete, conflicting and unsupported definitions", async t => {
  const f = await fixture(t);
  const drafts = new DraftWorkflow(f.store, new AgentRuntime(f.store), host());
  await drafts.start("Review", "reviewer");
  await assert.rejects(drafts.propose(definition("other")), /user-specified name/);
  await assert.rejects(drafts.propose("---\ndescription: Missing name\n---\nprompt"), /explicit name/);
  await assert.rejects(drafts.propose(definition("reviewer", "permissionMode: plan")), /Unsupported/);
  await f.store.create("reviewer", definition("reviewer"));
  await assert.rejects(drafts.propose(definition("reviewer")), /already exists/);
});

test("concurrent creation requests cannot replace an in-progress draft", async t => {
  const f = await fixture(t);
  const drafts = new DraftWorkflow(f.store, new AgentRuntime(f.store), host());
  const [a, b] = await Promise.allSettled([drafts.start("first"), drafts.start("second")]);
  assert.equal(a.status, "fulfilled"); assert.equal(b.status, "rejected");
  assert.equal((await drafts.current())!.purpose, "first");
});

test("evaluation requires approval and rejects revisions changed during the dialog", async t => {
  const f = await fixture(t);
  const runtime = new AgentRuntime(f.store);
  let runs = 0;
  t.mock.method(runtime, "evaluate", async () => { runs++; throw new Error("must not run"); });
  const denied = new DraftWorkflow(f.store, runtime, host());
  await denied.start("Review");
  const draft = await denied.propose(definition());
  await assert.rejects(denied.evaluate(draft.revision!, "test", "correct answer"), /not approved/);
  assert.equal(runs, 0);
  let approved!: (yes: boolean) => void;
  const drafts = new DraftWorkflow(f.store, runtime, host(async () => new Promise(r => { approved = r; })));
  await drafts.restore(draft.id);
  const pending = drafts.evaluate(draft.revision!, "test", "correct answer");
  const rejected = assert.rejects(pending, /changed/);
  while (!approved) await new Promise(r => setImmediate(r));
  await drafts.propose(definition("tester", "", "new revision"));
  approved(true);
  await rejected;
  assert.equal(runs, 0);
  assert.equal((await drafts.current())!.evaluations.length, 0);
});

test("real evals use the candidate prompt and fresh SDK history/home without installing it", async t => {
  const f = await fixture(t);
  const { models } = await scripted(f.agentDir, [
    ctx => { assert.match(JSON.stringify(ctx), /Trial specialist/); return answer(call("write", { path: "memory.md", content: "trial memory" }), { stopReason: "toolUse" }); },
    answer("trial one"),
    ctx => { assert.doesNotMatch(JSON.stringify(ctx.messages), /trial one/); return answer("trial two"); },
  ]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true, mcp: false });
  const drafts = new DraftWorkflow(f.store, runtime, host(async () => true));
  t.after(async () => { await drafts.close(); await runtime.close(); });
  await drafts.start("Pass realistic tests");
  const v1 = await drafts.propose(definition("tester", "", "Trial specialist"));
  const first = await drafts.evaluate(v1.revision!, "write a note", "writes a useful note");
  const second = await drafts.evaluate(v1.revision!, "fresh test", "does not rely on previous trial memory");
  assert.equal(first.status, "completed"); assert.equal(second.status, "completed");
  assert.notEqual(first.result!.sessionId, second.result!.sessionId);
  assert.notEqual(first.result!.home, second.result!.home);
  assert.equal(await readFile(join(first.result!.home, "memory.md"), "utf8"), "trial memory");
  assert.equal((await f.store.list()).agents.length, 0);
  await assert.rejects(stat(join(f.store.homes, "tester")), { code: "ENOENT" });
  const v2 = await drafts.propose(definition("tester", "", "Improved specialist"));
  assert.match(draftPreview(v2), /older — not evidence for current revision/);
  assert.equal(v2.evaluations.every(e => e.revision === v1.revision), true);
  await drafts.accept(v2.id, v2.revision!);
  await assert.rejects(stat(join(f.store.homes, "tester", "memory.md")), { code: "ENOENT" });
  assert.equal((await f.store.ensure("tester")).prompt, "Improved specialist");
});

test("shutdown cancels pending evaluation approval without executing it", async t => {
  const f = await fixture(t);
  const runtime = new AgentRuntime(f.store);
  let asked!: () => void;
  const ready = new Promise<void>(r => { asked = r; });
  const drafts = new DraftWorkflow(f.store, runtime, host(async (_d, _task, _criteria, signal) => {
    asked();
    return new Promise(r => signal.addEventListener("abort", () => r(false), { once: true }));
  }));
  await drafts.start("test"); const draft = await drafts.propose(definition());
  const pending = assert.rejects(drafts.evaluate(draft.revision!, "task", "criteria"), /not approved|stopped/);
  await ready;
  await drafts.close(); await pending;
  assert.equal((await drafts.current())!.evaluations.length, 0);
  await assert.rejects(drafts.accept(draft.id, draft.revision!), /closed/);
});

test("selected specialist can author a proposal in its existing native conversation", async t => {
  const f = await fixture(t);
  await f.store.create("mentor", definition("mentor"));
  const proposed = definition("reviewer", "", "Generated by mentor");
  const { models } = await scripted(f.agentDir, [
    answer("I know this project"),
    ctx => { assert.match(JSON.stringify(ctx.messages), /I know this project/); return answer(call("agent_draft", { action: "propose", definition: proposed }), { stopReason: "toolUse" }); },
    answer("Here is the proposal; shall we iterate or evaluate?"),
  ]);
  let drafts: DraftWorkflow;
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true, mcp: false, extension: (name, _chain, run) => pi => { if (run.drafting) registerDraftTools(pi, drafts, name); } });
  drafts = new DraftWorkflow(f.store, runtime, host());
  t.after(async () => { await drafts.close(); await runtime.close(); });
  const first = await runtime.run("mentor", "Remember our project");
  await drafts.start("Review this project", undefined, "mentor");
  const next = await runtime.run("mentor", "Please propose the agent", { drafting: true });
  assert.equal(next.sessionId, first.sessionId);
  assert.match((await drafts.current())!.source!, /Generated by mentor/);
  assert.deepEqual((await f.store.list()).agents.map(a => a.name), ["mentor"]);
});

test("a second workflow instance cannot accept, reject or evaluate while a trial lease is live", async t => {
  const f = await fixture(t);
  const runtime = new AgentRuntime(f.store);
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { release = r; });
  t.mock.method(runtime, "evaluate", async () => { started(); await gate; throw new Error("trial failed criterion"); });
  const first = new DraftWorkflow(f.store, runtime, host(async () => true));
  await first.start("Test behavior");
  const draft = await first.propose(definition());
  const trial = first.evaluate(draft.revision!, "trial", "specific criterion");
  await ready;
  const second = new DraftWorkflow(f.store, runtime, host(async () => true));
  await second.restore(draft.id);
  const locked = (e: NodeJS.ErrnoException) => e.code === "ELOCKED";
  await assert.rejects(second.accept(draft.id, draft.revision!), locked);
  await assert.rejects(second.reject(draft.id, draft.revision), locked);
  await assert.rejects(second.evaluate(draft.revision!, "another trial", "criterion"), locked);
  assert.equal((await f.store.list()).agents.length, 0);
  release();
  assert.equal((await trial).status, "failed");
  // No automatic pass gate: after the trial settles, a human may explicitly accept with known failures.
  assert.equal(await second.accept(draft.id, draft.revision!), "tester");
});

test("trial built-in writes cannot bypass acceptance by writing into the production registry", async t => {
  const f = await fixture(t);
  await f.store.create("existing", definition("existing"));
  const source = await f.store.source("existing");
  const { models } = await scripted(f.agentDir, [
    answer(call("write", { path: f.store.file("existing"), content: "bad" }), { stopReason: "toolUse" }),
    ctx => { assert.match(JSON.stringify(ctx.messages), /Registry files are managed by agent_manage/); return answer("blocked"); },
  ]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true, mcp: false });
  t.after(() => runtime.close());
  const result = await runtime.evaluate(definition("candidate"), "Try writing the registry", join(f.store.root, ".drafts", "trial-guard"));
  assert.equal(result.output, "blocked");
  assert.equal(await readFile(f.store.file("existing"), "utf8"), source);
});

test("stopping a running evaluation reaches SDK tools and preserves failed evidence without acceptance", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const { models } = await scripted(f.agentDir, [answer(call("bash", { command: "sleep 30" }), { stopReason: "toolUse" })]);
  const runtime = new AgentRuntime(f.store, { createModels: async () => models, noExtensions: true, mcp: false });
  const drafts = new DraftWorkflow(f.store, runtime, host(async () => true));
  t.after(async () => { await drafts.close(); await runtime.close(); });
  await drafts.start("Test cancellation");
  const draft = await drafts.propose(definition());
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const trial = drafts.evaluate(draft.revision!, "Do a slow task", "Finish successfully", undefined, undefined, event => { if (event.type === "tool_execution_start") started(); });
  await ready;
  await new Promise(r => setTimeout(r, 50));
  drafts.stop();
  const result = await trial;
  assert.equal(result.status, "failed");
  assert.equal((await drafts.current())!.evaluations[0].status, "failed");
  assert.equal((await f.store.list()).agents.length, 0);
});
