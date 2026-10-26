import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('corrupt checkpoint is preserved as evidence and output is not rewritten', async () => {
  const d = await mkdtemp(join(process.cwd(), '.visible-'));
  try {
    const inputPath = join(d, 'in.ndjson');
    const outputPath = join(d, 'out.ndjson');
    const checkpointPath = join(d, 'cp.json');
    const existing = '{"tenant":"a","seq":0,"value":"zero"}\n';
    await writeFile(inputPath, existing + '{"tenant":"a","seq":1,"value":"one"}\n');
    await writeFile(outputPath, existing);
    await writeFile(checkpointPath, '{"nextLine":');

    const r = await processBatch({ inputPath, outputPath, checkpointPath, batchSize: 4 });

    assert.equal(r.accepted, 1);
    assert.equal(r.duplicates, 1);
    assert.equal(r.nextLine, 2);
    assert.equal(await readFile(outputPath, 'utf8'), existing + '{"tenant":"a","seq":1,"value":"one"}\n');
    assert.equal(await readFile(r.quarantinedCheckpoint, 'utf8'), '{"nextLine":');
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 2 });
    assert.equal((await readdir(d)).filter((name) => name.includes('.corrupt-')).length, 1);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
