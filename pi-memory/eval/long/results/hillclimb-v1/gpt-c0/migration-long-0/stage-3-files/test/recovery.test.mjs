import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('recovers corrupt JSON, preserves backup and evidence, and uses durable defaults', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'input.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups/source.json');
    const evidence = join(dir, 'recovery/source.bad.json');
    const corrupt = '{"version":1,';
    const valid = '{"version":1,"timeoutSeconds":3,"flags":{"ready":true},"extra":{"keep":true}}';
    await mkdir(join(dir, 'backups'));
    await writeFile(backup, valid);
    await writeFile(input, corrupt);
    const result = await migrateFile(input, output);
    assert.equal(result.version, 3);
    assert.equal(result.timeoutMs, 3000);
    assert.deepEqual(result.features, ['ready']);
    assert.deepEqual(result.extra, { keep: true });
    assert.equal(result.region, 'us-east-1');
    assert.deepEqual(result.retry, { backoffMs: 1000, maxAttempts: 5 });
    assert.equal(await readFile(backup, 'utf8'), valid);
    assert.equal(await readFile(evidence, 'utf8'), corrupt);
    await assert.rejects(access(input), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    await writeFile(input, '{');
    await assert.rejects(migrateFile(input, output), { code: 'EEXIST' });
    assert.equal(await readFile(input, 'utf8'), '{');
    assert.equal(await readFile(evidence, 'utf8'), corrupt);
    assert.equal(await readFile(backup, 'utf8'), valid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
