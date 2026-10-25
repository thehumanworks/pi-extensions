import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    await mkdir(join(directory, 'backups'));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const corrupt = '{"version":';
const backup = '{"version":1,"timeoutSeconds":3,"flags":{"ready":true},"extra":{"keep":true}}\n';

test('recovers corrupt JSON while preserving backup, evidence, custom data and durable defaults', async () => {
  await fixture(async directory => {
    const input = join(directory, 'source.json');
    const output = join(directory, 'output.json');
    const backupPath = join(directory, 'backups/source.json');
    await writeFile(input, corrupt);
    await writeFile(backupPath, backup);
    const result = await migrateFile(input, output);
    assert.equal(await readFile(backupPath, 'utf8'), backup);
    assert.equal(await readFile(join(directory, 'recovery/source.bad.json'), 'utf8'), corrupt);
    await assert.rejects(access(input), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
    assert.equal(result.region, 'us-east-1');
    assert.deepEqual(result.retry, { backoffMs: 1000, maxAttempts: 5 });
    assert.deepEqual(result.extra, { keep: true });
    assert.equal(result.timeoutMs, 3000);
    assert.deepEqual(result.features, ['ready']);
  });
});

test('existing evidence is never overwritten', async () => {
  await fixture(async directory => {
    const input = join(directory, 'source.json');
    await writeFile(input, corrupt);
    await writeFile(join(directory, 'backups/source.json'), backup);
    await mkdir(join(directory, 'recovery'));
    const evidence = join(directory, 'recovery/source.bad.json');
    await writeFile(evidence, 'prior evidence');
    await assert.rejects(migrateFile(input, join(directory, 'output.json')), { code: 'EEXIST' });
    assert.equal(await readFile(evidence, 'utf8'), 'prior evidence');
    assert.equal(await readFile(input, 'utf8'), corrupt);
  });
});

test('invalid backup leaves corrupt source untouched', async () => {
  await fixture(async directory => {
    const input = join(directory, 'source.json');
    await writeFile(input, corrupt);
    await writeFile(join(directory, 'backups/source.json'), corrupt);
    await assert.rejects(migrateFile(input, join(directory, 'output.json')), SyntaxError);
    assert.equal(await readFile(input, 'utf8'), corrupt);
    await assert.rejects(access(join(directory, 'recovery/source.bad.json')), { code: 'ENOENT' });
  });
});
