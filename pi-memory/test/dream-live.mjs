/** Synthetic representation benchmark. Run: node --import tsx pi-memory/test/dream-live.mjs [--out=PATH] */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore, evidenceHash } from '../src/store.ts';
import { resolveProjectKey } from '../src/project.ts';

async function provisionalRescore(directory) {
  const rawResults = await readFile(join(directory, 'results.json'), 'utf8');
  const rawSummary = await readFile(join(directory, 'summary.json'), 'utf8');
  const rawCorpus = await readFile(join(directory, 'source-corpus.json'), 'utf8');
  const original = JSON.parse(rawSummary), results = JSON.parse(rawResults), corpus = JSON.parse(rawCorpus);
  const beacon = corpus.find(item => item.title === 'Beacon staging timeout');
  const zephyr = corpus.find(item => item.title === 'Zephyr staging deployment');
  if (!beacon?.body.includes('only after all staging migrations have passed.') || !zephyr?.body.includes('Zephyr deployments require a passing preflight before any apply operation.')) throw new Error('Frozen source evidence does not support the proposed rescore');
  const corrections = [
    { caseId: 'beacon-staging', field: 'requiresPassingPreflight', original: true, proposed: null, sourceId: beacon.id, exactQuote: beacon.body.slice(0, beacon.body.indexOf(' Never use')), rationale: 'The source names passed staging migrations, not a separately named preflight. Null is proposed under an explicit-preflight reading; whether migrations count as a preflight is an unresolved field-definition ambiguity for independent review.' },
    { caseId: 'zephyr-local-negative', field: 'requiresPassingPreflight', original: null, proposed: true, sourceId: zephyr.id, exactQuote: 'Zephyr deployments require a passing preflight before any apply operation.', rationale: 'The source states a general deployment preflight requirement. Unknown local command and resource limits can remain null while this supported requirement remains true.' },
  ];
  const rescored = results.map(row => {
    const correction = corrections.find(item => item.caseId === row.caseId);
    if (!correction) return row;
    const expected = { ...row.expected, [correction.field]: correction.proposed };
    const checks = Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, row.parsed?.[name] === value]));
    return { ...row, originalExpected: row.expected, originalActionSuccess: row.actionSuccess, expected, checks, actionSuccess: !row.errors.length && Object.values(checks).every(Boolean), provisionalOracleCorrection: correction.caseId };
  });
  const aggregate = Object.fromEntries(Object.entries(original.aggregate).map(([arm, metrics]) => {
    const rows = rescored.filter(row => row.arm === arm);
    return [arm, { ...metrics, actionSuccess: rows.filter(row => row.actionSuccess).length, positiveActions: rows.filter(row => !row.negative && row.actionSuccess).length, negativeCorrect: rows.filter(row => row.negative && row.actionSuccess).length }];
  }));
  const audit = { status: 'provisional-pending-independent-review', rawArtifactsUntouched: true, rawSha256: { results: createHash('sha256').update(rawResults).digest('hex'), summary: createHash('sha256').update(rawSummary).digest('hex'), corpus: createHash('sha256').update(rawCorpus).digest('hex') }, corrections };
  await writeFile(join(directory, 'provisional-gold-corrections.json'), JSON.stringify(audit, null, 2));
  await writeFile(join(directory, 'results.provisional-rescore.json'), JSON.stringify(rescored, null, 2));
  await writeFile(join(directory, 'summary.provisional-rescore.json'), JSON.stringify({ ...original, scoringStatus: audit.status, originalActionSuccess: Object.fromEntries(Object.entries(original.aggregate).map(([arm, metrics]) => [arm, metrics.actionSuccess])), aggregate, oracleCorrections: corrections }, null, 2));
  console.log(JSON.stringify({ status: audit.status, original: Object.fromEntries(Object.entries(original.aggregate).map(([arm, metrics]) => [arm, metrics.actionSuccess])), proposed: Object.fromEntries(Object.entries(aggregate).map(([arm, metrics]) => [arm, metrics.actionSuccess])) }));
}
const rescore = process.argv.find(arg => arg.startsWith('--rescore='))?.slice(10);
if (rescore) { await provisionalRescore(resolve(rescore)); process.exit(0); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || join(root, 'eval/results/dream-live'));
const model = 'openai/gpt-6.1-sol', arms = ['sources', 'compressed', 'semantic', 'combined'];
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error(`Nonempty output directory: ${out}`);
const base = await mkdtemp(join(tmpdir(), 'pi-dream-live-')), cwd = join(base, 'project');
await mkdir(cwd); const key = resolveProjectKey(cwd);
const expiry = new Date(Date.now() + 3600000).toISOString();
const expired = new Date(Date.now() - 3600000).toISOString();
const commonBeacon = 'For Beacon staging verification, run `pnpm beacon:smoke-v2` only after all staging migrations have passed. Never use the Beacon staging verification command against production.';
const commonZephyr = 'Zephyr deployments require a passing preflight before any apply operation. Use only the command and limits specified for the named deployment environment.';
const commonMercator = 'Mercator exports run `mc export --batch` only after the export preflight passes. A dated incident restriction overrides the standard limits only within the stated period and export type.';
const fixtures = [
  ['Beacon staging timeout', `${commonBeacon} Beacon staging verification has a 45 second timeout.`, ['beacon', 'staging', 'verification']],
  ['Beacon staging retries', `${commonBeacon} Beacon staging verification permits 2 retries.`, ['beacon', 'staging', 'verification']],
  ['Beacon staging workers', `${commonBeacon} Beacon staging verification uses 3 workers.`, ['beacon', 'staging', 'verification']],
  ['Zephyr staging deployment', `${commonZephyr} For Zephyr staging, use \`zx stage-apply\` with 3 workers, 2 retries and a 30 second timeout.`, ['zephyr', 'deployment', 'preflight']],
  ['Zephyr production deployment', `${commonZephyr} For Zephyr production, use \`zx prod-apply\` with 1 worker, 0 retries and a 90 second timeout.`, ['zephyr', 'deployment', 'preflight']],
  ['Mercator export standard limits', `${commonMercator} Standard Mercator exports use 4 workers and a 60 second timeout.`, ['mercator', 'export', 'limits']],
  ['Mercator export standard retries', `${commonMercator} Standard Mercator exports permit 2 retries.`, ['mercator', 'export', 'limits']],
  ['Mercator export incident limits', `${commonMercator} Until ${expiry}, invoice exports alone must use 1 worker and 0 retries; the timeout stays 60 seconds. Other export types keep the standard limits.`, ['mercator', 'export', 'limits'], { retention: 'short', expiresAt: expiry }],
];
const answer = (command, workers, retries, timeoutSeconds, requiresPassingPreflight) => ({ command, workers, retries, timeoutSeconds, requiresPassingPreflight });
const unknown = answer(null, null, null, null, null);
const cases = [
  { id: 'beacon-staging', context: 'Beacon staging verification, after its staging migrations have passed.', expected: answer('pnpm beacon:smoke-v2', 3, 2, 45, null) },
  { id: 'beacon-production-negative', context: 'Beacon production verification. Only staging evidence was supplied; production procedure is unknown.', expected: unknown, negative: true },
  { id: 'zephyr-staging', context: 'Zephyr staging deployment, after preflight passes.', expected: answer('zx stage-apply', 3, 2, 30, true) },
  { id: 'zephyr-production', context: 'Zephyr production deployment, after preflight passes.', expected: answer('zx prod-apply', 1, 0, 90, true) },
  { id: 'zephyr-local-negative', context: 'Zephyr local-development deployment. Only staging/production evidence was supplied; local procedure is unknown.', expected: { ...unknown, requiresPassingPreflight: true }, negative: true },
  { id: 'mercator-invoice-current', context: 'Mercator invoice export while the explicitly dated incident restriction is active, after preflight passes.', expected: answer('mc export --batch', 1, 0, 60, true), temporary: true },
  { id: 'mercator-other-current', context: 'Mercator payroll export while an invoice-only incident restriction is active, after preflight passes.', expected: answer('mc export --batch', 4, 2, 60, true), temporary: true },
  { id: 'mercator-invoice-expired', context: 'Mercator invoice export after the dated incident restriction has expired, after preflight passes.', expected: answer('mc export --batch', 4, 2, 60, true), expired: true, temporary: true },
];
const sourceHashes = async () => Object.fromEntries(await Promise.all(['index.ts', ...(await readdir(join(root, 'src'))).filter(file => file.endsWith('.ts')).map(file => `src/${file}`)].sort().map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
const sourcesAtStart = await sourceHashes();
const manifest = { started: new Date().toISOString(), model, piVersion: execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(), temporaryRoot: base, arms, sourceHashes: sourcesAtStart, fixtureHash: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'), cases, oracleVersion: 2, oracleNotes: ['Preflight expectations are explicit per case. Beacon source names passed staging migrations but no separately named preflight.', 'Zephyr general deployment preflight applies even with unknown local command; whether all-null refusal is preferable remains a field-definition caveat.', 'Original first-run raw results and source corpus remain unchanged; accepted first-run rescore is separate.'], fixtureKind: 'Synthetic gold evidence. Downstream cases and expected answers are withheld from dream inference.', actionMetric: 'Exact acceptance by a constrained mock executor; not live infrastructure execution', retrievalBudgetUpperBound: 1200, sourcePolicy: 'Production keeps original sources. Candidate-only arms are isolated representation experiments; no production source is archived.' };
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const corpus = new MemoryStore(join(base, 'corpus'), key); await corpus.initialize();
const originals = [];
for (const [title, body, keywords, lifetime] of fixtures) originals.push(await corpus.save({ title, body, keywords, type: 'procedure', importance: 8, confidence: 0.95, ...lifetime, source: { session: 'synthetic-dream-source', entries: [`fact-${originals.length}`], origin: 'user_statement' } }));
await writeFile(join(out, 'source-corpus.json'), JSON.stringify(originals, null, 2));
corpus.close();

async function execute(id, memoryDir, prompt, extraEnv = {}) {
  const trace = join(out, `${id}.trace.jsonl`);
  const args = ['-ne', '-ns', '-np', '-nc', '--no-mcp', '--no-tools', '-e', join(root, 'index.ts'), '--memory-dir', memoryDir, '--memory-mode', 'inject', '--model', model, '--thinking', 'low', '--no-session', '--mode', 'json', '-p', prompt];
  const run = await new Promise(resolveRun => {
    let stdout = '', stderr = '', timedOut = false, forceKill;
    const start = Date.now();
    const child = spawn('pi', args, { cwd, env: { ...process.env, PI_MEMORY_CAPTURE: '0', PI_MEMORY_DREAM: '0', PI_MEMORY_DISABLED: '0', PI_MEMORY_RETRIEVAL_MODEL: 'off', PI_MEMORY_TOKEN_BUDGET: '1200', PI_MEMORY_DIGEST_BUDGET: '0', PI_MEMORY_TRACE: trace, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); forceKill = setTimeout(() => child.kill('SIGKILL'), 2000); }, 120000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { stderr += error.message; });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); clearTimeout(forceKill); resolveRun({ stdout, stderr, exitCode, signal, timedOut, latencyMs: Date.now() - start }); });
  });
  await writeFile(join(out, `${id}.events.jsonl`), run.stdout); await writeFile(join(out, `${id}.stderr.txt`), run.stderr);
  let traces = [];
  try { traces = (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...run, traces, args };
}
function parseEvents(text) { return text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function inputOf(item) {
  const { title, body, type, summary, keywords, triggers, paths, importance, confidence, source, retention, expiresAt } = item;
  return { title, body, type, summary, keywords, triggers, paths, importance, confidence, source, retention, ...(expiresAt ? { expiresAt } : {}) };
}
function temporalCopy(input, isExpired) {
  if (!isExpired) return input;
  return { ...input, body: input.body.replaceAll(expiry, expired), ...(input.expiresAt ? { expiresAt: expired } : {}) };
}
async function canonicalBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await canonicalBytes(path);
    else if (entry.isFile() && entry.name.endsWith('.md')) total += (await stat(path)).size;
  }
  return total;
}
const results = []; let dream, parents = [], hypotheses = [], aborted;
try {
  const generation = await execute('dream-generation', join(base, 'corpus'), '/memory dream --force');
  dream = generation.traces.find(event => event.event === 'dream');
  if (generation.exitCode !== 0 || generation.timedOut || !dream || dream.status !== 'completed') throw new Error(`Dream generation failed: ${generation.stderr}`);
  const generatedStore = new MemoryStore(join(base, 'corpus'), key); await generatedStore.initialize();
  parents = generatedStore.get(dream.savedIds); generatedStore.close(); hypotheses = dream.hypotheses;
  await writeFile(join(out, 'generated-parents.json'), JSON.stringify(parents, null, 2));
  await writeFile(join(out, 'generated-hypotheses.json'), JSON.stringify(hypotheses, null, 2));
  if (!hypotheses.length) throw new Error('Dream model produced no hypothesis; semantic arm cannot be evaluated');
  for (const testCase of cases) for (const arm of arms) {
    const id = `${testCase.id}-${arm}`, memoryDir = join(base, id, 'memory');
    const store = new MemoryStore(memoryDir, key); await store.initialize();
    const mapped = new Map();
    if (arm === 'sources' || arm === 'combined') for (const original of originals) mapped.set(original.id, await store.save(temporalCopy(inputOf(original), testCase.expired)));
    if (arm === 'compressed' || arm === 'combined') for (const parent of parents) {
      const input = temporalCopy(inputOf(parent), testCase.expired);
      if (arm === 'combined') {
        if (input.retention === 'short' && Date.parse(input.expiresAt) <= Date.now()) continue;
        input.derivedFrom = parent.links.map(id => ({ id: mapped.get(id).id, hash: evidenceHash(mapped.get(id)) }));
        input.links = input.derivedFrom.map(source => source.id);
      }
      await store.save(input);
    }
    if (arm === 'semantic') for (const hypothesis of hypotheses) {
      const evidence = originals.filter(item => hypothesis.sourceIds.includes(item.id));
      await store.save(temporalCopy({ title: hypothesis.title, body: hypothesis.body, type: 'insight', summary: hypothesis.title, keywords: [...new Set(evidence.flatMap(item => item.keywords))], triggers: [], paths: [], importance: 8, confidence: 0.85, source: { session: 'experimental-unreviewed-hypothesis', entries: hypothesis.sourceIds, origin: 'consolidation' }, retention: hypothesis.retention, expiresAt: hypothesis.expiresAt }, testCase.expired));
    }
    const active = store.list();
    const sizes = { activeCount: active.length, activeTextBytes: active.reduce((sum, item) => sum + Buffer.byteLength(item.title + '\n' + item.summary + '\n' + item.body), 0), canonicalMarkdownBytes: await canonicalBytes(memoryDir) };
    await writeFile(join(out, `${id}.store.json`), JSON.stringify(store.list({ includeArchived: true }), null, 2)); store.close();
    const prompt = `Plan one operation for this context using only supported remembered evidence: ${testCase.context}\nReturn JSON only with exactly these keys: command, workers, retries, timeoutSeconds, requiresPassingPreflight. Use null for each unknown value. Do not execute tools or invent missing project decisions.`;
    const execution = await execute(id, memoryDir, prompt);
    const messages = parseEvents(execution.stdout).filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message);
    const last = messages.at(-1), response = last?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || '';
    const errors = []; let parsed;
    try { parsed = JSON.parse(response.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { errors.push('Response was not JSON'); }
    if (execution.exitCode !== 0 || execution.timedOut || last?.stopReason !== 'stop') errors.push('Pi/provider execution failed');
    const checks = Object.fromEntries(Object.entries(testCase.expected).map(([name, value]) => [name, parsed?.[name] === value]));
    // The mock executor only accepts an exact known command with the context-specific resource and safety limits.
    const actionSuccess = !errors.length && Object.values(checks).every(Boolean);
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const message of messages) for (const name of Object.keys(usage)) usage[name] += message.usage?.[name] || 0;
    const recalls = execution.traces.filter(event => event.event === 'recall');
    const selected = new Set(recalls.flatMap(event => event.ids || []));
    const coInjectedParents = active.filter(item => selected.has(item.id) && item.derivedFrom?.some(source => selected.has(source.id)));
    const coInjection = { parentSourcePairs: coInjectedParents.reduce((sum, item) => sum + item.derivedFrom.filter(source => selected.has(source.id)).length, 0), parentIds: coInjectedParents.map(item => item.id), observed: coInjectedParents.length > 0 };
    const result = { coInjection, id, caseId: testCase.id, arm, negative: !!testCase.negative, temporary: !!testCase.temporary, expired: !!testCase.expired, response, parsed, expected: testCase.expected, checks, actionSuccess, overgeneralized: !!testCase.negative && parsed?.command != null, temporaryLeak: !!testCase.expired && (parsed?.workers === 1 || parsed?.retries === 0), errors, usage, injectedTextUpperBound: Math.max(0, ...recalls.map(event => event.tokenUpperBound || event.tokens || 0)), selectedIds: recalls.flatMap(event => event.ids || []), sizes, latencyMs: execution.latencyMs };
    results.push(result); await writeFile(join(out, `${id}.result.json`), JSON.stringify(result, null, 2));
    console.log(`${id}: action=${actionSuccess ? 1 : 0} fields=${Object.values(checks).filter(Boolean).length}/5 memory=${result.injectedTextUpperBound}`);
    if (execution.timedOut) throw new Error(`${id} timed out; aborting remaining live runs`);
  }
} catch (error) { aborted = error instanceof Error ? error.message : String(error); }
finally {
  const aggregate = Object.fromEntries(arms.map(arm => {
    const rows = results.filter(result => result.arm === arm), positive = rows.filter(row => !row.negative), negative = rows.filter(row => row.negative);
    return [arm, { runs: rows.length, coInjectedRuns: rows.filter(row => row.coInjection.observed).length, coInjectionRate: rows.length ? rows.filter(row => row.coInjection.observed).length / rows.length : 0, actionSuccess: rows.filter(row => row.actionSuccess).length, positiveActions: positive.filter(row => row.actionSuccess).length, positiveTotal: positive.length, negativeCorrect: negative.filter(row => row.actionSuccess).length, negativeTotal: negative.length, overgeneralizations: rows.filter(row => row.overgeneralized).length, temporaryLeaks: rows.filter(row => row.temporaryLeak).length, meanInjectedTextUpperBound: rows.length ? rows.reduce((sum, row) => sum + row.injectedTextUpperBound, 0) / rows.length : 0, meanProviderInput: rows.length ? rows.reduce((sum, row) => sum + row.usage.input + row.usage.cacheRead, 0) / rows.length : 0, firstRunSize: rows[0]?.sizes }];
  }));
  const commands = [...new Set(originals.flatMap(item => (item.body.match(/`[^`]+`/g) || []).map(command => command.slice(1, -1))))];
  const semanticText = hypotheses.map(item => item.body).join('\n'), compressedText = parents.map(item => item.body).join('\n');
  const summary = { completed: new Date().toISOString(), model, operationalSuccess: !aborted && results.length === cases.length * arms.length && results.every(row => !row.errors.length), sourceStable: JSON.stringify(sourcesAtStart) === JSON.stringify(await sourceHashes()), aborted, aggregate, dream: dream && { savedParents: dream.savedIds.length, hypotheses: dream.hypotheses.length, usage: dream.usage, inputTokensEstimate: dream.inputTokensEstimate, outputTokensEstimate: dream.outputTokensEstimate, rejected: dream.rejected }, literalCommandRetention: { total: commands.length, compressed: commands.filter(command => compressedText.includes(command)).length, semantic: commands.filter(command => semanticText.includes(command)).length }, limitations: ['One synthetic corpus and one model sample per task/arm; not a broad efficacy estimate.', 'Action success means deterministic mock-plan acceptance, not deployed infrastructure execution.', 'Candidate-only arms deliberately isolate representations. Production keeps source memories active.', 'Temporary expiry variant consistently moves the recorded expiry into the past; no user clock or files are changed.', 'Conservative injected byte bounds are separate from measured provider token usage.'] };
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2)); await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary)); if (!summary.operationalSuccess || !summary.sourceStable) process.exitCode = 1;
}
