import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('truncated checkpoint replays without replacing output or prior recovery evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.ingest-test-'));
  try {
    const options = { inputPath: join(dir, 'input'), outputPath: join(dir, 'output'), checkpointPath: join(dir, 'checkpoint') };
    const original = '{"tenant":"a","seq":1,"value":"original"}';
    const second = '{"tenant":"b","seq":1,"extra":true}';
    const third = '{"tenant":"a","seq":2}';
    await writeFile(options.outputPath, original);
    await writeFile(options.inputPath, [original, second, third].join('\n'));
    await writeFile(options.checkpointPath, '{"nextLine":');
    await mkdir(join(dir, 'recovery'));
    await writeFile(join(dir, 'recovery/checkpoint.bad.json'), 'earlier evidence');

    assert.deepEqual(await processBatch(options), { accepted: 2, rejected: 0, duplicates: 1, nextLine: 3 });
    assert.equal(await readFile(options.outputPath, 'utf8'), [original, second, third, ''].join('\n'));
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), '{"nextLine":');
    const archived = (await readdir(join(dir, 'recovery'))).filter(name => name !== 'checkpoint.bad.json');
    assert.equal(archived.length, 1);
    assert.equal(await readFile(join(dir, 'recovery', archived[0]), 'utf8'), 'earlier evidence');
    assert.deepEqual(JSON.parse(await readFile(options.checkpointPath, 'utf8')), { nextLine: 3 });
    assert.deepEqual(await processBatch(options), { accepted: 0, rejected: 0, duplicates: 0, nextLine: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('default, identity, quarantine, resume and corrupt-checkpoint recovery', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.ingest-test-'));
  try {
    const options = { inputPath: join(dir, 'input'), outputPath: join(dir, 'output'), checkpointPath: join(dir, 'checkpoint') };
    const records = [
      { tenant: 'a', seq: 1, extra: true },
      { tenant: 'b', seq: 1 },
      { tenant: 'a', seq: 2 },
      { tenant: 'a', seq: 3 },
      { tenant: 'a', seq: 4 },
    ];
    const raw = records.map(JSON.stringify);
    await writeFile(options.inputPath, [raw[0], 'broken', '{}', raw[0], ...raw.slice(1)].join('\n'));
    assert.deepEqual(await processBatch(options), { accepted: 4, rejected: 2, duplicates: 1, nextLine: 7 });
    assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'broken\n{}\n');
    assert.deepEqual(await processBatch({ ...options, batchSize: 1 }), { accepted: 1, rejected: 0, duplicates: 0, nextLine: 8 });
    assert.deepEqual(await processBatch(options), { accepted: 0, rejected: 0, duplicates: 0, nextLine: 8 });
    const output = await readFile(options.outputPath, 'utf8');
    assert.equal(output, raw.join('\n') + '\n');
    await writeFile(options.checkpointPath, 'corrupt');
    assert.deepEqual(await processBatch(options), { accepted: 0, rejected: 2, duplicates: 6, nextLine: 8 });
    assert.equal(await readFile(options.outputPath, 'utf8'), output);
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), 'corrupt');
    assert.deepEqual(JSON.parse(await readFile(options.checkpointPath, 'utf8')), { nextLine: 8 });
    await assert.rejects(processBatch({ ...options, batchSize: 0 }), /positive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
