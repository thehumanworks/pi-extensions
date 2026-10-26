import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('malformed source recovers from destination backup without changing evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'broken.json');
    const output = join(dir, 'out.json');
    const backup = join(dir, 'backups', 'source.json');
    const damaged = '{"version":';
    const original = '{"version":1,"timeoutSeconds":3,"flags":{"ready":true},"extra":"preserve"}';
    await mkdir(join(dir, 'backups'));
    await writeFile(input, damaged);
    await writeFile(backup, original);
    const result = await migrateFile(input, output);
    assert.deepEqual(result, {
      version: 3, timeoutMs: 3000, features: ['ready'], extra: 'preserve',
      region: 'us-east-1', retry: { backoffMs: 1000, maxAttempts: 5 },
    });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    assert.equal(await readFile(input, 'utf8'), damaged);
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.deepEqual((await readdir(dir)).sort(), ['backups', 'broken.json', 'out.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid recovery data or unsupported source does not publish output', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'broken.json');
    const output = join(dir, 'out.json');
    const backup = join(dir, 'backups', 'source.json');
    await mkdir(join(dir, 'backups'));
    await writeFile(input, '{');
    await writeFile(backup, '{');
    await assert.rejects(migrateFile(input, output), SyntaxError);
    await writeFile(input, '{"version":2}');
    await writeFile(backup, '{"version":1}');
    await assert.rejects(migrateFile(input, output), /Unsupported config version: 2/);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
