import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('recovers truncated input while preserving backup and corrupt evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'source.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups/source.json');
    const corrupt = '{"version":';
    const original = JSON.stringify({ version: 1, timeoutSeconds: 3, flags: { ready: true }, extra: 'preserve' });
    await mkdir(join(dir, 'backups'));
    await writeFile(input, corrupt);
    await writeFile(backup, original);
    for (let run = 0; run < 2; run++) {
      const result = await migrateFile(input, output);
      assert.equal(result.region, 'us-east-1');
      assert.deepEqual(result.retry, { backoffMs: 1000, maxAttempts: 5 });
      assert.equal(result.timeoutMs, 3000);
      assert.deepEqual(result.features, ['ready']);
      assert.equal(result.extra, 'preserve');
      assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
      assert.equal(await readFile(input, 'utf8'), corrupt);
      assert.equal(await readFile(backup, 'utf8'), original);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backs up original input rather than a previous output', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'source.json');
    const output = join(dir, 'output.json');
    const original = '{"version":1,"extra":"keep"}';
    await writeFile(input, original);
    await writeFile(output, '{"version":3}');
    await migrateFile(input, output);
    assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
