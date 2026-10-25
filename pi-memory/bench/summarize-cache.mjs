import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (!process.argv[2]) throw new Error('Usage: node bench/summarize-cache.mjs <result-directory>');
const root = resolve(process.argv[2]);
const results = [];
for (const file of (await readdir(root)).filter(file => file.endsWith('.result.json'))) {
  const result = JSON.parse(await readFile(join(root, file), 'utf8'));
  const events = (await readFile(join(root, `${result.id}.events.jsonl`), 'utf8')).trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const messages = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message);
  result.outputDeviations = messages.map((message, i) => ({ turn: i + 1, text: message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() })).filter(row => row.text !== 'ACK');
  result.measurementErrors = result.errors.filter(error => error !== 'Unexpected model output');
  if (messages.some(message => message.stopReason !== 'stop')) result.measurementErrors.push('Incomplete model response');
  results.push(result);
}
const totals = {};
for (const arm of ['off', 'append-only-memory', 'prefix-breaking-control']) {
  const runs = results.filter(run => run.arm === arm), rows = runs.flatMap(run => run.turns), warm = rows.filter(row => row.turn > 1);
  const sum = (data, key) => data.reduce((total, row) => total + (row[key] ?? 0), 0);
  totals[arm] = { sessions: runs.length, requests: rows.length, measurementErrors: runs.flatMap(run => run.measurementErrors), originalHarnessErrors: runs.flatMap(run => run.errors), outputDeviations: runs.flatMap(run => run.outputDeviations), inputTokens: sum(rows, 'input'), ordinaryInputTokens: sum(rows, 'uncachedInput'), cachedInputTokens: sum(rows, 'cacheRead'), cacheWriteTokens: sum(rows, 'cacheWrite'), cachedShare: sum(rows, 'cacheRead') / sum(rows, 'input'), warmCachedShare: sum(warm, 'cacheRead') / sum(warm, 'input'), meanFirstTextMs: sum(rows, 'firstTextMs') / rows.length, meanResponseMs: sum(rows, 'latencyMs') / rows.length, sdkEstimatedCost: rows.reduce((total, row) => total + (row.sdkCostEstimate?.total ?? 0), 0), prefixStableChecks: runs.flatMap(run => run.prefixChecks) };
}
const report = { allCompletedRequestsIncluded: true, originalResultsUnmodified: true, totals, limitation: 'Acknowledgment-only requests test caching, not task quality. Non-ACK punctuation is recorded separately and never excludes token usage. This is a small provider-dependent sample; SDK cost estimates are not invoices.' };
await writeFile(join(root, 'measurement-summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(totals, null, 2));
