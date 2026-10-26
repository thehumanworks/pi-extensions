import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('durable defaults, source backup, and legacy preservation', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.migration-'));
  try {
    const input = join(dir, 'input.json');
    const source = '{"version":1,"custom":{"keep":true}}\n';
    await writeFile(input, source);
    const result = await migrateFile(input, join(dir, 'output.json'));
    assert.equal(result.region, 'eu-north-7');
    assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
    assert.deepEqual(result.legacy, { custom: { keep: true } });
    assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recover corrupt input without changing backup or losing evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.migration-'));
  try {
    const input = join(dir, 'input.json');
    const backup = join(dir, 'backups/source.json');
    const source = '{"version":1,"extra":"preserve"}\n';
    const corrupt = '{"version":';
    await mkdir(join(dir, 'backups'));
    await writeFile(backup, source);
    await writeFile(input, corrupt);
    const result = await migrateFile(input, join(dir, 'output.json'));
    assert.deepEqual(result.legacy, { extra: 'preserve' });
    assert.equal(await readFile(backup, 'utf8'), source);
    assert.equal(await readFile(join(dir, 'recovery/source.bad.json'), 'utf8'), corrupt);
    await assert.rejects(access(input), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'output.json'), 'utf8')), result);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
