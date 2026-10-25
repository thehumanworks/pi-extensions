import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

 test('recovers malformed source from durable backup without changing evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'source.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups', 'source.json');
    const corrupt = '{"version":';
    const original = '{"version":1,"timeoutSeconds":3,"flags":{"ready":true},"extra":"preserve"}';
    await mkdir(join(dir, 'backups'));
    await writeFile(input, corrupt);
    await writeFile(backup, original);
    await writeFile(output, '{"version":3,"region":"test-local"}');
    const result = await migrateFile(input, output);
    assert.deepEqual(result, { version: 3, timeoutMs: 3000, features: ['ready'], extra: 'preserve', region: 'us-east-1', retries: 3 });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    assert.equal(await readFile(input, 'utf8'), corrupt);
    assert.equal(await readFile(backup, 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('creates an exclusive pre-migration source backup', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'input.json');
    const original = '{"version":1,"name":"original"}';
    await writeFile(input, original);
    await migrateFile(input, join(dir, 'output.json'));
    await writeFile(input, '{"version":2}');
    await migrateFile(input, join(dir, 'output.json'));
    assert.equal(await readFile(join(dir, 'backups', 'source.json'), 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
