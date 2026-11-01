import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rerank } from "../src/selector.ts";
import type { MemoryItem } from "../src/types.ts";

type Classify = (model: unknown, context: ClassifierContext, options: { signal: AbortSignal; maxRetries: number }) => Promise<unknown>;

const classifier = { id: "gpt-6-luna", provider: "openai" };
const selection = "openai/gpt-6-luna";
const memory = (id: string, body = `Body of ${id}.`) => ({ id, title: `Title ${id}`, summary: `Summary ${id}`, body, type: "project", scope: "project:key", triggers: ["t"], paths: ["src/a.ts"], updated: "2026-10-01T00:00:00.000Z" }) as unknown as MemoryItem;
const scored = (scores: Record<string, number>) => ({ stopReason: "stop", answers: Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, { type: "score", score, confidence: 1 }])) });

async function directory(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-memory-extract-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function context(cwd: string, classify: Classify, available: unknown[] = [classifier], chat?: unknown) {
  return { cwd, modelRegistry: { getAvailableOfType: async () => available, classify, ...chat as object } } as unknown as ExtensionContext;
}

test("the classifier keeps memories above the threshold, best first", async t => {
  const ctx = context(await directory(t), async () => scored({ low: 0.4, border: 1.5, tangential: 1.49, best: 2.9 }));
  const kept = await rerank([memory("low"), memory("border"), memory("tangential"), memory("best")], "request", selection, 1000, ctx);
  assert.deepEqual(kept.map(item => item.id), ["best", "border"]);
});

test("the classifier judges the request against the codebase, and receives no secrets", async t => {
  const cwd = await directory(t);
  execFileSync("git", ["init", "-q", "-b", "feature/recall", cwd]);
  await writeFile(join(cwd, "changed.ts"), "");
  let request: ClassifierContext | undefined, retries: number | undefined;
  const ctx = context(cwd, async (_model, input, options) => { request = input; retries = options.maxRetries; return scored({ a: 2, b: 2 }); });
  const files = [{ path: "/global/AGENTS.md", content: "global" }, ...[1, 2, 3].map(n => ({ path: `/repo/${n}/AGENTS.md`, content: `context ${n} password=hunter2` }))];
  await rerank([memory("a", "Deploy with key sk-abcdefghijklmnopqrstuvwxyz."), memory("b", "x".repeat(5000))], "fix token=abc123", selection, 2000, ctx, files);

  const state = request!.state as { codebase: { project: string; branch: string; changedPaths: string[]; instructions: { path: string; excerpt: string }[] }; request: string };
  assert.equal(state.codebase.project, basename(cwd));
  assert.equal(state.codebase.branch, "feature/recall");
  assert.deepEqual(state.codebase.changedPaths, ["changed.ts"]);
  assert.deepEqual(state.codebase.instructions.map(file => file.path), ["/repo/1/AGENTS.md", "/repo/2/AGENTS.md", "/repo/3/AGENTS.md"], "The nearest context files are sent");
  assert.deepEqual(Object.keys(state), ["codebase", "request"], "The stable fields lead the shared prefix");

  const questions = request!.questions;
  assert.deepEqual(Object.keys(questions), ["a", "b"]);
  assert.equal(questions.a!.type, "score");
  assert.match(questions.a!.instructions, /Title a/);
  assert.doesNotMatch(questions.a!.instructions, /Title b/, "One memory cannot sway another's score");
  assert.ok(questions.b!.instructions.length < 4500, "A long body is cut");
  assert.equal(retries, 0, "A retry could exceed the recall deadline");
  const sent = JSON.stringify(request);
  for (const secret of ["sk-abcdefghijklmnopqrstuvwxyz", "hunter2", "abc123"]) assert.ok(!sent.includes(secret), `${secret} left the machine`);
});

test("any classifier failure keeps every candidate", async t => {
  const cwd = await directory(t), items = [memory("a"), memory("b")];
  const failed = context(cwd, async () => ({ stopReason: "error", errorMessage: "503", answers: {} }));
  assert.deepEqual(await rerank(items, "request", selection, 1000, failed), items);
});

test("a refused memory fails only itself: the rest are still judged, and it stays", async t => {
  const ctx = context(await directory(t), async (_model, input) => "refused" in input.questions
    ? { stopReason: "error", errorMessage: "System One API refused to answer refused", answers: {} }
    : scored({ best: 2.9, low: 0.4 }));
  const kept = await rerank([memory("low"), memory("refused"), memory("best")], "request", selection, 1000, ctx);
  assert.deepEqual(kept.map(item => item.id), ["best", "refused"]);
});

test("a deadline while asking one memory at a time keeps only the memories it cut off", async t => {
  const ctx = context(await directory(t), (_model, input, { signal }) => {
    if (Object.keys(input.questions).length > 1) return Promise.resolve({ stopReason: "error", errorMessage: "System One API did not return a score answer for low", answers: {} });
    if ("low" in input.questions) return Promise.resolve(scored({ low: 0.4 }));
    return new Promise(resolve => signal.addEventListener("abort", () => resolve({ stopReason: "aborted", answers: {} })));
  });
  assert.deepEqual((await rerank([memory("low"), memory("slow")], "request", selection, 100, ctx)).map(item => item.id), ["slow"]);
});

test("the classifier stops at the recall deadline", async t => {
  const items = [memory("a")], started = Date.now();
  const ctx = context(await directory(t), (_model, _input, { signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ stopReason: "aborted", answers: {} }))));
  assert.deepEqual(await rerank(items, "request", selection, 100, ctx), items);
  assert.ok(Date.now() - started < 1000);
});

test("without an available classifier, the selection runs as a chat model", async t => {
  const chat = { id: "gpt-6-luna" }, used: unknown[] = [];
  const registry = {
    find: () => chat, hasConfiguredAuth: () => true,
    streamSimple: (model: unknown) => { used.push(model); return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"ids":["b"]}' }] }) }; },
  };
  const ctx = context(await directory(t), async () => assert.fail("The classifier is hidden from this credential"), [], registry);
  assert.deepEqual((await rerank([memory("a"), memory("b")], "request", selection, 1000, ctx)).map(item => item.id), ["b"]);
  assert.deepEqual(used, [chat]);
});

test("a chat model that shares a provider with a classifier is not treated as one", async t => {
  const ctx = context(await directory(t), async () => assert.fail("Only the chat model was selected"), [{ id: "other", provider: "openai" }], { find: () => undefined });
  const items = [memory("a")];
  assert.deepEqual(await rerank(items, "request", selection, 1000, ctx), items);
});
