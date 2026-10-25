import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreAnswer } from './score.mjs';
import { commonPrompt, taskPrompt } from './protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const usage = `Usage: node --import tsx pi-memory/eval/run.mjs [options]

Runs paid Pi model requests against synthetic fixtures. --help makes no model requests.

  --model=openai/gpt-6.1-sol|xai/grok-4.7   Model (default openai/gpt-6.1-sol)
  --split=dev|heldout|all                   Case split (default dev)
  --arms=off,baseline,improved              Comma-separated unique arms
  --repeats=2                              Repetitions, integer 1..10
  --concurrency=2                          Parallel Pi calls, integer 1..2
  --fixtures=path                          Fixture JSON (default eval/cases.json)
  --out=path                               New output directory
  --case=id                                Run one case from the selected split
  --help, -h                               Show this help and exit

Freeze fixtures before tuning. Keep heldout results private until the final candidate.
Use the same model, fixture, prompt, and caps for every paired arm.`;
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(usage); process.exit(0); }
const allowedOptions = new Set(['model', 'split', 'arms', 'repeats', 'concurrency', 'fixtures', 'out', 'case']);
const seenOptions = new Set();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  if (!match || !allowedOptions.has(match[1]) || seenOptions.has(match[1])) { console.error(`Invalid or duplicate option: ${arg}\nUse --help for usage.`); process.exit(2); }
  seenOptions.add(match[1]);
}
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const model = option('model', 'openai/gpt-6.1-sol');
const split = option('split', 'dev');
const arms = option('arms', 'off,baseline,improved').split(',');
const repeats = Number(option('repeats', '2'));
const concurrency = Number(option('concurrency', '2'));
if (!['dev', 'heldout', 'all'].includes(split)) throw new Error('split must be dev, heldout, or all');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be an integer 1..10');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('concurrency must be 1 or 2');
if (new Set(arms).size !== arms.length || arms.some(arm => !['off', 'baseline', 'improved'].includes(arm))) throw new Error('arms must contain unique off, baseline, or improved entries');
if (!['openai/gpt-6.1-sol', 'xai/grok-4.7'].includes(model)) throw new Error('Use an authorized model');
const fixturePath = resolve(option('fixtures', join(here, 'cases.json')));
const fixtureText = await readFile(fixturePath, 'utf8');
const fixtureHash = createHash('sha256').update(fixtureText).digest('hex');
const protocolHash = createHash('sha256').update(JSON.stringify({ fixtureHash, commonPrompt, model, thinking: 'low', outputTokenCap: 2048, memoryTokenCap: 1200, tools: [] })).digest('hex');
const requestedCase = option('case', '');
const cases = JSON.parse(fixtureText).cases.filter(testCase => (split === 'all' || testCase.split === split) && (!requestedCase || testCase.id === requestedCase));
if (!cases.length) throw new Error('No selected cases');
const out = resolve(option('out', join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${split}`)));
try {
  if ((await readdir(out)).length) throw new Error('Output directory is not empty; choose a new --out to preserve prior evidence');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(out, { recursive: true });
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pi-memory-eval-'));
const sourceHashes = {};
if (arms.some(arm => arm !== 'off')) {
  for (const file of ['index.ts', ...(await readdir(resolve(here, '../src'))).filter(name => name.endsWith('.ts')).sort().map(name => `src/${name}`)]) {
    const contents = await readFile(resolve(here, '..', file));
    sourceHashes[file] = createHash('sha256').update(contents).digest('hex');
    const destination = join(out, 'source-snapshot', file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
}
const sourceHash = createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex');
const manifest = { started: new Date().toISOString(), model, split, arms, repeats, fixturePath, fixtureHash, protocolHash, sourceHash, sourceHashes, commonPrompt, concurrency, thinking: 'low', outputTokenCap: 2048, memoryTokenCap: 1200, tools: [], temporaryRoot };
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

async function seed(testCase, cwd, memoryDir) {
  const { MemoryStore } = await import('../src/store.ts');
  const { resolveProjectKey } = await import('../src/project.ts');
  const store = new MemoryStore(memoryDir, resolveProjectKey(cwd));
  const foreign = new MemoryStore(memoryDir, 'foreign-eval-project');
  await store.initialize();
  await foreign.initialize();
  const ids = {};
  for (const memory of testCase.memories) {
    const target = memory.scope === 'foreign' ? foreign : store;
    const { key, origin, ...input } = memory;
    const saved = await target.save({ ...input, scope: memory.scope === 'global' ? 'global' : 'project', source: { session: `synthetic:${testCase.id}`, entries: [key], origin: origin ?? 'user_confirmation' }, supersedes: (memory.supersedes ?? []).map(key => ids[key].id) });
    const item = saved.item ?? saved;
    ids[key] = { id: item.id, scope: memory.scope ?? 'project' };
  }
  store.close();
  foreign.close();
  return ids;
}

function execute(args, cwd, env) {
  return new Promise(resolveRun => {
    const started = Date.now();
    const child = spawn('pi', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { stderr += error.message; });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolveRun({ stdout, stderr, exitCode, signal, timedOut, latencyMs: Date.now() - started }); });
  });
}

async function run(testCase, arm, repeat) {
  const runId = `${testCase.id}-${arm}-${repeat}`;
  const cwd = join(temporaryRoot, testCase.id, `rep-${repeat}`, 'project');
  const memoryDir = join(temporaryRoot, runId, 'memory');
  await mkdir(cwd, { recursive: true });
  const ids = arm === 'off' ? {} : await seed(testCase, cwd, memoryDir);
  const tracePath = join(out, `${runId}.trace.jsonl`);
  const budgetTrace = join(out, `${runId}.budget.jsonl`);
  const args = ['--no-extensions', '-e', join(here, 'budget.ts'), '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp', '--no-session', '--model', model, '--thinking', 'low', '--no-tools', '--mode', 'json'];
  if (arm !== 'off') args.push('-e', resolve(here, '../index.ts'), '--memory-dir', memoryDir, '--memory-mode', 'inject');
  args.push('-p', taskPrompt(testCase));
  const execution = await execute(args, cwd, { ...process.env, PI_MEMORY_DIR: memoryDir, PI_MEMORY_DISABLED: arm === 'off' ? '1' : '0', PI_MEMORY_CAPTURE: '0', PI_MEMORY_STRATEGY: arm, PI_MEMORY_RETRIEVAL_MODEL: 'off', PI_MEMORY_TOKEN_BUDGET: '1200', PI_MEMORY_TRACE: tracePath, PI_EVAL_BUDGET_TRACE: budgetTrace });
  await writeFile(join(out, `${runId}.events.jsonl`), execution.stdout);
  await writeFile(join(out, `${runId}.stderr.txt`), execution.stderr);
  const events = execution.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const assistantMessages = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message);
  const final = assistantMessages.at(-1);
  const response = (final?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const usage = assistantMessages.reduce((total, message) => {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens']) total[key] = (total[key] ?? 0) + (message.usage?.[key] ?? 0);
    total.cost = (total.cost ?? 0) + (message.usage?.cost?.total ?? 0);
    return total;
  }, {});
  let trace = [];
  try { trace = (await readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { /* Off arm has no memory trace. */ }
  const recalls = trace.filter(event => event.event === 'recall');
  const selectedIds = recalls.flatMap(event => event.ids ?? []);
  const selectedMemoryKeys = selectedIds.map(id => Object.entries(ids).find(([, memory]) => memory.id === id)?.[0] ?? id);
  const foreignIds = Object.values(ids).filter(value => value.scope === 'foreign').map(value => value.id);
  let budgets = [];
  try { budgets = (await readFile(budgetTrace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { /* Reported below. */ }
  const errors = [];
  if (arm !== 'off') for (const [file, hash] of Object.entries(sourceHashes)) {
    // Capture and maintenance are disabled in this recall-only experiment.
    if (file === 'src/capture.ts' || file === 'src/maintenance.ts') continue;
    if (createHash('sha256').update(await readFile(resolve(here, '..', file))).digest('hex') !== hash) errors.push(`Source changed during run: ${file}`);
  }
  if (execution.exitCode !== 0) errors.push(`Pi exit ${execution.exitCode}`);
  if (!final || final.stopReason === 'error') errors.push(final?.errorMessage ?? 'No successful assistant response');
  if (!budgets.length) errors.push('Output cap hook did not execute');
  if (arm !== 'off' && !recalls.length) errors.push('Missing actual retrieval trace');
  const score = scoreAnswer(testCase, response);
  const result = { runId, caseId: testCase.id, split: testCase.split, kind: testCase.kind, category: testCase.category, arm, repeat, model, fixtureHash, protocolHash, sourceHash, response, score: errors.length ? 0 : score.score, validation: score, errors, selectedIds, selectedMemoryKeys, draftMemoryCount: selectedMemoryKeys.filter(key => key.startsWith('draft-')).length, memoryIds: ids, injectedTokens: Math.max(0, ...recalls.map(event => event.tokens ?? 0)), scopeLeaks: selectedIds.filter(id => foreignIds.includes(id)), usage, latencyMs: execution.latencyMs, exitCode: execution.exitCode, stopReason: final?.stopReason, budgetVerified: budgets.length > 0 };
  await writeFile(join(out, `${runId}.result.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`${runId}: ${result.score.toFixed(3)} (${result.latencyMs}ms)${errors.length ? ` ERROR ${errors.join('; ')}` : ''}`);
  return result;
}

// Rotate arm order by repetition to reduce systematic provider/caching order effects.
const jobs = [];
for (let repeat = 0; repeat < repeats; repeat++) for (const testCase of cases) {
  const ordered = [...arms.slice(repeat % arms.length), ...arms.slice(0, repeat % arms.length)];
  for (const arm of ordered) jobs.push({ testCase, arm, repeat });
}
const results = [];
let cursor = 0;
let startupFailed = false;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < jobs.length && !startupFailed) {
    const job = jobs[cursor++];
    const result = await run(job.testCase, job.arm, job.repeat);
    results.push(result);
    if (!result.budgetVerified) startupFailed = true;
  }
}));
await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`Results: ${out}`);
if (startupFailed) { console.error('Stopped after startup failure; fix infrastructure before retrying.'); process.exitCode = 1; }
