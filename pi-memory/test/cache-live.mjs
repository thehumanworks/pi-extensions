import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/store.ts';
import { resolveProjectKey } from '../src/project.ts';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? join(pkg, 'eval/results/cache-live'));
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), 'pi-memory-cache-'));
try {
  for (const mode of ['inject', 'both']) {
    const root = join(workspace, mode), store = new MemoryStore(root, resolveProjectKey(workspace));
    await store.initialize();
    await store.save({ title: 'Aurora staging verification', body: 'Run aurora verify for staging verification.', retention: 'short', expiresAt: new Date(Date.now() + 3600000).toISOString(), source: { session: 'prior', entries: ['u1'], origin: 'user_statement' } });
    await store.save({ title: 'Cobalt database migration', body: 'Run cobalt migrate --check before applying database migrations.', source: { session: 'prior', entries: ['u2'], origin: 'user_statement' } });
    store.close();
    const payloadPath = join(output, `${mode}.requests.jsonl`);
    await writeFile(payloadPath, '');
    const args = ['-ne', '-e', join(pkg, 'index.ts'), '-e', join(pkg, 'test/fixtures/cache-probe.ts'), '-ns', '-np', '-nc', '--no-mcp', '--no-builtin-tools', '--no-session', '--memory-dir', root, '--memory-mode', mode, '--model', 'openai/gpt-6.1-sol', '--thinking', 'low', '--mode', 'json', '-p', 'What is the Aurora staging verification command? Use supplied recall and return only the command without tool calls.', 'Which Cobalt database migration command should run before applying? Use supplied recall and return only the command without tool calls.'];
    const outcome = await new Promise((resolveRun, reject) => {
      const child = spawn('pi', args, { cwd: workspace, env: { ...process.env, PI_MEMORY_CAPTURE: '0', PI_MEMORY_CACHE_PROBE: payloadPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
      const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
    });
    await writeFile(join(output, `${mode}.events.jsonl`), outcome.stdout);
    await writeFile(join(output, `${mode}.stderr.txt`), outcome.stderr);
    assert.equal(outcome.code, 0);
    const requests = (await readFile(payloadPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(requests.length, 2);
    const prior = requests[0].input ?? requests[0].messages, next = requests[1].input ?? requests[1].messages;
    assert.ok(Array.isArray(prior) && prior.length > 0);
    assert.match(JSON.stringify(prior), /active at retrieval/, 'The first request must exercise timestamped short-term recall');
    assert.deepEqual(next.slice(0, prior.length), prior);
    assert.deepEqual(requests[1].tools, requests[0].tools);
    assert.deepEqual(requests[1].instructions, requests[0].instructions);
    const declared = [...(requests[0].tools ?? []), ...prior.flatMap(entry => entry.type === 'additional_tools' ? entry.tools : [])];
    if (mode === 'both') assert.equal(declared.length, 6);
    const report = { mode, model: 'openai/gpt-6.1-sol', runtime: 'installed pi', requests: requests.length, declaredTools: declared.length, priorMessages: prior.length, nextMessages: next.length, prefixStable: true, toolsStable: true, systemStable: true };
    await writeFile(join(output, `${mode}.result.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
} finally { await rm(workspace, { recursive: true, force: true }); }
