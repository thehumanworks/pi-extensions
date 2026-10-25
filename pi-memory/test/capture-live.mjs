/** Run with: node --import tsx pi-memory/test/capture-live.mjs [--out=PATH] */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/store.ts';
import { resolveProjectKey } from '../src/project.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outOption = process.argv.find(arg => arg.startsWith('--out='))?.slice(6)
  ?? (process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined);
const out = resolve(outOption || join(packageRoot, 'eval/results/capture-live-final'));
const model = 'openai/gpt-6.1-sol';
const base = await mkdtemp(join(tmpdir(), 'pi-memory-capture-live-'));
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error(`Artifact directory is not empty: ${out}; choose --out=PATH`);

async function sourceHashes() {
  const files = ['index.ts', ...(await readdir(join(packageRoot, 'src'))).filter(file => file.endsWith('.ts')).map(file => `src/${file}`), 'prompts/memory-agent.preset.md'];
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, createHash('sha256').update(await readFile(join(packageRoot, file))).digest('hex')])));
}
const sources = await sourceHashes();
const manifest = { started: new Date().toISOString(), piVersion: execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(), executable: 'pi', model, thinking: 'low', tools: [], temporaryRoot: base, sources, timeoutMs: 180000, captureFailureInjection: 'Unavailable model lookup, no request sent to that model' };
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const results = [];
let abortReason;

function execute(args, cwd, trace) {
  return new Promise(resolveRun => {
    const started = Date.now();
    const child = spawn('pi', args, { cwd, env: { ...process.env, PI_MEMORY_DISABLED: '0', PI_MEMORY_CAPTURE: '1', PI_MEMORY_MODEL: model, PI_MEMORY_STRATEGY: 'improved', PI_MEMORY_TRACE: trace }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, forceKill;
    const timeout = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, manifest.timeoutMs);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { stderr += error.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout); clearTimeout(forceKill);
      resolveRun({ stdout, stderr, exitCode, signal, timedOut, latencyMs: Date.now() - started });
    });
  });
}
function parseLines(text) { return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
async function captureStates(memoryDir) {
  let files = [];
  try { files = await readdir(join(memoryDir, 'capture')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => ({ file, ...JSON.parse(await readFile(join(memoryDir, 'capture', file), 'utf8')) })));
}
async function run(scenario, name, prompt, expected, captureModel = model) {
  const cwd = join(base, scenario, 'project'), memoryDir = join(base, scenario, 'memory');
  await mkdir(cwd, { recursive: true });
  const id = `${scenario}-${name}`, trace = join(out, `${id}.trace.jsonl`);
  const args = ['-ne', '-ns', '-np', '-nc', '--no-mcp', '--no-tools', '-e', join(packageRoot, 'index.ts'), '--memory-dir', memoryDir, '--memory-mode', 'inject', '--memory-model', captureModel, '--session-dir', join(base, scenario, 'sessions'), '--model', model, '--thinking', 'low', '--mode', 'json', '-p', prompt];
  const execution = await execute(args, cwd, trace);
  await writeFile(join(out, `${id}.events.jsonl`), execution.stdout);
  await writeFile(join(out, `${id}.stderr.txt`), execution.stderr);
  const events = parseLines(execution.stdout);
  const final = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
  const response = final?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  const store = new MemoryStore(memoryDir, resolveProjectKey(cwd));
  let items;
  try { await store.initialize(); items = store.list({ includeArchived: true }); } finally { store.close(); }
  const watermarks = await captureStates(memoryDir);
  await writeFile(join(out, `${id}.store.json`), JSON.stringify(items, null, 2) + '\n');
  await writeFile(join(out, `${id}.watermarks.json`), JSON.stringify(watermarks, null, 2) + '\n');
  const errors = [];
  if (execution.exitCode !== 0 || execution.timedOut) errors.push(`Pi failed: exit=${execution.exitCode}, timeout=${execution.timedOut}`);
  if (final?.stopReason !== 'stop') errors.push(`Unexpected final stop reason: ${final?.stopReason}`);
  if (response !== expected) errors.push(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(response)}`);
  const active = items.filter(item => item.status === 'active');
  const result = { id, prompt, args, response, expected, exitCode: execution.exitCode, latencyMs: execution.latencyMs, timedOut: execution.timedOut, errors, score: 0, activeIds: active.map(item => item.id), archivedIds: items.filter(item => item.status !== 'active').map(item => item.id) };
  results.push(result);
  if (execution.timedOut) { result.score = 0; abortReason = `${id} timed out; remaining runs aborted`; throw new Error(abortReason); }
  return { result, items, active, watermarks, stderr: execution.stderr };
}
function check(run, condition, message) { if (!condition) run.result.errors.push(message); }
async function persistResults() {
  for (const result of results) result.score = result.errors.length ? 0 : 1;
  const sourceStable = JSON.stringify(sources) === JSON.stringify(await sourceHashes());
  const summary = { completed: new Date().toISOString(), model, executable: 'pi', piVersion: manifest.piVersion, passed: !abortReason && sourceStable && results.length === 7 && results.every(result => result.score === 1), sessions: results.length, passedSessions: results.filter(result => result.score === 1).length, sourceStable, abortReason, limitations: ['Synthetic single-project fixture per scenario; no broad memory quality estimate'], results: results.map(({ id, score, response, errors, latencyMs }) => ({ id, score, response, errors, latencyMs })) };
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  if (!summary.passed) process.exitCode = 1;
}
try {
  const captured = await run('learning', 'capture', 'Remember this project-specific decision for future sessions: the Beacon staging smoke test command is pnpm beacon:verify. Always use pnpm beacon:verify for Beacon staging verification. Reply only ACK.', 'ACK');
  check(captured, captured.active.length === 1 && captured.active[0].body.includes('pnpm beacon:verify'), 'Automatic capture did not persist the agreed command');
  await run('learning', 'recall', 'What is our agreed Beacon staging smoke test command? Return only the command.', 'pnpm beacon:verify');
  const corrected = await run('learning', 'correction', 'Correction: never use pnpm beacon:verify for Beacon staging anymore. The new agreed Beacon staging smoke test command is pnpm beacon:smoke-v2. Remember this replaces the previous command. Reply only ACK.', 'ACK');
  check(corrected, corrected.active.length === 1 && corrected.active[0].body.includes('pnpm beacon:smoke-v2'), 'Correction did not persist the replacement command');
  check(corrected, captured.active.length === 1 && corrected.items.some(item => item.id === captured.active[0].id && item.status === 'superseded'), 'Correction did not supersede the original memory');
  await run('learning', 'recall-correction', 'What is our current agreed Beacon staging smoke test command? Return only the current command.', 'pnpm beacon:smoke-v2');
  const retained = await run('retry', 'retained', 'Remember the Beacon recovery marker is ORCHID-47. Always use ORCHID-47 when asked for the Beacon recovery marker. Reply only ACK.', 'ACK', 'openai/unavailable-memory-smoke');
  check(retained, !retained.active.length && retained.stderr.includes('Memory capture model is unavailable or has no configured authentication') && retained.watermarks.some(state => state.pending?.entries?.length), 'Configuration failure did not retain a durable pending delta');
  const repaired = await run('retry', 'repaired', 'Reply only ACK.', 'ACK');
  check(repaired, repaired.active.length === 1 && repaired.active[0].body.includes('ORCHID-47'), 'The later session did not capture the pending original fact');
  const original = retained.watermarks.find(state => state.pending?.sessionFile)?.pending;
  if (original && repaired.active.length) {
    const originalText = await readFile(original.sessionFile, 'utf8');
    await writeFile(join(out, 'retry-original-source.session.jsonl'), originalText);
    const source = repaired.active[0].source;
    check(repaired, source.session === original.sessionFile && source.entries.some(id => original.entries.includes(id)) && parseLines(originalText).some(entry => source.entries.includes(entry.id) && JSON.stringify(entry).includes('ORCHID-47')), 'Repaired memory lost original session/entry provenance');
    check(repaired, !repaired.watermarks.some(state => state.pending), 'Pending marker remained after successful retry');
  } else check(repaired, false, 'Original pending source could not be verified');
  await run('retry', 'recall', 'What is our agreed Beacon recovery marker? Return only the marker.', 'ORCHID-47');
} catch (error) {
  abortReason ||= error instanceof Error ? error.message : String(error);
} finally { await persistResults(); }
