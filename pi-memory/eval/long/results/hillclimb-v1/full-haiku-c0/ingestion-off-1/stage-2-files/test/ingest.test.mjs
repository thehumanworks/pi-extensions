import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {processBatch, DEFAULT_BATCH_SIZE} from '../src/ingest.mjs';

async function setup(lines) {
  const d = await mkdtemp(join(process.cwd(), '.ingest-'));
  const paths = {inputPath: join(d, 'in.ndjson'), outputPath: join(d, 'out.ndjson'), checkpointPath: join(d, 'cp.json')};
  await writeFile(paths.inputPath, lines.join('\n') + '\n');
  return {d, ...paths};
}

test('resumes from checkpoint across calls without duplicating output', async () => {
  const {d, inputPath, outputPath, checkpointPath} = await setup([
    '{"tenant":"a","seq":1}',
    '{"tenant":"a","seq":2}',
    '{"tenant":"a","seq":3}',
  ]);
  try {
    const first = await processBatch({inputPath, outputPath, checkpointPath, batchSize: 2});
    assert.deepEqual(first, {accepted: 2, rejected: 0, duplicates: 0, nextLine: 2});
    const second = await processBatch({inputPath, outputPath, checkpointPath, batchSize: 2});
    assert.deepEqual(second, {accepted: 1, rejected: 0, duplicates: 0, nextLine: 3});
    const third = await processBatch({inputPath, outputPath, checkpointPath, batchSize: 2});
    assert.deepEqual(third, {accepted: 0, rejected: 0, duplicates: 0, nextLine: 3});
    assert.equal((await readFile(outputPath, 'utf8')).trim().split('\n').length, 3);
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), {nextLine: 3});
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});

test('identity is (tenant, seq): duplicates detected, same seq in other tenant accepted', async () => {
  const {d, inputPath, outputPath, checkpointPath} = await setup([
    '{"tenant":"a","seq":1,"value":"x"}',
    '{"tenant":"b","seq":1,"value":"y"}',
    '{"tenant":"a","seq":1,"value":"again"}',
  ]);
  try {
    const r = await processBatch({inputPath, outputPath, checkpointPath});
    assert.deepEqual(r, {accepted: 2, rejected: 0, duplicates: 1, nextLine: 3});
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});

test('duplicates already in output from a crashed run are not re-appended', async () => {
  const {d, inputPath, outputPath, checkpointPath} = await setup(['{"tenant":"a","seq":1}', '{"tenant":"a","seq":2}']);
  try {
    await writeFile(outputPath, '{"tenant":"a","seq":1}\n');
    const r = await processBatch({inputPath, outputPath, checkpointPath});
    assert.deepEqual(r, {accepted: 1, rejected: 0, duplicates: 1, nextLine: 2});
    assert.equal((await readFile(outputPath, 'utf8')).trim().split('\n').length, 2);
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});

test('malformed lines are rejected and still consume a line', async () => {
  const {d, inputPath, outputPath, checkpointPath} = await setup([
    'not json',
    '[]',
    '{"seq":1}',
    '{"tenant":"a","seq":"1"}',
    '{"tenant":"a","seq":1}',
  ]);
  try {
    const r = await processBatch({inputPath, outputPath, checkpointPath});
    assert.deepEqual(r, {accepted: 1, rejected: 4, duplicates: 0, nextLine: 5});
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});

test('missing checkpoint starts at 0; default batch size is used when omitted', async () => {
  assert.equal(DEFAULT_BATCH_SIZE, 1000);
  const {d, inputPath, outputPath, checkpointPath} = await setup(['{"tenant":"a","seq":1}']);
  try {
    const r = await processBatch({inputPath, outputPath, checkpointPath});
    assert.deepEqual(r, {accepted: 1, rejected: 0, duplicates: 0, nextLine: 1});
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});

test('rejects invalid batchSize and checkpoints past end of input', async () => {
  const {d, inputPath, outputPath, checkpointPath} = await setup(['{"tenant":"a","seq":1}']);
  try {
    await assert.rejects(processBatch({inputPath, outputPath, checkpointPath, batchSize: 0}), TypeError);
    await writeFile(checkpointPath, '{"nextLine":5}\n');
    await assert.rejects(processBatch({inputPath, outputPath, checkpointPath}), /beyond end of input/);
  } finally {
    await rm(d, {recursive: true, force: true});
  }
});
