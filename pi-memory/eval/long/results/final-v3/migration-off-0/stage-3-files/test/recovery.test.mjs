import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('recovers malformed input from output-adjacent backup without changing evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(dir, 'input.json');
    const output = join(dir, 'output.json');
    const backup = join(dir, 'backups/source.json');
    await mkdir(join(dir, 'backups'));
    const corrupt = '{"version":';
    const original = JSON.stringify({ version: 1, timeoutSeconds: 3, flags: { ready: true }, extra: 'preserve' });
    await writeFile(input, corrupt);
    await writeFile(backup, original);
    const result = await migrateFile(input, output);
    assert.deepEqual(result, { version: 3, timeoutMs: 3000, features: ['ready'], extra: 'preserve' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    assert.equal(await readFile(input, 'utf8'), corrupt);
    assert.equal(await readFile(backup, 'utf8'), original);
    // Valid but unsupported data must not silently fall back to the backup.
    await writeFile(input, '{"version":99}');
    await assert.rejects(migrateFile(input, output), /Unsupported configuration version/);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
