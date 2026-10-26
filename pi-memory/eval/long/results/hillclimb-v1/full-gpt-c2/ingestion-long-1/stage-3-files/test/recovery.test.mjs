import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('corrupt checkpoint replays without losing output or recovery evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const checkpointPath = join(dir, 'checkpoint.json');
    const recovery = join(dir, 'recovery');
    const existing = '{"tenant":"a","seq":1,"value":"original"}';
    const second = '{"tenant":"b","seq":1,"value":"other tenant"}';
    const third = '{"tenant":"a","seq":2,"extra":{"keep":true}}';
    const corrupt = '{"nextLine":';
    await mkdir(recovery);
    await writeFile(join(recovery, 'checkpoint.bad.json'), 'older evidence');
    await writeFile(checkpointPath, corrupt);
    await writeFile(outputPath, existing);
    await writeFile(inputPath, `${existing}\nnot json\n${second}\n${third}\n`);
    const report = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.deepEqual(report, { accepted: 2, rejected: 1, duplicates: 1, nextLine: 4 });
    assert.equal(await readFile(outputPath, 'utf8'), `${existing}\n${second}\n${third}\n`);
    assert.equal(await readFile(join(recovery, 'checkpoint.bad.json'), 'utf8'), corrupt);
    const archived = (await readdir(recovery)).filter(name => name !== 'checkpoint.bad.json');
    assert.equal(archived.length, 1);
    assert.equal(await readFile(join(recovery, archived[0]), 'utf8'), 'older evidence');
    assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'not json\n');
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 4 });
    const resumed = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.equal(resumed.accepted, 0);
    assert.equal(await readFile(outputPath, 'utf8'), `${existing}\n${second}\n${third}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('default batch counts four accepted records, not duplicates or rejects', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.batch-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const checkpointPath = join(dir, 'checkpoint.json');
    const records = Array.from({ length: 5 }, (_, seq) => JSON.stringify({ tenant: 'a', seq }));
    await writeFile(inputPath, [records[0], records[0], 'bad', ...records.slice(1)].join('\n') + '\n');
    const report = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.deepEqual(report, { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
    assert.equal(await readFile(outputPath, 'utf8'), records.slice(0, 4).join('\n') + '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
