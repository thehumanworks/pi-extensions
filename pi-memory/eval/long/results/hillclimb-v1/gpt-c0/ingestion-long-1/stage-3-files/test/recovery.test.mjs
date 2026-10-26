import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

for (const corrupt of ['{"nextLine":', 'null', '{"nextLine":-1}']) {
  test(`recovers checkpoint ${corrupt} preserving output and tenant identities`, async () => {
    const d = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(d, 'input.ndjson');
      const outputPath = join(d, 'output.ndjson');
      const checkpointPath = join(d, 'checkpoint.json');
      const original = '{"tenant":"a","seq":1,"value":"original"}';
      const records = [original, ...['b', 'c', 'd', 'e', 'f'].map(tenant => JSON.stringify({ tenant, seq: 1 }))];
      await writeFile(inputPath, records.join('\n') + '\n');
      await writeFile(outputPath, original);
      await writeFile(checkpointPath, corrupt);
      const options = { inputPath, outputPath, checkpointPath };
      assert.deepEqual(await processBatch(options), { accepted: 4, rejected: 0, duplicates: 1, nextLine: 5 });
      assert.equal(await readFile(join(d, 'recovery/checkpoint.bad.json'), 'utf8'), corrupt);
      assert.equal(await readFile(outputPath, 'utf8'), records.slice(0, 5).join('\n') + '\n');
      assert.equal((await processBatch(options)).accepted, 1);
      assert.equal(await readFile(outputPath, 'utf8'), records.join('\n') + '\n');
      assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 6 });
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
}

test('existing recovery evidence is never overwritten', async () => {
  const d = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const checkpointPath = join(d, 'checkpoint.json');
    const outputPath = join(d, 'output.ndjson');
    await mkdir(join(d, 'recovery'));
    await writeFile(join(d, 'recovery/checkpoint.bad.json'), 'older evidence');
    await writeFile(checkpointPath, '{');
    await writeFile(outputPath, 'existing output');
    await assert.rejects(processBatch({ inputPath: join(d, 'input'), outputPath, checkpointPath }), { code: 'EEXIST' });
    assert.equal(await readFile(checkpointPath, 'utf8'), '{');
    assert.equal(await readFile(outputPath, 'utf8'), 'existing output');
    assert.equal(await readFile(join(d, 'recovery/checkpoint.bad.json'), 'utf8'), 'older evidence');
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
