import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const directories = process.argv.slice(2).map(path => resolve(path));
if (!directories.length) throw new Error('Pass result directories');
const rows = [];
for (const directory of directories) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    let row;
    try { row = JSON.parse(await readFile(join(path, 'result.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (row.arm === 'dream') {
      row.dreamEvents = (await readFile(join(path, 'dream.memory.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(event => event.event === 'dream');
    }
    rows.push(row);
  }
}
const unique = values => [...new Set(values)];
if (unique(rows.map(row => row.id)).length !== rows.length) throw new Error('Duplicate runs');
const hashes = unique(rows.map(row => row.fixtureHash));
if (hashes.length !== 1) throw new Error('Different frozen fixtures, or no completed runs');
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const sum = values => values.reduce((a, b) => a + b, 0);
const p95 = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? null;
const input = usage => (usage?.input ?? 0) + (usage?.cacheRead ?? 0);
const arms = {};
for (const arm of ['off', 'short', 'empty', 'long', 'dream', 'polluted']) {
  const group = rows.filter(row => row.arm === arm);
  if (!group.length) continue;
  const dreamEvents = group.flatMap(row => row.dreamEvents ?? []);
  arms[arm] = {
    jobs: group.length,
    completionRate: mean(group.map(row => Number(row.complete))),
    meanModelRequests: mean(group.map(row => row.modelRequests)),
    minModelRequests: Math.min(...group.map(row => row.modelRequests)),
    maxModelRequests: Math.max(...group.map(row => row.modelRequests)),
    meanToolCalls: mean(group.map(row => row.toolCalls)),
    meanInputTokens: mean(group.map(row => input(row.usage))),
    meanUncachedInputTokens: mean(group.map(row => row.usage.input ?? 0)),
    meanCachedInputTokens: mean(group.map(row => row.usage.cacheRead ?? 0)),
    meanOutputTokens: mean(group.map(row => row.usage.output ?? 0)),
    meanProviderCost: mean(group.map(row => row.usage.cost ?? 0)),
    meanWallMs: mean(group.map(row => row.wallMs)),
    p95WallMs: p95(group.map(row => row.wallMs)),
    failedCalls: sum(group.map(row => row.calls.filter(call => call.exitCode !== 0).length)),
    budgetExhaustedJobs: group.filter(row => row.budgetExhausted).length,
    timedOutJobs: group.filter(row => row.timedOut).length,
    actionBindingFailures: sum(group.map(row => (row.actionBindings ?? []).filter(binding => !binding.matched).length)),
    scopeLeaks: sum(group.map(row => row.scopeLeaks?.length ?? 0)),
    unknownMemoryIds: sum(group.map(row => row.unknownMemoryIds?.length ?? 0)),
    meanStoreBytes: mean(group.map(row => row.afterMemory.bytes)),
    meanActiveCanonicalBytes: mean(group.map(row => row.afterMemory.activeCanonicalBytes)),
    meanActiveRecords: mean(group.map(row => row.afterMemory.activeRecords)),
    parentChildCoinjections: sum(group.map(row => row.parentChildCoinjections?.length ?? 0)),
    maxInjectedTokens: Math.max(0, ...group.flatMap(row => row.recalls ?? []).map(event => event.tokens ?? 0)),
    ...(arm === 'dream' ? { dreaming: {
      completed: dreamEvents.filter(event => event.status === 'completed').length,
      skipped: dreamEvents.filter(event => event.status === 'skipped').length,
      failedInvocations: group.filter(row => row.dream.exitCode !== 0).length,
      parentsSaved: sum(dreamEvents.map(event => event.savedIds?.length ?? 0)),
      unreviewedHypotheses: sum(dreamEvents.map(event => event.hypotheses?.length ?? 0)),
      meanInputTokens: mean(dreamEvents.map(event => input(event.usage))),
      meanOutputTokens: mean(dreamEvents.map(event => event.usage?.output ?? 0)),
      meanWallMs: mean(group.map(row => row.dream.latencyMs)),
      meanActiveBytesChange: mean(group.map(row => row.beforeMemory.activeCanonicalBytes - row.beforeDreamMemory.activeCanonicalBytes)),
      meanTotalBytesChange: mean(group.map(row => row.beforeMemory.bytes - row.beforeDreamMemory.bytes)),
    } } : {}),
    stages: {},
  };
  for (const stage of [1, 2, 3]) {
    const scores = group.map(row => row.scores.find(score => score.stage === stage)).filter(Boolean);
    const calls = group.flatMap(row => row.calls.filter(call => call.name.startsWith(`stage-${stage}-`)));
    arms[arm].stages[stage] = {
      scoredJobs: scores.length,
      ...Object.fromEntries(['intrinsic', 'memory', 'action', 'control'].map(category => [category, mean(scores.map(score => score.categoryScores[category]).filter(value => value != null))])),
      complete: mean(scores.map(score => Number(score.complete))),
      failedCalls: calls.filter(call => call.exitCode !== 0).length,
      budgetExhaustedCalls: calls.filter(call => call.budgetExhausted).length,
      timedOutCalls: calls.filter(call => call.timedOut || call.skipped).length,
      modelRequests: sum(calls.map(call => call.modelRequests)),
      inputTokens: sum(calls.map(call => input(call.usage))),
      uncachedInputTokens: sum(calls.map(call => call.usage.input ?? 0)),
      cachedInputTokens: sum(calls.map(call => call.usage.cacheRead ?? 0)),
      outputTokens: sum(calls.map(call => call.usage.output ?? 0)),
    };
  }
}
const report = {
  fixtureHash: hashes[0],
  protocolHashes: unique(rows.map(row => row.protocolHash)),
  sourceHashes: unique(rows.filter(row => ['empty', 'long', 'dream', 'polluted'].includes(row.arm)).map(row => row.sourceHash)),
  directories,
  model: unique(rows.map(row => row.model)),
  completedJobs: rows.length,
  repairOnly: rows.every(row => row.repairOnlyFrom),
  arms,
};
await writeFile(join(directories.at(-1), 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
