import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

for (const corrupt of ['{"nextLine":', '{"nextLine":-1}', 'null']) {
  test(`recover checkpoint ${corrupt} without losing output`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(dir, 'input.ndjson');
      const outputPath = join(dir, 'output.ndjson');
      const checkpointPath = join(dir, 'checkpoint.json');
      const records = [
        '{"tenant":"a","seq":1,"value":"existing"}',
        '{"tenant":"b","seq":1,"value":"other tenant"}',
        '{"tenant":"a","seq":2}',
        '{"tenant":"a","seq":3}',
        '{"tenant":"a","seq":4}',
        '{"tenant":"a","seq":5}',
      ];
      await writeFile(inputPath, [records[0], 'malformed', ...records.slice(1)].join('\n') + '\n');
      await writeFile(outputPath, records[0]);
      await writeFile(checkpointPath, corrupt);
      const report = await processBatch({ inputPath, outputPath, checkpointPath });
      assert.deepEqual(report, { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
      assert.equal(await readFile(outputPath, 'utf8'), records.slice(0, 5).join('\n') + '\n');
      assert.equal(await readFile(join(dir, 'recovery', 'checkpoint.bad.json'), 'utf8'), corrupt);
      assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'malformed\n');
      assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 6 });
      assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 1);
      assert.equal(await readFile(outputPath, 'utf8'), records.join('\n') + '\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
