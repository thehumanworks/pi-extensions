import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('recovers truncated input from durable backup without altering evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'broken.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups/source.json');
    const original = '{"version":1,"timeoutSeconds":3,"flags":{"ready":true},"extra":"keep"}';
    await mkdir(join(dir, 'backups'));
    await writeFile(backup, original);
    await writeFile(input, '{"version":');
    for (let run = 0; run < 2; run++) {
      const result = await migrateFile(input, output);
      assert.equal(result.version, 3);
      assert.equal(result.timeoutMs, 3000);
      assert.equal(result.region, 'us-east-1');
      assert.equal(result.retry.maxAttempts, 5);
      assert.equal(result.extra, 'keep');
      assert.deepEqual(result.features, ['ready']);
      assert.equal(await readFile(backup, 'utf8'), original);
      assert.equal(await readFile(input, 'utf8'), '{"version":');
      assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backs up the valid input rather than the previous output', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'input.json');
    const output = join(dir, 'output.json');
    const original = '{"version":1,"name":"original"}';
    await writeFile(input, original);
    await writeFile(output, '{"version":3}');
    await migrateFile(input, output);
    assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
