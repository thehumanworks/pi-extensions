import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('corrupt checkpoints preserve evidence and replay without losing existing output', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(directory, 'input.ndjson');
    const outputPath = join(directory, 'output.ndjson');
    const checkpointPath = join(directory, 'checkpoint.json');
    const existing = '{"tenant":"a","seq":1,"value":"original"}';
    const records = [existing, '{"tenant":"b","seq":1}', '{"tenant":"a","seq":2}'];
    const corrupt = '{"nextLine":';
    await writeFile(inputPath, records.join('\n') + '\n');
    await writeFile(outputPath, existing); // Preserve bytes even without a final newline.
    await writeFile(checkpointPath, corrupt);
    const recovery = join(directory, 'recovery');
    await mkdir(recovery);
    await writeFile(join(recovery, 'checkpoint.bad.json'), 'older evidence');

    const report = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.deepEqual(report, { accepted: 2, rejected: 0, duplicates: 1, nextLine: 3 });
    assert.equal(await readFile(outputPath, 'utf8'), records.join('\n') + '\n');
    assert.equal(await readFile(join(recovery, 'checkpoint.bad.json'), 'utf8'), corrupt);
    const archived = (await readdir(recovery)).filter(name => name !== 'checkpoint.bad.json');
    assert.equal(archived.length, 1);
    assert.equal(await readFile(join(recovery, archived[0]), 'utf8'), 'older evidence');
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 3 });
    assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 0);
    assert.equal(await readFile(outputPath, 'utf8'), records.join('\n') + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable default batch size is four accepted identities', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.batch-'));
  try {
    const inputPath = join(directory, 'input.ndjson');
    const outputPath = join(directory, 'output.ndjson');
    const checkpointPath = join(directory, 'checkpoint.json');
    const records = Array.from({ length: 6 }, (_, seq) => JSON.stringify({ tenant: 'a', seq }));
    await writeFile(inputPath, records.join('\n') + '\n');
    await writeFile(outputPath, records[0] + '\n');
    const report = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.deepEqual(report, { accepted: 4, rejected: 0, duplicates: 1, nextLine: 5 });
    assert.equal(await readFile(outputPath, 'utf8'), records.slice(0, 5).join('\n') + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
