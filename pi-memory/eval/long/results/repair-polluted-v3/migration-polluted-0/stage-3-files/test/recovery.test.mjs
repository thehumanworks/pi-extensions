import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('durable defaults and exact source backup', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.migration-'));
  try {
    const input = join(dir, 'in.json');
    const source = '{"version":1,"custom":{"keep":true},"flags":{"z":true,"a":true}}';
    await writeFile(input, source);
    const result = await migrateFile(input, join(dir, 'out.json'));
    assert.equal(result.region, 'eu-north-7');
    assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
    assert.deepEqual(result.features, ['a', 'z']);
    assert.deepEqual(result.legacy, { custom: { keep: true } });
    assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('truncated source recovery preserves backup and corrupt evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.migration-'));
  try {
    const input = join(dir, 'in.json');
    const backup = join(dir, 'backups/source.json');
    const source = '{"version":1,"extra":"preserve"}\n';
    await mkdir(join(dir, 'backups'));
    await writeFile(backup, source);
    await writeFile(input, '{"version":');
    const result = await migrateFile(input, join(dir, 'out.json'));
    assert.equal(result.legacy.extra, 'preserve');
    assert.equal(await readFile(backup, 'utf8'), source);
    assert.equal(await readFile(join(dir, 'recovery/source.bad.json'), 'utf8'), '{"version":');
    await assert.rejects(readFile(input), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')), result);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
