import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('recovery preserves backup and corrupt bytes and uses durable defaults', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'input.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups/source.json');
    const source = '{"version":1,"name":"saved","flags":{"z":true,"a":true},"custom":{"keep":true}}\n';
    await mkdir(join(dir, 'backups'));
    await writeFile(backup, source);
    await writeFile(input, '{"version":');
    const result = await migrateFile(input, output);
    assert.equal(result.region, 'eu-north-7');
    assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
    assert.deepEqual(result.features, ['a', 'z']);
    assert.deepEqual(result.legacy, { custom: { keep: true } });
    assert.equal(await readFile(backup, 'utf8'), source);
    assert.equal(await readFile(join(dir, 'recovery/source.bad.json'), 'utf8'), '{"version":');
    await assert.rejects(access(input), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normal migration backs up exact source', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.backup-'));
  try {
    const source = '{ "version": 1, "custom": 42 }\n';
    await writeFile(join(dir, 'input.json'), source);
    await migrateFile(join(dir, 'input.json'), join(dir, 'output.json'));
    assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
