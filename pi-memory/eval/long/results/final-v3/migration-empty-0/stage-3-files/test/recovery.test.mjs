import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

 test('recover from agreed backup without altering evidence or applying diagnostic region', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'broken.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups', 'source.json');
    const damaged = '{"version":';
    const original = JSON.stringify({ version: 1, region: 'existing-region', retry: { backoff: 'existing-backoff' }, timeoutSeconds: 3, flags: { ready: true }, extra: 'preserve' });
    await mkdir(join(dir, 'backups'));
    await writeFile(input, damaged);
    await writeFile(backup, original);
    await writeFile(output, 'previous destination');
    const result = await migrateFile(input, output);
    assert.equal(result.version, 3);
    assert.equal(result.timeoutMs, 3000);
    assert.deepEqual(result.features, ['ready']);
    assert.equal(result.region, 'existing-region');
    assert.deepEqual(result.retry, { backoff: 'existing-backoff', maxAttempts: 5 });
    assert.equal(result.extra, 'preserve');
    assert.equal(await readFile(input, 'utf8'), damaged);
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    await migrateFile(input, output);
    assert.equal(await readFile(backup, 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid recovery backup leaves destination and evidence unchanged', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    await mkdir(join(dir, 'backups'));
    const input = join(dir, 'broken.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups', 'source.json');
    await writeFile(input, '{');
    await writeFile(backup, '{');
    await writeFile(output, 'keep');
    await assert.rejects(migrateFile(input, output), SyntaxError);
    assert.equal(await readFile(output, 'utf8'), 'keep');
    assert.equal(await readFile(input, 'utf8'), '{');
    assert.equal(await readFile(backup, 'utf8'), '{');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
