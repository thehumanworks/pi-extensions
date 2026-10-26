import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('corrupt checkpoint replays fully and preserves output and recovery evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const checkpointPath = join(dir, 'checkpoint.json');
    const recovery = join(dir, 'recovery');
    const records = [
      { tenant: 'a', seq: 1, value: 'original' },
      { tenant: 'b', seq: 1 },
      ...Array.from({ length: 5 }, (_, i) => ({ tenant: 'a', seq: i + 2 })),
    ];
    const original = JSON.stringify(records[0]);
    await writeFile(inputPath, records.map(JSON.stringify).join('\n') + '\n');
    await writeFile(outputPath, original);
    await writeFile(checkpointPath, '{"nextLine":');
    await mkdir(recovery);
    await writeFile(join(recovery, 'checkpoint.bad.json'), 'older evidence');
    const result = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.deepEqual(result, { accepted: 6, rejected: 0, duplicates: 1, nextLine: 7 });
    assert.equal(await readFile(outputPath, 'utf8'), records.map(JSON.stringify).join('\n') + '\n');
    assert.equal(await readFile(join(recovery, 'checkpoint.bad.json'), 'utf8'), '{"nextLine":');
    const archived = (await readdir(recovery)).filter(name => name !== 'checkpoint.bad.json');
    assert.equal(archived.length, 1);
    assert.equal(await readFile(join(recovery, archived[0]), 'utf8'), 'older evidence');
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 7 });
    assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normal ingestion defaults to four accepted records', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.batch-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    await writeFile(inputPath, Array.from({ length: 6 }, (_, seq) => JSON.stringify({ tenant: 'a', seq })).join('\n'));
    const result = await processBatch({ inputPath, outputPath: join(dir, 'output'), checkpointPath: join(dir, 'checkpoint') });
    assert.equal(result.accepted, 4);
    assert.equal(result.nextLine, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
