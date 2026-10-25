import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

for (const corrupt of ['{"nextLine":', 'null', '{"nextLine":-1}']) {
  test(`recovers checkpoint ${corrupt} without losing output or evidence`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(dir, 'input.ndjson');
      const outputPath = join(dir, 'output.ndjson');
      const checkpointPath = join(dir, 'checkpoint.json');
      const first = '{"tenant":"a","seq":0,"value":"original"}';
      const second = '{"tenant":"a","seq":1}';
      await writeFile(inputPath, `${first}\n${second}\n`);
      await writeFile(outputPath, first);
      await writeFile(checkpointPath, corrupt);
      await writeFile(`${checkpointPath}.corrupt`, 'older evidence');
      const report = await processBatch({ inputPath, outputPath, checkpointPath });
      assert.deepEqual(report, { accepted: 1, rejected: 0, duplicates: 1, nextLine: 2 });
      assert.equal(await readFile(outputPath, 'utf8'), `${first}\n${second}\n`);
      assert.equal(await readFile(`${checkpointPath}.corrupt`, 'utf8'), 'older evidence');
      const backups = (await readdir(dir)).filter(name => name.endsWith('.corrupt') && name !== 'checkpoint.json.corrupt');
      assert.equal(backups.length, 1);
      assert.equal(await readFile(join(dir, backups[0]), 'utf8'), corrupt);
      assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 2 });
      assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 0);
      assert.equal(await readFile(outputPath, 'utf8'), `${first}\n${second}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
