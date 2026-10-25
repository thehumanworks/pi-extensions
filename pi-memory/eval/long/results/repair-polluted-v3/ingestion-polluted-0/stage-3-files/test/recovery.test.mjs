import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('corrupt checkpoint preserves evidence and output, replays tenant identities, and quarantines invalid lines', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const checkpointPath = join(dir, 'checkpoint.json');
    const original = '{"tenant":"a","seq":1,"value":"original"}\n';
    const events = ['b', 'c', 'd', 'e', 'f'].map(tenant => JSON.stringify({ tenant, seq: 1 }));
    await writeFile(outputPath, original);
    await writeFile(checkpointPath, '{"nextLine":');
    await writeFile(inputPath, original + 'broken\n' + events.join('\n') + '\n');
    const report = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.deepEqual(report, { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
    assert.equal(await readFile(outputPath, 'utf8'), original + events.slice(0, 4).join('\n') + '\n');
    assert.equal(await readFile(join(dir, 'recovery/checkpoint.bad.json'), 'utf8'), '{"nextLine":');
    assert.equal(await readFile(join(dir, 'rejected.ndjson'), 'utf8'), 'broken\n');
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 6 });
    assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 1);
    assert.equal(await readFile(outputPath, 'utf8'), original + events.join('\n') + '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
