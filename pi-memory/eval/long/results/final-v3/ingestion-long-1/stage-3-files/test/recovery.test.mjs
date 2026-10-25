import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('truncated checkpoint preserves output and earlier recovery evidence', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const options = {
      inputPath: join(dir, 'input.ndjson'),
      outputPath: join(dir, 'output.ndjson'),
      checkpointPath: join(dir, 'checkpoint.json'),
    };
    const original = '{"tenant":"a","seq":1,"value":"keep"}\n';
    const events = [
      original.trim(),
      '{"tenant":"b","seq":1}',
      '{"tenant":"a","seq":2}',
      '{"tenant":"a","seq":3}',
      '{"tenant":"a","seq":4}',
      '{"tenant":"a","seq":5}',
    ];
    await writeFile(options.inputPath, events.join('\n') + '\n');
    await writeFile(options.outputPath, original);
    await writeFile(options.checkpointPath, '{"nextLine":');
    const recovery = join(dir, 'recovery');
    await mkdir(recovery);
    await writeFile(join(recovery, 'checkpoint.bad.json'), 'earlier evidence');

    assert.deepEqual(await processBatch(options), {
      accepted: 4, rejected: 0, duplicates: 1, nextLine: 5,
    });
    assert.equal(await readFile(options.outputPath, 'utf8'), events.slice(0, 5).join('\n') + '\n');
    assert.equal(await readFile(join(recovery, 'checkpoint.bad.json'), 'utf8'), 'earlier evidence');
    const backups = (await readdir(recovery)).filter(name => name !== 'checkpoint.bad.json');
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(recovery, backups[0]), 'utf8'), '{"nextLine":');
    assert.deepEqual(JSON.parse(await readFile(options.checkpointPath, 'utf8')), { nextLine: 5 });
    assert.equal((await processBatch(options)).accepted, 1);
    assert.equal(await readFile(options.outputPath, 'utf8'), events.join('\n') + '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
