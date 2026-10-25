import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/store.ts';
import { resolveProjectKey } from '../src/project.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const output = resolve(process.argv[2] ?? join(repo, 'pi-memory/eval/results/packed-live'));
const temp = await mkdtemp(join(tmpdir(), 'pi-memory-package-'));
await mkdir(output, { recursive: true });
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--workspace', '@nothumanwork/pi-memory', '--pack-destination', temp, '--json'], { cwd: repo, encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(temp, pack.filename), '-C', temp]);
  const store = new MemoryStore(join(temp, 'memory'), resolveProjectKey(temp));
  await store.initialize();
  await store.save({ title: 'Larch staging verification', body: 'Use pnpm larch:verify for the Larch staging verification.', source: { session: 'synthetic-prior', entries: ['u1'], origin: 'user_statement' } });
  store.close();
  const args = ['-ne', '-e', join(temp, 'package/index.ts'), '-ns', '-np', '-nc', '--no-mcp', '--no-tools', '--no-session', '--memory-dir', join(temp, 'memory'), '--model', 'openai/gpt-6.1-sol', '--thinking', 'low', '-p', 'What is the Larch staging verification command? Return the command only.'];
  const outcome = await new Promise((resolveRun, reject) => {
    const child = spawn('pi', args, { cwd: temp, env: { ...process.env, PI_MEMORY_CAPTURE: '0', PI_MEMORY_RETRIEVAL_MODEL: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
  });
  await writeFile(join(output, 'result.json'), JSON.stringify({ package: pack.name, version: pack.version, shasum: pack.shasum, integrity: pack.integrity, files: pack.files.map(file => file.path), ...outcome }, null, 2) + '\n');
  assert.equal(outcome.code, 0);
  assert.match(outcome.stdout, /pnpm larch:verify/);
  assert.doesNotMatch(outcome.stderr, /Failed to load|extension error|Unknown option/i);
  console.log(`${pack.name}@${pack.version}: packed extension loaded without workspace node_modules and recalled the seeded command.`);
} finally { await rm(temp, { recursive: true, force: true }); }
