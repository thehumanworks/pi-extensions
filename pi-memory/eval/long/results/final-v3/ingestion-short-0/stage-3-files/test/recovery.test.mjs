import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('corrupt checkpoints preserve evidence and replay without losing output', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const checkpointPath = join(dir, 'checkpoint.json');
    const records = Array.from({ length: 7 }, (_, seq) => JSON.stringify({ tenant: 'a', seq }));
    const existing = records[0]; // Exercise a durable record without a trailing newline.
    await writeFile(inputPath, records.join('\n') + '\n');
    await writeFile(outputPath, existing);
    await writeFile(checkpointPath, '{"nextLine":');
    await writeFile(`${checkpointPath}.corrupt`, 'earlier evidence');
    assert.deepEqual(await processBatch({ inputPath, outputPath, checkpointPath }), {
      accepted: 4, rejected: 0, duplicates: 1, nextLine: 5,
    });
    assert.equal(await readFile(outputPath, 'utf8'), records.slice(0, 5).join('\n') + '\n');
    assert.equal(await readFile(`${checkpointPath}.corrupt`, 'utf8'), 'earlier evidence');
    const backup = (await readdir(dir)).find(name => name.startsWith('checkpoint.json.corrupt.'));
    assert.ok(backup);
    assert.equal(await readFile(join(dir, backup), 'utf8'), '{"nextLine":');
    assert.deepEqual(await processBatch({ inputPath, outputPath, checkpointPath }), {
      accepted: 2, rejected: 0, duplicates: 0, nextLine: 7,
    });
    assert.equal(await readFile(outputPath, 'utf8'), records.join('\n') + '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const corrupt of ['null', '{"nextLine":-1}', '{"nextLine":"2"}']) {
  test(`invalid checkpoint recovers: ${corrupt}`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(dir, 'in');
      const outputPath = join(dir, 'out');
      const checkpointPath = join(dir, 'cp');
      await writeFile(inputPath, '{"tenant":"a","seq":0}\n');
      await writeFile(checkpointPath, corrupt);
      const result = await processBatch({ inputPath, outputPath, checkpointPath });
      assert.equal(result.accepted, 1);
      assert.equal(await readFile(`${checkpointPath}.corrupt`, 'utf8'), corrupt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
