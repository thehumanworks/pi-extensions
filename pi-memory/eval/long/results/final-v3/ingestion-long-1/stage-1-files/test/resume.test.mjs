import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('quarantine, tenant identity, resume, and corrupt checkpoint recovery', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.resume-'));
  try {
    const options = { inputPath: join(dir, 'input.ndjson'), outputPath: join(dir, 'output.ndjson'), checkpointPath: join(dir, 'checkpoint.json') };
    const events = [
      '{"tenant":"a","seq":1,"value":"original"}',
      'not json',
      '{"tenant":"b","seq":1}',
      '{"tenant":"a","seq":1}',
      '{"tenant":"a","seq":2}',
      '{"tenant":"a","seq":3}',
      '{"tenant":"a","seq":4}',
    ];
    await writeFile(options.inputPath, events.join('\n') + '\n');
    assert.deepEqual(await processBatch(options), { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
    assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'not json\n');
    assert.deepEqual(await processBatch({ ...options, batchSize: 1 }), { accepted: 1, rejected: 0, duplicates: 0, nextLine: 7 });
    const output = await readFile(options.outputPath, 'utf8');
    await writeFile(options.checkpointPath, 'broken');
    assert.deepEqual(await processBatch(options), { accepted: 0, rejected: 1, duplicates: 6, nextLine: 7 });
    assert.equal(await readFile(options.outputPath, 'utf8'), output);
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), 'broken');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
