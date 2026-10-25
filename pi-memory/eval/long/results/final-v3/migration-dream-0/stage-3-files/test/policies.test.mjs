import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

async function workspace(run) {
  const dir = await mkdtemp(join(process.cwd(), '.policies-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('defaults, unknown data, exact backup and invocation-only override', () => workspace(async dir => {
  const input = join(dir, 'input.json');
  const raw = ' {"version":1,"name":"customer","custom":{"keep":true}}\n';
  await writeFile(input, raw);
  const output = join(dir, 'output.json');
  const overridden = await migrateFile(input, output, { region: 'temporary' });
  assert.equal(overridden.region, 'temporary');
  const result = await migrateFile(input, output);
  assert.equal(result.region, 'eu-north-7');
  assert.deepEqual(result.retry, { maxAttempts: 5, backoffMs: 125 });
  assert.deepEqual(result.legacy, { custom: { keep: true } });
  assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), raw);
}));

test('v3 stays semantically unchanged except explicit region', () => workspace(async dir => {
  const input = join(dir, 'input.json');
  const source = { version: 3, features: ['z', 'a'], custom: 17 };
  await writeFile(input, JSON.stringify(source));
  assert.deepEqual(await migrateFile(input, join(dir, 'out.json')), source);
  assert.deepEqual(await migrateFile(input, join(dir, 'out.json'), { region: 'override' }), { ...source, region: 'override' });
}));

test('invalid recovery backup leaves damaged input untouched', () => workspace(async dir => {
  const input = join(dir, 'input.json');
  await writeFile(input, '{"version":');
  await mkdir(join(dir, 'backups'));
  await writeFile(join(dir, 'backups/source.json'), '{');
  await assert.rejects(migrateFile(input, join(dir, 'out.json')), SyntaxError);
  assert.equal(await readFile(input, 'utf8'), '{"version":');
  assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), '{');
}));

test('migration cannot consume its recovery backup', () => workspace(async dir => {
  const input = join(dir, 'input.json');
  await writeFile(input, '{"version":1}');
  await mkdir(join(dir, 'backups'));
  const backup = join(dir, 'backups/source.json');
  await writeFile(backup, '{"version":1,"custom":true}');
  await assert.rejects(migrateFile(backup, join(dir, 'out.json')), /must not consume/);
  assert.equal(await readFile(backup, 'utf8'), '{"version":1,"custom":true}');
}));

test('existing recovery evidence is never overwritten', () => workspace(async dir => {
  const input = join(dir, 'input.json');
  await writeFile(input, '{"version":');
  await mkdir(join(dir, 'backups'));
  await writeFile(join(dir, 'backups/source.json'), '{"version":1}');
  await mkdir(join(dir, 'recovery'));
  const evidence = join(dir, 'recovery/source.bad.json');
  await writeFile(evidence, 'earlier evidence');
  await assert.rejects(migrateFile(input, join(dir, 'out.json')), { code: 'EEXIST' });
  assert.equal(await readFile(evidence, 'utf8'), 'earlier evidence');
  assert.equal(await readFile(input, 'utf8'), '{"version":');
}));

test('recovers damaged source without changing backup', () => workspace(async dir => {
  const input = join(dir, 'input.json');
  const damaged = '{"version":';
  const backup = '{"version":1,"custom":{"original":true}}';
  await writeFile(input, damaged);
  await mkdir(join(dir, 'backups'));
  await writeFile(join(dir, 'backups/source.json'), backup);
  const result = await migrateFile(input, join(dir, 'out.json'));
  assert.deepEqual(result.legacy.custom, { original: true });
  assert.equal(await readFile(join(dir, 'backups/source.json'), 'utf8'), backup);
  assert.equal(await readFile(join(dir, 'recovery/source.bad.json'), 'utf8'), damaged);
  await assert.rejects(readFile(input), { code: 'ENOENT' });
}));
