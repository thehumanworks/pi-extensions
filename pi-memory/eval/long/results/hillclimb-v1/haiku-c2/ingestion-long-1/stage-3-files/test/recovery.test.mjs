import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { processBatch } from '../src/ingest.mjs';

test('truncated checkpoint is quarantined and replay appends only unseen identities', async () => {
  const d = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(d, 'in.ndjson');
    const outputPath = join(d, 'out.ndjson');
    const checkpointPath = join(d, 'cp.json');
    const existing = '{"tenant":"a","seq":1,"value":"kept"}\n';
    await writeFile(inputPath, '{"tenant":"a","seq":1,"value":"dup"}\n{"tenant":"b","seq":1,"value":"other"}\n');
    await writeFile(outputPath, existing);
    await writeFile(checkpointPath, '{"nextLine":');

    const report = await processBatch({ inputPath, outputPath, checkpointPath });

    assert.equal(report.accepted, 1);
    assert.equal(report.duplicates, 1);
    assert.equal(await readFile(outputPath, 'utf8'), existing + '{"tenant":"b","seq":1,"value":"other"}\n');
    assert.equal(await readFile(join(d, 'recovery', 'checkpoint.bad.json'), 'utf8'), '{"nextLine":');
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), { nextLine: 2 });
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('quarantine refuses to overwrite earlier corrupt-checkpoint evidence', async () => {
  const d = await mkdtemp(join(process.cwd(), '.recovery-'));
  try {
    const inputPath = join(d, 'in.ndjson');
    const checkpointPath = join(d, 'cp.json');
    await writeFile(inputPath, '{"tenant":"a","seq":1}\n');
    await writeFile(checkpointPath, '{"nextLine":');
    await mkdir(join(d, 'recovery'));
    await writeFile(join(d, 'recovery', 'checkpoint.bad.json'), 'earlier');

    await assert.rejects(
      processBatch({ inputPath, outputPath: join(d, 'out.ndjson'), checkpointPath }),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(join(d, 'recovery', 'checkpoint.bad.json'), 'utf8'), 'earlier');
    await access(checkpointPath);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
