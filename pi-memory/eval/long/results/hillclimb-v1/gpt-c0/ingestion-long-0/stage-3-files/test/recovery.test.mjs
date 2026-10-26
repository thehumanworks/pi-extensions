import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

for (const corrupt of ['{"nextLine":', 'null', '{"nextLine":-1}']) {
  test(`recovery preserves output and checkpoint evidence: ${corrupt}`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(dir, 'input.ndjson');
      const outputPath = join(dir, 'output.ndjson');
      const checkpointPath = join(dir, 'checkpoint.json');
      const records = [
        { tenant: 'a', seq: 1 }, { tenant: 'b', seq: 1 },
        ...[2, 3, 4, 5].map(seq => ({ tenant: 'a', seq })),
      ];
      const original = JSON.stringify(records[0]);
      await writeFile(inputPath, records.map(JSON.stringify).join('\n') + '\n');
      await writeFile(outputPath, original);
      await writeFile(checkpointPath, corrupt);
      const result = await processBatch({ inputPath, outputPath, checkpointPath });
      assert.deepEqual(result, { accepted: 4, rejected: 0, duplicates: 1, nextLine: 5 });
      assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), corrupt);
      const output = await readFile(outputPath, 'utf8');
      assert.ok(output.startsWith(original + '\n'));
      assert.deepEqual(output.trim().split('\n').map(JSON.parse), records.slice(0, 5));
      assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 5 });
      assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('existing recovery evidence is never overwritten', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const checkpointPath = join(dir, 'checkpoint.json');
    await mkdir(join(dir, 'recovery'));
    await writeFile(join(dir, 'recovery/checkpoint.bad.json'), 'prior evidence');
    await writeFile(checkpointPath, 'broken');
    await writeFile(outputPath, 'existing output');
    await assert.rejects(processBatch({ inputPath, outputPath, checkpointPath }), { code: 'EEXIST' });
    assert.equal(await readFile(checkpointPath, 'utf8'), 'broken');
    assert.equal(await readFile(outputPath, 'utf8'), 'existing output');
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), 'prior evidence');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
