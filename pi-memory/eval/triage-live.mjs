#!/usr/bin/env node
// Scores labelled arrivals through the real wake gate and prints precision and recall per threshold.
// Usage: node --import tsx eval/triage-live.mjs <provider/model> [--sessions=<dir>...] [--out=<file>]
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pi = await import(pathToFileURL(resolve(root, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const { findClassifier } = await import(`${root}/src/extract.ts`);
const { arrivals, triage, THRESHOLD } = await import(`${root}/src/triage.ts`);
const { fixtures } = await import(`${root}/eval/long/fixtures.mjs`);

const [selection, ...options] = process.argv.slice(2);
const option = name => options.filter(value => value.startsWith(`--${name}=`)).map(value => value.slice(name.length + 3));
const registry = new pi.ModelRegistry(await pi.ModelRuntime.create({ authPath: join(pi.getAgentDir(), 'auth.json'), modelsPath: join(pi.getAgentDir(), 'models.json') }));
let calls = 0, cost = 0, input = 0, cached = 0;
const answers = [];
const modelRegistry = new Proxy(registry, { get(target, key) {
  if (key === 'classify') return async (model, request, ...rest) => {
    const result = await target.classify(model, request, ...rest);
    calls++; cost += result.usage?.cost?.total ?? 0; input += result.usage?.input ?? 0; cached += result.usage?.cacheRead ?? 0;
    for (const key of Object.keys(request.questions)) answers.push(result.answers[key]?.score);
    return result;
  };
  const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
} });
const ctx = { cwd: await mkdtemp(join(tmpdir(), 'pi-memory-triage-')), modelRegistry };
const model = await findClassifier(selection, ctx);
if (!model) throw new Error(`classifier unavailable: ${selection}`);
const at = '2026-10-31T10:00:00.000Z';

/** Turns a labelled case into the transcript shape, so splitting and pairing run as they do in capture. */
function transcript(testCase) {
  if (testCase.failure) return [{ id: 'f', role: 'toolResult', tool: 'tool', isError: true, timestamp: at, ...testCase.failure }, { id: 's', role: 'toolResult', tool: 'tool', timestamp: at, ...testCase.success }];
  return [...(testCase.before ? [{ id: 'a', role: 'assistant', text: testCase.before, timestamp: at }] : []), { id: 'u', role: 'user', text: testCase.text, timestamp: at }];
}
async function score(items) {
  answers.length = 0;
  await triage(items, model, AbortSignal.timeout(120000), ctx);
  return items.map((_, index) => answers[index] ?? 0);
}

const { cases } = JSON.parse(await readFile(join(root, 'eval/triage-cases.json'), 'utf8'));
for (const fixture of fixtures) {
  for (const key of ['history', 'correction']) cases.push({ id: `${fixture.id}-${key}`, kind: `long-${key}`, keep: true, text: fixture[key] });
  for (const key of ['implement', 'temporary', 'revoke', 'transfer', 'repairHistory']) cases.push({ id: `${fixture.id}-${key}`, kind: `long-${key}`, keep: false, text: fixture[key] });
}
// A message split into pieces counts as kept when any piece is: reflect sees that piece.
const expanded = cases.flatMap(testCase => arrivals(transcript(testCase), new Set(['u', 's'])).map(item => ({ testCase, item })));
const scores = await score(expanded.map(({ item }) => item));
const best = new Map();
for (const [index, { testCase }] of expanded.entries()) best.set(testCase, Math.max(best.get(testCase) ?? 0, scores[index]));
const rows = [...best].map(([testCase, value]) => ({ id: testCase.id, kind: testCase.kind, keep: testCase.keep, score: Number(value.toFixed(2)), text: (testCase.text ?? testCase.success.call).slice(0, 70) }));
console.log(`${rows.length} cases, ${expanded.length} arrivals, default threshold ${THRESHOLD}`);
for (const threshold of [0.75, 1, 1.25, 1.5, 1.75, 2]) {
  const kept = rows.filter(row => row.score >= threshold), hits = kept.filter(row => row.keep).length, wanted = rows.filter(row => row.keep).length;
  console.log(`threshold ${threshold}: precision ${(hits / (kept.length || 1)).toFixed(2)}, recall ${(hits / wanted).toFixed(2)}, stored ${kept.length}/${rows.length}`);
}
for (const row of rows.filter(row => row.keep !== row.score >= THRESHOLD)) console.log(`${row.keep ? 'MISSED' : 'STORED'} ${row.score} ${row.kind}: ${row.text}`);

const real = [];
for (const directory of option('sessions')) for (const file of (await readdir(directory)).filter(name => name.endsWith('.jsonl'))) {
  const evidence = (await readFile(join(directory, file), 'utf8')).split('\n').flatMap(line => { try { const entry = JSON.parse(line); return entry.type === 'message' ? [entry] : []; } catch { return []; } })
    .flatMap(({ id, timestamp, message }) => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const text = typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      return text ? [{ id, role: message.role, text, timestamp }] : [];
    });
  real.push(...arrivals(evidence, new Set(evidence.map(entry => entry.id))));
}
let sessionRows = [];
if (real.length) {
  const values = await score(real);
  sessionRows = real.map((item, index) => ({ score: Number(values[index].toFixed(2)), text: item.body.slice(0, 110).replace(/\s+/g, ' ') })).sort((a, b) => b.score - a.score);
  for (const threshold of [1, 1.5, 2]) console.log(`real messages at ${threshold}: ${sessionRows.filter(row => row.score >= threshold).length}/${real.length}`);
}
console.log(`${calls} requests, ${input} input tokens (${cached} cached), $${cost.toFixed(4)}`);
if (option('out').length) await writeFile(option('out')[0], JSON.stringify({ selection, rows, sessionRows, calls, input, cached, cost }, null, 2) + '\n');
