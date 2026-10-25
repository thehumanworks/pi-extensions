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
    const records = Array.from({ length: 6 }, (_, seq) => JSON.stringify({ tenant: 'a', seq }));
    const existing = `${records[0]}\n`;
    await writeFile(inputPath, `${records.join('\n')}\n`);
    await writeFile(outputPath, existing);
    await writeFile(`${checkpointPath}.corrupt`, 'older evidence');
    for (const corrupt of ['{"nextLine":', 'null', '{"nextLine":-1}']) {
      await writeFile(checkpointPath, corrupt);
      const report = await processBatch({ inputPath, outputPath, checkpointPath });
      assert.equal(report.accepted, corrupt === '{"nextLine":' ? 4 : corrupt === 'null' ? 1 : 0);
      const backups = (await readdir(dir)).filter(name => name.endsWith('.corrupt'));
      const contents = await Promise.all(backups.map(name => readFile(join(dir, name), 'utf8')));
      assert.ok(contents.includes(corrupt));
      assert.ok(contents.includes('older evidence'));
      assert.ok((await readFile(outputPath, 'utf8')).startsWith(existing));
    }
    assert.equal(await readFile(outputPath, 'utf8'), `${records.join('\n')}\n`);
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 6 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
