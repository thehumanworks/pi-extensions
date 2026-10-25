import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

test('defaults, exact backup, invocation override and v3 preservation', async () => {
  const d = await mkdtemp(join(process.cwd(), '.policies-'));
  try {
    const input = join(d, 'input.json'), output = join(d, 'output.json');
    const source = '{ "version":1,"name":"customer","custom":{"keep":true} }\n';
    await writeFile(input, source);
    const result = await migrateFile(input, output);
    assert.equal(result.region, 'eu-north-7');
    assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
    assert.deepEqual(result.legacy, { custom: { keep: true } });
    assert.equal(await readFile(join(d, 'backups/source.json'), 'utf8'), source);
    assert.equal((await migrateFile(input, output, { region: 'temporary' })).region, 'temporary');
    assert.equal((await migrateFile(input, output)).region, 'eu-north-7');
    const v3 = { version: 3, custom: true, features: ['z', 'a'] };
    await writeFile(input, JSON.stringify(v3));
    assert.deepEqual(await migrateFile(input, output), v3);
    assert.deepEqual(await migrateFile(input, output, { region: 'explicit' }), { ...v3, region: 'explicit' });
    assert.equal(await readFile(join(d, 'backups/source.json'), 'utf8'), source);
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('truncated input recovers without altering backup', async () => {
  const d = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const input = join(d, 'input.json');
    await mkdir(join(d, 'backups'));
    const backup = '{"version":1,"custom":{"original":true}}\n';
    await writeFile(join(d, 'backups/source.json'), backup);
    await writeFile(input, '{"version":');
    const result = await migrateFile(input, join(d, 'output.json'));
    assert.deepEqual(result.legacy, { custom: { original: true } });
    assert.equal(await readFile(join(d, 'backups/source.json'), 'utf8'), backup);
    assert.equal(await readFile(join(d, 'recovery/source.bad.json'), 'utf8'), '{"version":');
    await assert.rejects(readFile(input), { code: 'ENOENT' });
  } finally { await rm(d, { recursive: true, force: true }); }
});
