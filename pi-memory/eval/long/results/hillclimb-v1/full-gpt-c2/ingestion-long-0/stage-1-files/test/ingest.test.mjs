import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

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
