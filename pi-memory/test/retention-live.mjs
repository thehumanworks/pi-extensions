/** Real-clock expiry and real file actions. Run: node --import tsx pi-memory/test/retention-live.mjs [output-dir] */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStore } from '../src/store.ts';
import { resolveProjectKey } from '../src/project.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'eval/results/retention-live'));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Choose an empty output directory');
const base = await mkdtemp(join(tmpdir(), 'pi-memory-retention-'));
const cwd = join(base, 'project'), original = join(base, 'captured');
await mkdir(cwd);
const model = 'openai/gpt-6.1-sol';
const hashSources = async () => Object.fromEntries(await Promise.all(['index.ts', ...(await readdir(join(root, 'src'))).filter(f => f.endsWith('.ts')).map(f => `src/${f}`)].sort().map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
const sourceHashes = await hashSources();
const manifest = { started: new Date().toISOString(), model, piVersion: execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(), base, sourceHashes, timeoutMs: 120000, expirySeconds: 180, prompt: 'Configure the Larch batch runner using our currently applicable remembered worker-count decision. Use the write tool to create worker-plan.json containing only a JSON object with the workers number. If no applicable decision is available, do not create a file and reply MISSING. Do not choose a default or infer it from an expired decision.' };
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const results = [];
const parse = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
async function run(id, prompt, memoryDir, { capture = false, disabled = false } = {}) {
  await rm(join(cwd, 'worker-plan.json'), { force: true });
  const args = ['-ne', '-ns', '-np', '-nc', '--no-mcp', ...(capture ? ['--no-tools'] : ['--tools', 'write']), '-e', join(root, 'index.ts'), '--memory-dir', memoryDir, '--memory-mode', 'inject', '--session-dir', join(base, 'sessions'), '--model', model, '--thinking', 'low', '--mode', 'json', '-p', prompt];
  const started = Date.now();
  const execution = await new Promise(resolveRun => {
    const child = spawn('pi', args, { cwd, env: { ...process.env, PI_MEMORY_DISABLED: disabled ? '1' : '0', PI_MEMORY_CAPTURE: capture ? '1' : '0', PI_MEMORY_MODEL: model, PI_MEMORY_DREAM: '0', PI_MEMORY_DIGEST_BUDGET: '0', PI_MEMORY_RETRIEVAL_MODEL: 'off', PI_MEMORY_TRACE: join(output, `${id}.trace.jsonl`) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, forceKill;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); forceKill = setTimeout(() => child.kill('SIGKILL'), 2000); }, manifest.timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', error => { stderr += error.message; });
    child.on('close', code => { clearTimeout(timeout); clearTimeout(forceKill); resolveRun({ stdout, stderr, code, timedOut }); });
  });
  await writeFile(join(output, `${id}.events.jsonl`), execution.stdout);
  await writeFile(join(output, `${id}.stderr.txt`), execution.stderr);
  const events = parse(execution.stdout);
  const final = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
  let plan;
  try { plan = JSON.parse(await readFile(join(cwd, 'worker-plan.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const writes = events.filter(event => event.type === 'tool_execution_start' && event.toolName === 'write').map(event => event.args);
  const result = { id, args, prompt, started: new Date(started).toISOString(), ended: new Date().toISOString(), elapsedMs: Date.now() - started, code: execution.code, timedOut: execution.timedOut, response: final?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n'), stopReason: final?.stopReason, writes, plan, errors: [] };
  if (execution.code !== 0 || execution.timedOut || final?.stopReason !== 'stop') result.errors.push('Pi did not finish successfully');
  results.push(result);
  await writeFile(join(output, `${id}.result.json`), JSON.stringify(result, null, 2) + '\n');
  if (execution.timedOut) throw new Error(`${id} timed out`);
  return result;
}
async function inspect(dir) {
  const store = new MemoryStore(dir, resolveProjectKey(cwd));
  try { await store.initialize(); return store.list({ includeArchived: true }); } finally { store.close(); }
}
let expiresAt, failure;
try {
  await run('capture-default', 'Remember this durable project decision: the Larch batch runner uses 4 workers by default. A temporary worker-count override must not replace this durable default. Reply only ACK.', original, { capture: true });
  expiresAt = new Date(Date.now() + manifest.expirySeconds * 1000).toISOString();
  await run('capture-temporary', `Remember this temporary project decision: until ${expiresAt}, the Larch batch runner must use 1 worker. After that time, the temporary override expires and the existing durable worker-count default remains in force. Reply only ACK.`, original, { capture: true });
  const captured = await inspect(original);
  await writeFile(join(output, 'captured-store.json'), JSON.stringify(captured, null, 2) + '\n');
  const durable = captured.filter(item => item.status === 'active' && item.retention !== 'short' && /4/.test(item.body));
  const temporary = captured.filter(item => item.status === 'active' && item.retention === 'short' && item.expiresAt === expiresAt && /1/.test(item.body));
  if (!durable.length || !temporary.length) throw new Error('Automatic capture did not preserve both grounded durable and expiring decisions');
  for (const arm of ['long', 'short', 'off']) await cp(original, join(base, arm), { recursive: true });
  const short = new MemoryStore(join(base, 'short'), resolveProjectKey(cwd));
  try { await short.initialize(); for (const item of short.list()) if (item.retention !== 'short') await short.archive(item.id); } finally { short.close(); }
  for (const phase of ['before', 'after']) {
    if (phase === 'after') while (Date.now() < Date.parse(expiresAt) + 1000) await delay(Math.min(10000, Date.parse(expiresAt) + 1000 - Date.now()));
    for (const arm of ['long', 'short', 'off']) {
      const result = await run(`${phase}-${arm}`, manifest.prompt, join(base, arm), { disabled: arm === 'off' });
      const expectedWorkers = arm === 'off' || (arm === 'short' && phase === 'after') ? null : phase === 'before' ? 1 : 4;
      result.expectedWorkers = expectedWorkers;
      if (phase === 'before' && Date.parse(result.ended) >= Date.parse(expiresAt)) result.errors.push('Before-expiry session did not finish before expiry');
      if (expectedWorkers === null ? result.plan !== undefined || result.writes.length !== 0 || !result.response?.includes('MISSING') : result.plan?.workers !== expectedWorkers || result.writes.length !== 1 || Object.keys(result.plan).length !== 1) result.errors.push('Actual file action did not match the grounded current policy');
      await writeFile(join(output, `${result.id}.result.json`), JSON.stringify(result, null, 2) + '\n');
    }
  }
} catch (error) { failure = String(error); }
const sourceStable = JSON.stringify(sourceHashes) === JSON.stringify(await hashSources());
const summary = { completed: new Date().toISOString(), expiresAt, model, sourceStable, passed: !failure && sourceStable && results.length === 8 && results.every(result => !result.errors.length), failure, results, limitations: ['One synthetic policy, one repetition per arm; action effects verified from actual write-tool calls and files', 'Short arm is a clone of real captured history with durable records archived; it is a retention ablation, not a conversational rolling-window implementation', 'Model capture is enabled only for the two source sessions; action sessions cannot learn their own answers', 'No fake clock, future hint, or refreshed policy appears in the action prompts'] };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ passed: summary.passed, sourceStable, failure, expiresAt, results: results.map(({ id, plan, expectedWorkers, errors }) => ({ id, plan, expectedWorkers, errors })) }));
if (!summary.passed) process.exitCode = 1;
