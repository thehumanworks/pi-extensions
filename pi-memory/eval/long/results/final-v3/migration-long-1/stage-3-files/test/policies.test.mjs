import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

async function workspace(run) {
  const directory = await mkdtemp(join(process.cwd(), '.policy-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('defaults, customer data, exact backup, and invocation-only override', () => workspace(async d => {
  const input = join(d, 'input.json');
  const output = join(d, 'output.json');
  const source = '{ "version":1,"name":"customer","timeoutSeconds":2,"custom":{"keep":true}}\n';
  await writeFile(input, source);
  const result = await migrateFile(input, output, { region: 'temporary' });
  assert.equal(result.region, 'temporary');
  assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
  assert.deepEqual(result.legacy, { custom: { keep: true } });
  assert.equal(await readFile(join(d, 'backups/source.json'), 'utf8'), source);
  assert.equal((await migrateFile(input, output)).region, 'eu-north-7');
}));

test('v3 remains semantically unchanged', () => workspace(async d => {
  const config = { version: 3, region: 'original', retry: { maxAttempts: 2 }, custom: [1, 2] };
  const input = join(d, 'input.json');
  await writeFile(input, JSON.stringify(config));
  assert.deepEqual(await migrateFile(input, join(d, 'out.json')), config);
  assert.deepEqual(await migrateFile(input, join(d, 'out.json'), { region: 'override' }), { ...config, region: 'override' });
}));

test('recovery refuses to consume its backup', () => workspace(async d => {
  await mkdir(join(d, 'backups'));
  const backupPath = join(d, 'backups/source.json');
  const corrupt = '{"version":';
  await writeFile(backupPath, corrupt);
  await assert.rejects(migrateFile(backupPath, join(d, 'output.json')), /backup from itself/);
  assert.equal(await readFile(backupPath, 'utf8'), corrupt);
}));

test('truncated source is recovered without changing backup', () => workspace(async d => {
  await mkdir(join(d, 'backups'));
  const backup = '{"version":1,"custom":{"keep":true}}\n';
  const corrupt = '{"version":';
  const input = join(d, 'input.json');
  await writeFile(join(d, 'backups/source.json'), backup);
  await writeFile(input, corrupt);
  const result = await migrateFile(input, join(d, 'output.json'));
  assert.deepEqual(result.legacy, { custom: { keep: true } });
  assert.equal(await readFile(join(d, 'backups/source.json'), 'utf8'), backup);
  assert.equal(await readFile(join(d, 'recovery/source.bad.json'), 'utf8'), corrupt);
  await assert.rejects(readFile(input), { code: 'ENOENT' });
}));
