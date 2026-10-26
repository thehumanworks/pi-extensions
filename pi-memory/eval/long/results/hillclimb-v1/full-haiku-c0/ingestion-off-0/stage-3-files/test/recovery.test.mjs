import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {processBatch} from '../src/ingest.mjs';

test('truncated checkpoint is quarantined and processing restarts without duplicates', async () => {
  const d = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(d, 'in.ndjson');
    const outputPath = join(d, 'out.ndjson');
    const checkpointPath = join(d, 'cp.json');
    await writeFile(inputPath, '{"tenant":"a","seq":1}\n{"tenant":"a","seq":2}\n');
    await writeFile(outputPath, '{"tenant":"a","seq":1}\n');
    await writeFile(checkpointPath, '{"nextLine":');

    const r = await processBatch({inputPath, outputPath, checkpointPath});
    assert.equal(r.accepted, 1);
    assert.equal(r.duplicates, 1);
    assert.equal(r.nextLine, 2);
    assert.equal(await readFile(join(d, 'cp.json.corrupt'), 'utf8'), '{"nextLine":');
    assert.equal((await readFile(outputPath, 'utf8')).trim().split('\n').length, 2);
    assert.deepEqual(await readdir(d).then((names) => names.filter((n) => n.startsWith('cp.json'))).then((n) => n.sort()), ['cp.json', 'cp.json.corrupt']);
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});
