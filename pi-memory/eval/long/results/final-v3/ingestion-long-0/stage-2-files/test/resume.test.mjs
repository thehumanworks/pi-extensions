import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('default batch, identity, quarantine, resume and corrupt recovery', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.resume-'));
  try {
    const options = {
      inputPath: join(dir, 'input.ndjson'),
      outputPath: join(dir, 'output.ndjson'),
      checkpointPath: join(dir, 'checkpoint.json'),
    };
    const records = [
      { tenant: 'a', seq: 1, extra: true },
      { tenant: 'b', seq: 1 },
      { tenant: 'a', seq: 2 },
      { tenant: 'a', seq: 3 },
      { tenant: 'a', seq: 4 },
    ];
    await writeFile(options.inputPath, [JSON.stringify(records[0]), 'broken',
      JSON.stringify(records[0]), ...records.slice(1).map(JSON.stringify)].join('\n'));
    assert.deepEqual(await processBatch(options),
      { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
    assert.deepEqual(await processBatch(options),
      { accepted: 1, rejected: 0, duplicates: 0, nextLine: 7 });
    assert.deepEqual(await processBatch(options),
      { accepted: 0, rejected: 0, duplicates: 0, nextLine: 7 });
    assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'broken\n');
    await writeFile(options.checkpointPath, 'corrupt');
    assert.deepEqual(await processBatch(options),
      { accepted: 0, rejected: 1, duplicates: 6, nextLine: 7 });
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), 'corrupt');
    assert.deepEqual((await readFile(options.outputPath, 'utf8')).trim().split('\n').map(JSON.parse), records);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
