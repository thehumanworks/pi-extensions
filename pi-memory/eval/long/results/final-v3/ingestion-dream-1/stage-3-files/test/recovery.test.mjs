import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

for (const damaged of ['{"nextLine":', 'null', '{"nextLine":-1}']) {
  test(`recover checkpoint ${damaged} without losing output or evidence`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(dir, 'input.ndjson');
      const outputPath = join(dir, 'output.ndjson');
      const checkpointPath = join(dir, 'checkpoint.json');
      const recovery = join(dir, 'recovery');
      const existing = '{"tenant":"a","seq":1,"value":"original"}';
      const second = '{"tenant":"b","seq":1}';
      const third = '{"tenant":"a","seq":2}';
      await writeFile(outputPath, existing);
      await writeFile(inputPath, [existing, second, third].join('\n') + '\n');
      await writeFile(checkpointPath, damaged);
      await mkdir(recovery);
      await writeFile(join(recovery, 'checkpoint.bad.json'), 'older evidence');

      assert.deepEqual(await processBatch({ inputPath, outputPath, checkpointPath }), {
        accepted: 2, rejected: 0, duplicates: 1, nextLine: 3,
      });
      assert.equal(await readFile(outputPath, 'utf8'), [existing, second, third].join('\n') + '\n');
      assert.equal(await readFile(join(recovery, 'checkpoint.bad.json'), 'utf8'), damaged);
      const archived = (await readdir(recovery)).filter(name => name !== 'checkpoint.bad.json');
      assert.equal(archived.length, 1);
      assert.equal(await readFile(join(recovery, archived[0]), 'utf8'), 'older evidence');
      assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 3 });
      assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 0);
      assert.equal(await readFile(outputPath, 'utf8'), [existing, second, third].join('\n') + '\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('default batch counts four accepted records, not duplicates or rejections', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.batch-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const checkpointPath = join(dir, 'checkpoint.json');
    const records = Array.from({ length: 6 }, (_, seq) => JSON.stringify({ tenant: 'a', seq }));
    await writeFile(outputPath, records[0] + '\n');
    await writeFile(inputPath, [records[0], 'invalid', ...records.slice(1)].join('\n') + '\n');
    assert.deepEqual(await processBatch({ inputPath, outputPath, checkpointPath }), {
      accepted: 4, rejected: 1, duplicates: 1, nextLine: 6,
    });
    assert.equal(await readFile(outputPath, 'utf8'), records.slice(0, 5).join('\n') + '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
