import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('corrupt checkpoint preserves evidence and output, replays tenant identities, and quarantines invalid lines', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const checkpointPath = join(dir, 'checkpoint.json');
    const original = '{"tenant":"a","seq":1,"value":"original"}';
    const records = [original, 'not json', '{"tenant":"b","seq":1}',
      '{"tenant":"a","seq":2}', '{"tenant":"a","seq":3}',
      '{"tenant":"a","seq":4}', '{"tenant":"a","seq":5}'];
    await writeFile(inputPath, records.join('\n') + '\n');
    await writeFile(outputPath, original);
    await writeFile(checkpointPath, '{"nextLine":');
    const result = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.deepEqual(result, { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), '{"nextLine":');
    assert.equal(await readFile(outputPath, 'utf8'), [original, ...records.slice(2, 6)].join('\n') + '\n');
    assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'not json\n');
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 6 });
    assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 1);
    assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
