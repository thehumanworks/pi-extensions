import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

for (const corrupt of ['{"nextLine":', 'null', '{"nextLine":-1}', '{"nextLine":"1"}']) {
  test(`recover checkpoint ${corrupt} without changing existing output`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(dir, 'input.ndjson');
      const outputPath = join(dir, 'output.ndjson');
      const checkpointPath = join(dir, 'checkpoint.json');
      const first = '{"tenant":"a","seq":1,"value":"original"}';
      const second = '{"tenant":"b","seq":1}';
      await writeFile(inputPath, `${first}\n${second}\n${second}\n`);
      await writeFile(outputPath, first);
      await writeFile(checkpointPath, corrupt);
      const report = await processBatch({ inputPath, outputPath, checkpointPath });
      assert.deepEqual(report, { accepted: 1, rejected: 0, duplicates: 2, nextLine: 3 });
      assert.equal(await readFile(outputPath, 'utf8'), `${first}\n${second}\n`);
      const evidence = (await readdir(dir)).filter(name => name.startsWith('checkpoint.json.corrupt-'));
      assert.equal(evidence.length, 1);
      assert.equal(await readFile(join(dir, evidence[0]), 'utf8'), corrupt);
      assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 3 });
      assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 0);
      assert.equal(await readFile(outputPath, 'utf8'), `${first}\n${second}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
