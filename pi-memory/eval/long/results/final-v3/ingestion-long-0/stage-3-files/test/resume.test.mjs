import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('recovery replays beyond the default batch and preserves output and earlier evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const options = {
      inputPath: join(dir, 'input.ndjson'),
      outputPath: join(dir, 'output.ndjson'),
      checkpointPath: join(dir, 'checkpoint.json'),
    };
    const existing = '{"tenant":"a","seq":1,"value":"original"}';
    const records = [{ tenant: 'a', seq: 1 }, { tenant: 'b', seq: 1 },
      ...Array.from({ length: 5 }, (_, i) => ({ tenant: 'a', seq: i + 2 }))];
    await writeFile(options.inputPath, records.map(JSON.stringify).join('\n'));
    await writeFile(options.outputPath, existing);
    await writeFile(options.checkpointPath, '{"nextLine":');
    await mkdir(join(dir, 'recovery'));
    await writeFile(join(dir, 'recovery/checkpoint.bad.json'), 'earlier corruption');
    assert.deepEqual(await processBatch(options),
      { accepted: 6, rejected: 0, duplicates: 1, nextLine: 7 });
    assert.equal(await readFile(options.outputPath, 'utf8'),
      existing + '\n' + records.slice(1).map(JSON.stringify).join('\n') + '\n');
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), '{"nextLine":');
    const evidence = await readdir(join(dir, 'recovery'));
    assert.equal(evidence.length, 2);
    const earlier = evidence.find(name => name !== 'checkpoint.bad.json');
    assert.equal(await readFile(join(dir, 'recovery', earlier), 'utf8'), 'earlier corruption');
    assert.deepEqual(JSON.parse(await readFile(options.checkpointPath, 'utf8')), { nextLine: 7 });
    assert.deepEqual(await processBatch(options),
      { accepted: 0, rejected: 0, duplicates: 0, nextLine: 7 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('default batch, identity, quarantine, resume and corrupt recovery', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.resume-'));
  try {
    const options = {
      inputPath: join(dir, 'input.ndjson'),
      outputPath: join(dir, 'output.ndjson'),
      checkpointPath: join(dir, 'checkpoint.json'),
    };
    const records = [
      { tenant: 'a', seq: 1, extra: true },
      { tenant: 'b', seq: 1 },
      { tenant: 'a', seq: 2 },
      { tenant: 'a', seq: 3 },
      { tenant: 'a', seq: 4 },
    ];
    await writeFile(options.inputPath, [JSON.stringify(records[0]), 'broken',
      JSON.stringify(records[0]), ...records.slice(1).map(JSON.stringify)].join('\n'));
    assert.deepEqual(await processBatch(options),
      { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
    assert.deepEqual(await processBatch(options),
      { accepted: 1, rejected: 0, duplicates: 0, nextLine: 7 });
    assert.deepEqual(await processBatch(options),
      { accepted: 0, rejected: 0, duplicates: 0, nextLine: 7 });
    assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'broken\n');
    await writeFile(options.checkpointPath, 'corrupt');
    assert.deepEqual(await processBatch(options),
      { accepted: 0, rejected: 1, duplicates: 6, nextLine: 7 });
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), 'corrupt');
    assert.deepEqual((await readFile(options.outputPath, 'utf8')).trim().split('\n').map(JSON.parse), records);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
