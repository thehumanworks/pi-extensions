import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

async function workspace(run) {
  const dir = await mkdtemp(join(process.cwd(), '.ingest-test-'));
  const paths = { inputPath: join(dir, 'input.ndjson'), outputPath: join(dir, 'output.ndjson'), checkpointPath: join(dir, 'checkpoint.json') };
  try { await run(paths, dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const event = (tenant, seq) => JSON.stringify({ tenant, seq, value: `original-${seq}` });

test('default counts accepted records, quarantines errors, and resumes at EOF', async () => {
  await workspace(async (paths, dir) => {
    const records = [event('a', 1), 'broken', event('b', 1), event('a', 1), event('a', 2), event('a', 3), event('a', 4)];
    await writeFile(paths.inputPath, records.join('\n') + '\n');
    assert.deepEqual(await processBatch(paths), { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
    assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'broken\n');
    assert.deepEqual(await processBatch(paths), { accepted: 1, rejected: 0, duplicates: 0, nextLine: 7 });
    assert.deepEqual(await processBatch(paths), { accepted: 0, rejected: 0, duplicates: 0, nextLine: 7 });
    assert.equal(await readFile(paths.outputPath, 'utf8'), [records[0], records[2], records[4], records[5], records[6]].join('\n') + '\n');
  });
});

test('corrupt checkpoint preserves evidence and existing output during replay', async () => {
  await workspace(async (paths, dir) => {
    const records = [event('a', 1), event('b', 1), event('a', 2)];
    await writeFile(paths.inputPath, records.join('\n'));
    await writeFile(paths.outputPath, records[0] + '\n');
    await writeFile(paths.checkpointPath, '{bad');
    assert.deepEqual(await processBatch(paths), { accepted: 2, rejected: 0, duplicates: 1, nextLine: 3 });
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), '{bad');
    assert.equal(await readFile(paths.outputPath, 'utf8'), records.join('\n') + '\n');
    assert.deepEqual(JSON.parse(await readFile(paths.checkpointPath, 'utf8')), { nextLine: 3 });
  });
});

test('missing checkpoint replays existing output without duplication; invalid batch fails', async () => {
  await workspace(async (paths) => {
    await writeFile(paths.inputPath, event('a', 1) + '\n' + event('b', 1) + '\n');
    await writeFile(paths.outputPath, event('a', 1) + '\n');
    assert.deepEqual(await processBatch({ ...paths, batchSize: 1 }), { accepted: 1, rejected: 0, duplicates: 1, nextLine: 2 });
    await assert.rejects(processBatch({ ...paths, batchSize: 0 }), RangeError);
  });
});
