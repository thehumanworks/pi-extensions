import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(process.cwd(), '.recovery-test-'));
  try {
    await mkdir(join(directory, 'backups'));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const original = '{"version":1,"name":"custom","timeoutSeconds":3,"flags":{"z":true,"a":true,"off":false},"extra":{"keep":true}}\n';
const corrupt = '{"version":';

test('recovers truncated input with durable defaults and preserves backup and evidence', async () => {
  await fixture(async directory => {
    const input = join(directory, 'source.json');
    const output = join(directory, 'output.json');
    const backup = join(directory, 'backups', 'source.json');
    await writeFile(input, corrupt);
    await writeFile(backup, original);
    const result = await migrateFile(input, output);
    assert.equal(result.version, 3);
    assert.equal(result.region, 'eu-north-7');
    assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
    assert.equal(result.timeoutMs, 3000);
    assert.deepEqual(result.features, ['a', 'z']);
    assert.deepEqual(result.legacy, { extra: { keep: true } });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    assert.equal(await readFile(backup, 'utf8'), original);
    assert.equal(await readFile(join(directory, 'recovery', 'source.bad.json'), 'utf8'), corrupt);
    await assert.rejects(readFile(input), { code: 'ENOENT' });
  });
});

test('invalid backup leaves corrupt source untouched', async () => {
  await fixture(async directory => {
    const input = join(directory, 'source.json');
    await writeFile(input, corrupt);
    await writeFile(join(directory, 'backups', 'source.json'), '{}');
    await assert.rejects(migrateFile(input, join(directory, 'output.json')), /Unsupported/);
    assert.equal(await readFile(input, 'utf8'), corrupt);
  });
});

test('recovery never overwrites existing corrupt-source evidence', async () => {
  await fixture(async directory => {
    const input = join(directory, 'source.json');
    const evidence = join(directory, 'recovery', 'source.bad.json');
    await writeFile(input, corrupt);
    await writeFile(join(directory, 'backups', 'source.json'), original);
    await mkdir(join(directory, 'recovery'));
    await writeFile(evidence, 'previous evidence');
    await assert.rejects(migrateFile(input, join(directory, 'output.json')), { code: 'EEXIST' });
    assert.equal(await readFile(input, 'utf8'), corrupt);
    assert.equal(await readFile(evidence, 'utf8'), 'previous evidence');
  });
});
