import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
const tmpdir = () => process.cwd();
import { migrateFile } from '../src/migrate.mjs';

test('recovers damaged input without changing backup or losing custom data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-'));
  try {
    const input = join(dir, 'source.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups/source.json');
    const original = '{"version":1,"extra":{"keep":true},"flags":{"z":true,"a":true}}\n';
    await mkdir(join(dir, 'backups'));
    await writeFile(backup, original);
    await writeFile(input, '{"version":');
    const result = await migrateFile(input, output);
    assert.equal(result.region, 'eu-north-7');
    assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
    assert.deepEqual(result.features, ['a', 'z']);
    assert.deepEqual(result.legacy.extra, { keep: true });
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.equal(await readFile(join(dir, 'recovery/source.bad.json'), 'utf8'), '{"version":');
    await assert.rejects(access(input), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normal migration backs up exact source and retains explicit retry settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-'));
  try {
    const input = join(dir, 'source.json');
    const source = '{"version":1,"retry":{"maxAttempts":8},"custom":42}';
    await writeFile(input, source);
    const result = await migrateFile(input, join(dir, 'output.json'));
    assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), source);
    assert.deepEqual(result.retry, { maxAttempts: 8, backoffMs: 125 });
    assert.equal(result.legacy.custom, 42);
    assert.equal(await readFile(input, 'utf8'), source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
