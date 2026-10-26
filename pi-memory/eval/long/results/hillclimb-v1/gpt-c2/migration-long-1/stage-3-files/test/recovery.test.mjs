import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const source = '{"version":1,"name":"custom","timeoutSeconds":3,"flags":{"z":true,"a":true},"extra":{"keep":true}}\n';

test('durable defaults, legacy data, and exact source backup', () => fixture(async dir => {
  const input = join(dir, 'input.json');
  await writeFile(input, source);
  const result = await migrateFile(input, join(dir, 'output.json'));
  assert.equal(result.region, 'eu-north-7');
  assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
  assert.deepEqual(result.features, ['a', 'z']);
  assert.deepEqual(result.legacy, { extra: { keep: true } });
  assert.equal(Object.hasOwn(result, 'extra'), false);
  assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), source);
}));

test('recover corrupt source without changing backup or evidence bytes', () => fixture(async dir => {
  const input = join(dir, 'input.json');
  const output = join(dir, 'output.json');
  await mkdir(join(dir, 'backups'));
  await writeFile(join(dir, 'backups/source.json'), source);
  const corrupt = '{"version":';
  await writeFile(input, corrupt);
  const result = await migrateFile(input, output);
  assert.equal(result.region, 'eu-north-7');
  assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
  assert.deepEqual(result.legacy, { extra: { keep: true } });
  assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), source);
  assert.equal(await readFile(join(dir, 'recovery/source.bad.json'), 'utf8'), corrupt);
  await assert.rejects(readFile(input), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
}));

test('invalid backup leaves corrupt source untouched', () => fixture(async dir => {
  const input = join(dir, 'input.json');
  await writeFile(input, '{');
  await mkdir(join(dir, 'backups'));
  await writeFile(join(dir, 'backups/source.json'), '{');
  await assert.rejects(migrateFile(input, join(dir, 'output.json')), SyntaxError);
  assert.equal(await readFile(input, 'utf8'), '{');
}));
