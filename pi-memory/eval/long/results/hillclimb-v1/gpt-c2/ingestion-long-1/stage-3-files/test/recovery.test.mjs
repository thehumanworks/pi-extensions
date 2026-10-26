import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('corrupt checkpoints preserve evidence and output, replay identities, and quarantine malformed lines', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(directory, 'input.ndjson');
    const outputPath = join(directory, 'output.ndjson');
    const checkpointPath = join(directory, 'checkpoint.json');
    const original = '{"tenant":"a","seq":1,"value":"original"}';
    const additions = [
      '{"tenant":"b","seq":1}',
      '{"tenant":"a","seq":2}',
      '{"tenant":"a","seq":3}',
      '{"tenant":"a","seq":4}',
      '{"tenant":"a","seq":5}',
    ];
    const corrupt = '{"nextLine":';
    await writeFile(outputPath, original);
    await writeFile(checkpointPath, corrupt);
    await writeFile(inputPath, [original, 'not json', ...additions].join('\n') + '\n');
    const report = await processBatch({ inputPath, outputPath, checkpointPath });
    assert.deepEqual(report, { accepted: 4, rejected: 1, duplicates: 1, nextLine: 6 });
    assert.equal(await readFile(outputPath, 'utf8'), [original, ...additions.slice(0, 4)].join('\n') + '\n');
    assert.equal(await readFile(join(directory, 'recovery/checkpoint.bad.json'), 'utf8'), corrupt);
    assert.equal(await readFile(join(directory, 'rejected.ndjson'), 'utf8'), 'not json\n');
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 6 });
    assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 1);
    assert.equal(await readFile(outputPath, 'utf8'), [original, ...additions].join('\n') + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const invalid of ['null', '{"nextLine":-1}', '{"nextLine":"2"}']) {
  test(`invalid checkpoint recovers: ${invalid}`, async () => {
    const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const inputPath = join(directory, 'in.ndjson');
      const outputPath = join(directory, 'out.ndjson');
      const checkpointPath = join(directory, 'cp.json');
      await writeFile(inputPath, '{"tenant":"a","seq":1}\n');
      await writeFile(checkpointPath, invalid);
      assert.equal((await processBatch({ inputPath, outputPath, checkpointPath })).accepted, 1);
      assert.equal(await readFile(join(directory, 'recovery/checkpoint.bad.json'), 'utf8'), invalid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
