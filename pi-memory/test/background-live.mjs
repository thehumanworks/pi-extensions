/** Installed-Pi RPC integration: ordinary turns schedule real background dreaming. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStore } from '../src/store.ts';
import { resolveProjectKey } from '../src/project.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'eval/results/background-live'));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Choose an empty output directory');
const base = await mkdtemp(join(tmpdir(), 'pi-memory-background-'));
const model = 'openai/gpt-6.1-sol';
const hashes = async () => Object.fromEntries(await Promise.all(['index.ts', ...['config', 'dream', 'scheduler', 'store', 'retrieve'].map(f => `src/${f}.ts`)].map(async f => [f, createHash('sha256').update(await readFile(join(root, f))).digest('hex')])));
const sourceHashes = await hashes();
const results = [];
async function json(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function poll(condition, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await condition(); if (result) return result; await delay(50); }
  throw new Error('Timed out waiting for RPC background state');
}
for (const scenario of ['completion', 'cancel-before-start']) {
  const cwd = join(base, scenario), memory = join(cwd, 'memory');
  await mkdir(join(cwd, '.pi'), { recursive: true });
  const idleDelayMs = scenario === 'completion' ? 1000 : 5000;
  await writeFile(join(cwd, '.pi/settings.json'), JSON.stringify({ memory: { capture: { enabled: false }, digest: { budgetTokens: 0 }, dream: { enabled: true, model, idleDelayMs, backoffMs: 5000 } } }));
  const key = resolveProjectKey(cwd), store = new MemoryStore(memory, key);
  await store.initialize();
  const shared = 'Every Larch staging operation requires the operator to inspect the complete preflight report, confirm passing results for all staged migration checks, and record the verification identifier before applying any changes. Production deployment is outside the scope of Larch staging procedures.';
  for (const [n, command] of ['larch verify alpha', 'larch verify beta', 'larch verify gamma'].entries()) await store.save({ title: `Larch staging ${['alpha', 'beta', 'gamma'][n]}`, body: `${shared} The service verification command is ${command}.`, keywords: ['larch', 'staging'], source: { session: 'synthetic-scheduler-fixture', entries: [`u${n}`], origin: 'user_statement' } });
  const originalIds = store.list().map(item => item.id); store.close();
  await writeFile(join(memory, `maintenance-${key}.json`), JSON.stringify({ sourceCount: 3, at: Date.now(), dreamPending: true }));
  const trace = join(output, `${scenario}.trace.jsonl`);
  const args = ['-ne', '-ns', '-np', '-nc', '--no-mcp', '--no-tools', '--no-session', '-e', join(root, 'index.ts'), '--memory-dir', memory, '--model', model, '--thinking', 'low', '--mode', 'rpc'];
  const child = spawn('pi', args, { cwd, env: { ...process.env, PI_MEMORY_DISABLED: '0', PI_MEMORY_CAPTURE: '0', PI_MEMORY_DREAM: '1', PI_MEMORY_TRACE: trace }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', partial = '', closed = false;
  const events = [];
  child.stdout.on('data', chunk => {
    stdout += chunk; partial += chunk;
    let end; while ((end = partial.indexOf('\n')) >= 0) { const line = partial.slice(0, end); partial = partial.slice(end + 1); try { events.push({ at: new Date().toISOString(), ...JSON.parse(line) }); } catch {} }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const close = new Promise(resolveClose => child.on('close', code => { closed = true; resolveClose(code); }));
  const command = async (type, data = {}) => {
    const id = `${type}-${events.length}-${Date.now()}`;
    child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n');
    const response = await poll(() => { if (closed) throw new Error('RPC process exited'); return events.find(event => event.type === 'response' && event.id === id); });
    if (!response.success) throw new Error(response.error || 'RPC command failed');
    return response;
  };
  const record = { scenario, model, idleDelayMs, args, errors: [] };
  try {
    await command('get_state');
    await command('prompt', { message: 'Reply only ACK.' });
    const settled = await poll(() => events.find(event => event.type === 'agent_settled'));
    record.settledAt = settled.at;
    if (scenario === 'completion') {
      const dream = await poll(async () => {
        let lines; try { lines = await readFile(trace, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        return lines.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(event => event.event === 'dream');
      });
      record.observedAt = new Date().toISOString(); record.dream = dream;
      if (dream.status !== 'completed' || !dream.savedIds.length || dream.usage.input + dream.usage.cacheRead <= 0) record.errors.push('Automatic dreaming did not save a parent with actual provider usage');
      await poll(async () => !(await json(join(memory, `maintenance-${key}.json`))).dreamPending, 5000);
      const check = new MemoryStore(memory, key); try { await check.initialize(); record.items = check.list(); if (!originalIds.every(id => record.items.some(item => item.id === id))) record.errors.push('Dream removed original evidence'); } finally { check.close(); }
      if (Date.parse(record.observedAt) - Date.parse(record.settledAt) < idleDelayMs) record.errors.push('Dream completed before configured idle delay');
      await command('prompt', { message: 'Reply only READY.' });
      await poll(() => events.filter(event => event.type === 'agent_settled').length === 2);
      await delay(1500);
      const calls = (await readFile(trace, 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).filter(event => event.event === 'dream');
      record.completedDreamCalls = calls.length;
      if (calls.length !== 1) record.errors.push('Ordinary follow-up repeated completed background work');
    } else {
      // A new session must dispose the scheduled timer before its 5-second delay.
      await command('new_session');
      await delay(idleDelayMs + 500);
      const state = await json(join(memory, 'dream', `scheduler-${key}.json`), null);
      record.scheduler = state;
      if (state !== null) record.errors.push('Disposed session started background inference');
    }
  } catch (error) { record.errors.push(String(error)); }
  finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGTERM'), 2000);
    await close; clearTimeout(kill);
    await writeFile(join(output, `${scenario}.events.jsonl`), stdout);
    await writeFile(join(output, `${scenario}.timed-events.json`), JSON.stringify(events, null, 2) + '\n');
    await writeFile(join(output, `${scenario}.stderr.txt`), stderr);
    const finals = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant');
    record.finalResponses = finals.map(e => e.message.content?.filter(b => b.type === 'text').map(b => b.text).join('\n'));
    if (finals.some(e => e.message.stopReason !== 'stop') || !/^ACK\.?$/.test(record.finalResponses[0] || '') || (scenario === 'completion' && !/^READY\.?$/.test(record.finalResponses[1] || ''))) record.errors.push('Foreground request did not complete as requested');
    results.push(record);
  }
}
const sourceStable = JSON.stringify(sourceHashes) === JSON.stringify(await hashes());
const summary = { model, base, sourceHashes, sourceStable, passed: sourceStable && results.every(result => !result.errors.length), results, limitations: ['Synthetic canonical sources and persisted pending trigger isolate scheduler integration; automatic source capture and threshold detection are tested separately', 'Cancellation case cancels before inference, while in-flight cancellation and durable retry are covered by scheduler unit tests', 'This measures execution and provider usage, not semantic quality or user-perceived latency under load'] };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ passed: summary.passed, sourceStable, results: results.map(({ scenario, errors, dream, finalResponses }) => ({ scenario, errors, savedParents: dream?.savedIds.length, usage: dream?.usage, finalResponses })) }));
if (!summary.passed) process.exitCode = 1;
