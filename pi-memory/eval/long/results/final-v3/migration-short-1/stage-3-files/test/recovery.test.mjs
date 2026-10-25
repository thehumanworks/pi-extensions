import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('recovers truncated JSON using the output-side backup and durable defaults', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(directory, 'repair-source.json');
    const output = join(directory, 'repair-output.json');
    const backup = join(directory, 'backups', 'source.json');
    const corrupt = '{"version":';
    const original = JSON.stringify({ version: 1, timeoutSeconds: 3, flags: { ready: true }, extra: 'preserve' });
    await mkdir(join(directory, 'backups'));
    await writeFile(input, corrupt);
    await writeFile(backup, original);
    const result = await migrateFile(input, output);
    assert.deepEqual(result, {
      version: 3, timeoutMs: 3000, features: ['ready'], extra: 'preserve',
      region: 'eu-west-1', retry: { backoff: 'exponential', maxAttempts: 5 },
    });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    assert.equal(await readFile(input, 'utf8'), corrupt);
    assert.equal(await readFile(backup, 'utf8'), original);
    await writeFile(backup, '{');
    await assert.rejects(migrateFile(input, output), SyntaxError);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
