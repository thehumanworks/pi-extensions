import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('default, identity, rejection, resume, and stale-checkpoint recovery', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.ingest-test-'));
  const paths = { inputPath: join(dir, 'input'), outputPath: join(dir, 'output'), checkpointPath: join(dir, 'checkpoint') };
  const records = [
    '{"tenant":"a","seq":0,"value":"original"}',
    'not json',
    '{"tenant":"b","seq":0}',
    '{"tenant":"a","seq":0,"value":"duplicate"}',
    '{}',
    '{"tenant":"a","seq":1}',
    '{"tenant":"a","seq":2}',
    '{"tenant":"a","seq":3}',
  ];
  try {
    await writeFile(paths.inputPath, records.join('\n') + '\n');
    assert.deepEqual(await processBatch(paths), { accepted: 4, rejected: 2, duplicates: 1, nextLine: 7 });
    assert.deepEqual(JSON.parse(await readFile(paths.checkpointPath, 'utf8')), { nextLine: 7 });
    assert.deepEqual(await processBatch({ ...paths, batchSize: 1 }), { accepted: 1, rejected: 0, duplicates: 0, nextLine: 8 });
    const output = await readFile(paths.outputPath, 'utf8');
    assert.equal(output, [records[0], records[2], records[5], records[6], records[7]].join('\n') + '\n');
    await writeFile(paths.checkpointPath, '{"nextLine":0}');
    assert.deepEqual(await processBatch(paths), { accepted: 0, rejected: 2, duplicates: 6, nextLine: 8 });
    assert.equal(await readFile(paths.outputPath, 'utf8'), output);
    assert.deepEqual(await processBatch(paths), { accepted: 0, rejected: 0, duplicates: 0, nextLine: 8 });
    await assert.rejects(processBatch({ ...paths, batchSize: 0 }), /batchSize/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
