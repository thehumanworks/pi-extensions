import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    await mkdir(join(dir, 'backups'));
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('recovers using durable defaults and preserves backup and corrupt evidence', () => fixture(async dir => {
  const input = join(dir, 'input.json');
  const output = join(dir, 'output.json');
  const backup = join(dir, 'backups/source.json');
  const bytes = '{"version":1,"custom":{"keep":true}}\n';
  await writeFile(backup, bytes);
  await writeFile(input, '{"version":');
  const result = await migrateFile(input, output);
  assert.equal(result.region, 'eu-north-7');
  assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
  assert.deepEqual(result.legacy, { custom: { keep: true } });
  assert.equal(await readFile(backup, 'utf8'), bytes);
  assert.equal(await readFile(join(dir, 'recovery/source.bad.json'), 'utf8'), '{"version":');
  await assert.rejects(readFile(input), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
}));

test('unmigratable backup leaves corrupt input intact', () => fixture(async dir => {
  const input = join(dir, 'input.json');
  await writeFile(input, '{');
  await writeFile(join(dir, 'backups/source.json'), '{"version":99}');
  await assert.rejects(migrateFile(input, join(dir, 'output.json')), /Unsupported/);
  assert.equal(await readFile(input, 'utf8'), '{');
}));

test('existing recovery evidence is never overwritten', () => fixture(async dir => {
  const input = join(dir, 'input.json');
  await writeFile(input, '{');
  await writeFile(join(dir, 'backups/source.json'), '{"version":1}');
  await mkdir(join(dir, 'recovery'));
  await writeFile(join(dir, 'recovery/source.bad.json'), 'older evidence');
  await assert.rejects(migrateFile(input, join(dir, 'output.json')), { code: 'EEXIST' });
  assert.equal(await readFile(input, 'utf8'), '{');
  assert.equal(await readFile(join(dir, 'recovery/source.bad.json'), 'utf8'), 'older evidence');
}));
