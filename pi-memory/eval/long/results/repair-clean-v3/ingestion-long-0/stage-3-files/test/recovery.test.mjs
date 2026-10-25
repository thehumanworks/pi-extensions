import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

for (const corrupt of ['{"nextLine":', 'null', '{"nextLine":-1}']) {
  test(`recover checkpoint ${corrupt} without losing output`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(dir, 'in.ndjson');
      const outputPath = join(dir, 'out.ndjson');
      const checkpointPath = join(dir, 'cp.json');
      const records = [
        { tenant: 'a', seq: 1 }, { tenant: 'b', seq: 1 },
        ...[2, 3, 4, 5].map(seq => ({ tenant: 'a', seq })),
      ];
      const original = JSON.stringify(records[0]);
      await writeFile(inputPath, records.map(JSON.stringify).join('\n') + '\n');
      await writeFile(outputPath, original);
      await writeFile(checkpointPath, corrupt);
      const report = await processBatch({ inputPath, outputPath, checkpointPath });
      assert.equal(report.accepted, 4);
      assert.equal(report.duplicates, 1);
      assert.equal(report.nextLine, 5);
      assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), corrupt);
      const output = await readFile(outputPath, 'utf8');
      assert.ok(output.startsWith(original + '\n'));
      assert.deepEqual(output.trim().split('\n').map(JSON.parse), records.slice(0, 5));
      await processBatch({ inputPath, outputPath, checkpointPath });
      assert.deepEqual((await readFile(outputPath, 'utf8')).trim().split('\n').map(JSON.parse), records);
      assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 6 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('existing recovery evidence is never overwritten', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const checkpointPath = join(dir, 'cp.json');
    const outputPath = join(dir, 'out.ndjson');
    await mkdir(join(dir, 'recovery'));
    await writeFile(join(dir, 'recovery/checkpoint.bad.json'), 'prior evidence');
    await writeFile(checkpointPath, '{');
    await writeFile(outputPath, 'existing output');
    await assert.rejects(processBatch({ inputPath: join(dir, 'in'), outputPath, checkpointPath }), { code: 'EEXIST' });
    assert.equal(await readFile(checkpointPath, 'utf8'), '{');
    assert.equal(await readFile(outputPath, 'utf8'), 'existing output');
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), 'prior evidence');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
