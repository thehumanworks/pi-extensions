import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxProvider, fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import { delegateParameters, resolveWorkerConfig } from "../src/delegation.ts";

const [lead, other] = fauxProvider({
  provider: "test",
  models: [
    { id: "lead", reasoning: true },
    { id: "family/worker:v2", reasoning: true },
  ],
}).models;
const model = `${other.provider}/${other.id}`;
const task = "Review the requirements.";
const ctx = {
  model: lead,
  thinkingLevel: "low" as const,
  scopedModels: [{ model: other, thinkingLevel: "high" }] satisfies ScopedModel[],
};
const settings = {
  modelThinkingLevels: { [model]: "medium" as const },
  defaultThinkingLevel: "minimal" as const,
};

test("model overrides must match an exact scoped provider/id; task-only delegation needs no scope", () => {
  for (const ref of [other.id, "test/worker", model + ":low", "test/*", "test/lead", "unknown/worker"]) {
    assert.throws(
      () => resolveWorkerConfig({ task, model: ref }, ctx, {}),
      /exact scoped <provider>\/<model>/,
    );
  }
  const unscoped = { ...ctx, scopedModels: [] };
  assert.throws(
    () => resolveWorkerConfig({ task, model }, unscoped, {}),
    /Configure \/scoped-models or omit model/,
  );
  assert.throws(
    () => resolveWorkerConfig({ task }, { ...unscoped, model: undefined }, {}),
    /Select a Pi model/,
  );
  assert.deepEqual(resolveWorkerConfig({ task }, unscoped, settings), {
    provider: lead.provider,
    model: lead.id,
    reasoningEffort: "low",
    systemPrompt: undefined,
  });
});

test("effort precedence for explicit model: argument, scope pin, per-model, global, then lead", () => {
  const args = { task, model };
  const unpinned = { ...ctx, scopedModels: [{ model: other }] };
  assert.deepEqual(resolveWorkerConfig({ ...args, reasoningEffort: "off" }, ctx, settings), {
    provider: other.provider,
    model: other.id,
    reasoningEffort: "off",
    systemPrompt: undefined,
  });
  assert.equal(resolveWorkerConfig(args, ctx, settings).reasoningEffort, "high");
  assert.equal(resolveWorkerConfig(args, unpinned, settings).reasoningEffort, "medium");
  assert.equal(
    resolveWorkerConfig(args, unpinned, { defaultThinkingLevel: "minimal" }).reasoningEffort,
    "minimal",
  );
  assert.equal(resolveWorkerConfig(args, unpinned, {}).reasoningEffort, "low");
  assert.equal(
    resolveWorkerConfig({ task }, { ...ctx, thinkingLevel: undefined }, settings).reasoningEffort,
    "minimal",
  );
});

test("prompt and effort can each override the lead independently; Pi clamps unsupported effort", () => {
  const prompt = "Answer in Spanish.";
  const promptOnly = resolveWorkerConfig({ task, systemPrompt: prompt }, ctx, settings);
  assert.equal(promptOnly.model, lead.id);
  assert.equal(promptOnly.reasoningEffort, ctx.thinkingLevel);
  assert.equal(promptOnly.systemPrompt, prompt);
  const effortOnly = resolveWorkerConfig({ task, reasoningEffort: "high" }, ctx, settings);
  assert.equal(effortOnly.model, lead.id);
  assert.equal(effortOnly.reasoningEffort, "high");
  assert.equal(effortOnly.systemPrompt, undefined);
  const noThinking = { ...ctx, model: { ...lead, reasoning: false } };
  assert.equal(resolveWorkerConfig({ task, reasoningEffort: "high" }, noThinking, {}).reasoningEffort, "off");
});

test("Pi's tool validation rejects invalid effort and blank prompts before dispatch", () => {
  const tool = { name: "subagent_delegate", description: "", parameters: delegateParameters };
  for (const [field, value] of [
    ["reasoningEffort", "extreme"],
    ["systemPrompt", ""],
    ["systemPrompt", "  \n "],
  ]) {
    assert.throws(() => validateToolArguments(tool, fauxToolCall(tool.name, { task, [field]: value })));
  }
  for (const reasoningEffort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.doesNotThrow(() =>
      validateToolArguments(tool, fauxToolCall(tool.name, { task, reasoningEffort })),
    );
  }
});
