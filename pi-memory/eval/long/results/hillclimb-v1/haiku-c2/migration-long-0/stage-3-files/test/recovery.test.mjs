import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('truncated source recovers from the backup and keeps the corrupt bytes as evidence', async () => {
  const d = await mkdtemp(join(process.cwd(), '.visible-'));
  try {
    const input = join(d, 'source.json');
    const output = join(d, 'out.json');
    const backupPath = join(d, 'backups', 'source.json');
    const backup = '{"version":1,"name":"recovery-fixture","timeoutSeconds":3,"flags":{"ready":true},"extra":"preserve"}';
    const truncated = '{"version":';
    await mkdir(join(d, 'backups'), { recursive: true });
    await writeFile(backupPath, backup);
    await writeFile(input, truncated);

    const value = await migrateFile(input, output);

    assert.equal(value.version, 3);
    assert.equal(value.timeoutMs, 3000);
    assert.deepEqual(value.features, ['ready']);
    assert.equal(value.region, 'eu-north-7');
    assert.deepEqual(value.retry, { backoffMs: 125, maxAttempts: 5 });
    assert.deepEqual(value.legacy, { extra: 'preserve' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), value);
    assert.equal(await readFile(backupPath, 'utf8'), backup);
    assert.equal(await readFile(join(d, 'recovery', 'source.bad.json'), 'utf8'), truncated);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
