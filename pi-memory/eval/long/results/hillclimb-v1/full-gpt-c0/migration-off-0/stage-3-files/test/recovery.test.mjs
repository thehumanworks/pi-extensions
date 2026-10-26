import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('recovers malformed source from the durable backup without altering evidence', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(directory, 'source.json');
    const output = join(directory, 'output.json');
    const backup = join(directory, 'backups', 'source.json');
    const corrupt = '{"version":';
    const original = '{"version":1,"timeoutSeconds":3,"flags":{"ready":true},"extra":"preserve"}';
    await mkdir(join(directory, 'backups'));
    await writeFile(input, corrupt);
    await writeFile(backup, original);
    const result = await migrateFile(input, output);
    assert.equal(result.region, 'us-east-1');
    assert.equal(result.timeoutMs, 3000);
    assert.deepEqual(result.features, ['ready']);
    assert.equal(result.extra, 'preserve');
    assert.equal(await readFile(input, 'utf8'), corrupt);
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backs up original source before in-place migration', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(directory, 'source.json');
    const original = '{"version":2,"extra":true}';
    await writeFile(input, original);
    await migrateFile(input, input);
    await migrateFile(input, input);
    assert.equal(await readFile(join(directory, 'backups', 'source.json'), 'utf8'), original);
    assert.equal(JSON.parse(await readFile(input, 'utf8')).version, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
