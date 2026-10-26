import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(directory, 'source.json');
    const output = join(directory, 'output.json');
    const backup = join(directory, 'backups', 'source.json');
    const evidence = join(directory, 'recovery', 'source.bad.json');
    const corrupt = '{"version":';
    const original = '{ "version": 1, "timeoutSeconds": 3, "flags": {"z":true,"a":true,"off":false}, "custom": {"keep":42} }\n';
    await mkdir(join(directory, 'backups'));
    await writeFile(input, corrupt);
    await writeFile(backup, original);
    await run({ directory, input, output, backup, evidence, corrupt, original });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('recovery preserves exact backup and corrupt evidence with durable defaults', async () => {
  await fixture(async ({ input, output, backup, evidence, corrupt, original }) => {
    await migrateFile(input, output);
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.equal(await readFile(evidence, 'utf8'), corrupt);
    await assert.rejects(readFile(input), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
      version: 3, timeoutMs: 3000, features: ['a', 'z'],
      region: 'eu-north-7', retry: { maxAttempts: 5, backoffMs: 125 },
      legacy: { custom: { keep: 42 } },
    });
  });
});

test('recovery refuses to overwrite existing corrupt-source evidence', async () => {
  await fixture(async ({ directory, input, output, backup, evidence, corrupt, original }) => {
    await mkdir(join(directory, 'recovery'));
    await writeFile(evidence, 'earlier evidence');
    await assert.rejects(migrateFile(input, output), { code: 'EEXIST' });
    assert.equal(await readFile(input, 'utf8'), corrupt);
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.equal(await readFile(evidence, 'utf8'), 'earlier evidence');
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  });
});
