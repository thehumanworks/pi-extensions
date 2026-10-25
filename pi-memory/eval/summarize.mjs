import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directories = process.argv.slice(2).map(directory => resolve(directory));
if (!directories.length) throw new Error('Usage: node summarize.mjs <result-dir> [...]');
const rows = [];
for (const directory of directories) for (const name of await readdir(directory)) if (name.endsWith('.result.json')) rows.push(JSON.parse(await readFile(join(directory, name), 'utf8')));
const hashes = new Set(rows.map(row => row.fixtureHash));
if (hashes.size !== 1) throw new Error('Cannot combine different frozen case hashes');
const protocols = new Set(rows.map(row => row.protocolHash));
if (protocols.size !== 1) throw new Error('Cannot combine different prompt/model protocols');
const runKeys = rows.map(row => `${row.caseId}:${row.arm}:${row.repeat}`);
if (new Set(runKeys).size !== runKeys.length) throw new Error('Duplicate paired runs; choose one candidate directory per case/arm/repetition');
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const percentile = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null;
const aggregate = {};
for (const split of ['dev', 'heldout', 'all']) {
  aggregate[split] = {};
  for (const arm of ['off', 'baseline', 'improved']) {
    const group = rows.filter(row => row.arm === arm && (split === 'all' || row.split === split));
    if (!group.length) continue;
    aggregate[split][arm] = { n: group.length, taskScore: mean(group.map(row => row.score)), positiveScore: mean(group.filter(row => row.kind === 'positive').map(row => row.score)), controlScore: mean(group.filter(row => row.kind === 'control').map(row => row.score)), p95InjectedTokens: percentile(group.map(row => row.injectedTokens)), meanSelectedMemories: mean(group.map(row => row.selectedIds.length)), meanDraftMemories: mean(group.map(row => row.draftMemoryCount ?? 0)), meanInputTokens: mean(group.map(row => row.usage.input + row.usage.cacheRead)), meanOutputTokens: mean(group.map(row => row.usage.output)), p95LatencyMs: percentile(group.map(row => row.latencyMs)), errors: group.filter(row => row.errors.length).length, scopeLeaks: group.reduce((total, row) => total + row.scopeLeaks.length, 0) };
  }
  const off = aggregate[split].off, improved = aggregate[split].improved;
  if (off && improved) {
    const relevant = rows.filter(row => split === 'all' || row.split === split);
    const offKeys = relevant.filter(row => row.arm === 'off').map(row => `${row.caseId}:${row.repeat}`).sort();
    const improvedKeys = relevant.filter(row => row.arm === 'improved').map(row => `${row.caseId}:${row.repeat}`).sort();
    aggregate[split].acceptance = { pairedKeysMatch: JSON.stringify(offKeys) === JSON.stringify(improvedKeys), gainPercentagePoints: 100 * (improved.taskScore - off.taskScore), gainAtLeast20pp: improved.taskScore - off.taskScore >= 0.2, noControlRegression: improved.controlScore >= off.controlScore, scopeLeaksZero: improved.scopeLeaks === 0, p95Within1200: improved.p95InjectedTokens <= 1200, noRunErrors: improved.errors === 0 };
  }
}
const summary = { fixtureHash: [...hashes][0], protocolHash: [...protocols][0], directories, model: [...new Set(rows.map(row => row.model))], aggregate };
await writeFile(join(directories.at(-1), 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
