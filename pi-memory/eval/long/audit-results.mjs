import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseMemory, evidenceHash } from '../../src/store.ts';
import { resolveProjectKey } from '../../src/project.ts';

const repairOnly = process.argv.includes('--repair-only');
const directories = process.argv.slice(2).filter(arg => arg !== '--repair-only').map(path => resolve(path));
if (!directories.length) throw new Error('Pass result directories [--repair-only]');
const rows = [], errors = [], provenance = [];
async function canonical(directory) {
  const items = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) items.push(...await canonical(path));
      else if (/^m_.*\.md$/.test(entry.name)) items.push(parseMemory(await readFile(path, 'utf8')));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return items;
}
for (const directory of directories) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.arms.some(arm => ['empty', 'long', 'dream', 'polluted'].includes(arm))) {
    for (const [file, hash] of Object.entries(manifest.sourceHashes)) {
      const observed = createHash('sha256').update(await readFile(join(directory, 'source-snapshot', file))).digest('hex');
      if (observed !== hash) errors.push(`Source snapshot mismatch: ${file}`);
    }
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    let row;
    try { row = JSON.parse(await readFile(join(path, 'result.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    rows.push(row);
    if (row.fixtureHash !== manifest.fixtureHash || row.protocolHash !== manifest.protocolHash || row.sourceHash !== manifest.sourceHash) errors.push(`${row.id}: manifest mismatch`);
    for (const stage of repairOnly ? [3] : [1, 2, 3]) {
      const score = JSON.parse(await readFile(join(path, `stage-${stage}.checks.json`), 'utf8'));
      if (!isDeepStrictEqual(score, row.scores.find(value => value.stage === stage))) errors.push(`${row.id}: stage ${stage} score mismatch`);
    }
    let items = await canonical(join(dirname(row.cwd), 'memory'));
    if (!items.length && row.recalls.some(event => event.ids?.length)) items = JSON.parse(await readFile(join(path, 'selected-evidence.json'), 'utf8')).items;
    const byId = new Map(items.map(item => [item.id, item]));
    const expectedScope = `project:${resolveProjectKey(row.cwd)}`;
    const selected = [...new Set(row.recalls.flatMap(event => event.ids ?? []))];
    const sourceIds = new Set();
    function visit(id, scope, seen = new Set()) {
      if (seen.has(id)) { errors.push(`${row.id}: cyclic derivation ${id}`); return; }
      const item = byId.get(id);
      if (!item) { errors.push(`${row.id}: unresolved selected/source ID ${id}`); return; }
      if (item.scope !== scope && item.scope !== 'global') errors.push(`${row.id}: wrong scope ${id} ${item.scope}`);
      if (item.status !== 'active') errors.push(`${row.id}: selected inactive evidence ${id}`);
      for (const reference of item.derivedFrom ?? []) {
        sourceIds.add(reference.id);
        const source = byId.get(reference.id);
        if (!source || source.scope !== item.scope || evidenceHash(source) !== reference.hash) errors.push(`${row.id}: invalid source hash/scope ${reference.id}`);
        visit(reference.id, item.scope, new Set([...seen, id]));
      }
    }
    selected.forEach(id => visit(id, expectedScope));
    const dreamEvents = row.arm === 'dream' ? (await readFile(join(path, 'dream.memory.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(event => event.event === 'dream') : [];
    const dreamSourceIds = [...new Set(dreamEvents.flatMap(event => [...(event.sourceIds ?? []), ...(event.hypotheses ?? []).flatMap(hypothesis => hypothesis.sourceIds ?? [])]))];
    dreamSourceIds.forEach(id => visit(id, expectedScope));
    await writeFile(join(path, 'selected-evidence.json'), `${JSON.stringify({ expectedScope, items: [...new Set([...selected, ...sourceIds, ...dreamSourceIds])].map(id => byId.get(id)).filter(Boolean) }, null, 2)}\n`);
    provenance.push({ id: row.id, expectedScope, selectedIds: selected, derivedSourceIds: [...sourceIds], dreamSourceIds, unresolvedOrWrongScope: errors.filter(error => error.startsWith(`${row.id}:`) && /ID|scope|hash/.test(error)) });
  }
}
const ids = rows.map(row => row.id), expected = [];
for (const project of ['ingestion', 'migration']) for (let repeat = 0; repeat < (repairOnly ? 1 : 2); repeat++) {
  for (const arm of repairOnly ? ['long', 'polluted'] : ['off', 'short', 'empty', 'long', 'dream']) {
    if (!repairOnly && arm === 'empty' && repeat === 1) continue;
    expected.push(`${project}-${arm}-${repeat}`);
  }
}
if (new Set(ids).size !== ids.length) errors.push('Duplicate job IDs');
for (const id of expected) if (!ids.includes(id)) errors.push(`Missing job ${id}`);
for (const id of ids) if (!expected.includes(id)) errors.push(`Unexpected job ${id}`);
const unique = values => [...new Set(values)];
if (unique(rows.map(row => row.fixtureHash)).length !== 1) errors.push('Fixture hash drift');
if (unique(rows.map(row => row.protocolHash)).length !== 1) errors.push('Protocol hash drift');
if (unique(rows.filter(row => ['empty', 'long', 'dream', 'polluted'].includes(row.arm)).map(row => row.sourceHash)).length !== 1) errors.push('Memory-runtime source hash drift');
const pairs = [];
for (const project of ['ingestion', 'migration']) for (let repeat = 0; repeat < (repairOnly ? 1 : 2); repeat++) {
  const group = rows.filter(row => row.project === project && row.repeat === repeat);
  pairs.push({ project, repeat, arms: Object.fromEntries(group.map(row => [row.arm, {
    complete: row.complete,
    finalScores: row.scores.find(score => score.stage === 3).categoryScores,
    correctedPolicy: row.scores.find(score => score.stage === 3).checks.filter(check => /current default|region and corrected|expired.*override/.test(check.name)).map(({ name, passed }) => ({ name, passed })),
    stageExits: row.calls.map(call => ({ name: call.name, exitCode: call.exitCode, modelRequests: call.modelRequests, budgetExhausted: call.budgetExhausted ?? false, timedOut: call.timedOut ?? false })),
    modelRequests: row.modelRequests,
    totalInputTokens: (row.usage.input ?? 0) + (row.usage.cacheRead ?? 0),
    uncachedInputTokens: row.usage.input ?? 0,
    cachedInputTokens: row.usage.cacheRead ?? 0,
    wallMs: row.wallMs,
    actionBindingFailures: row.actionBindings.filter(binding => !binding.matched).length,
  }])) });
}
const report = { allIntegrityChecksPassed: errors.length === 0, repairOnly, expectedJobs: expected.length, recordedJobs: rows.length, errors, provenance, pairs };
await writeFile(join(directories.at(-1), 'audit.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
