import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, readdir, rm, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {processBatch} from '../src/ingest.mjs';

test('corrupt checkpoint is quarantined and replay appends only unseen (tenant, seq)', async () => {
  const d = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(d, 'in.ndjson');
    const outputPath = join(d, 'out.ndjson');
    const checkpointPath = join(d, 'cp.json');
    const badPath = join(d, 'recovery', 'checkpoint.bad.json');

    await writeFile(inputPath, '{"tenant":"a","seq":1,"value":"a1"}\n{"tenant":"b","seq":1,"value":"b1"}\n{"tenant":"a","seq":2,"value":"a2"}\n');
    await mkdir(d, {recursive: true});
    await writeFile(outputPath, '{"tenant":"a","seq":1,"value":"a1"}\n');
    await writeFile(checkpointPath, '{"nextLine":');

    const r = await processBatch({inputPath, outputPath, checkpointPath});

    assert.equal(r.accepted, 2);
    assert.equal(r.duplicates, 1);
    assert.equal(await readFile(badPath, 'utf8'), '{"nextLine":');
    assert.equal(await readFile(checkpointPath, 'utf8'), '{"nextLine":3}\n');
    assert.equal(
      await readFile(outputPath, 'utf8'),
      '{"tenant":"a","seq":1,"value":"a1"}\n{"tenant":"b","seq":1,"value":"b1"}\n{"tenant":"a","seq":2,"value":"a2"}\n',
    );
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});

test('second corrupt checkpoint never overwrites an earlier quarantine', async () => {
  const d = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(d, 'in.ndjson');
    const outputPath = join(d, 'out.ndjson');
    const checkpointPath = join(d, 'cp.json');

    await writeFile(inputPath, '{"tenant":"a","seq":1,"value":"a1"}\n');
    await mkdir(join(d, 'recovery'), {recursive: true});
    await writeFile(join(d, 'recovery', 'checkpoint.bad.json'), 'earlier');
    await writeFile(checkpointPath, '{"nextLine":');

    await processBatch({inputPath, outputPath, checkpointPath});

    assert.equal(await readFile(join(d, 'recovery', 'checkpoint.bad.json'), 'utf8'), 'earlier');
    assert.equal(await readFile(join(d, 'recovery', 'checkpoint.bad.1.json'), 'utf8'), '{"nextLine":');
    assert.deepEqual((await readdir(join(d, 'recovery'))).sort(), ['checkpoint.bad.1.json', 'checkpoint.bad.json']);
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});
