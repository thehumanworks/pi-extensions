import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export const DEFAULT_BATCH_SIZE = 1000;

function identity(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)
      || typeof record.tenant !== 'string' || !Number.isSafeInteger(record.seq)) {
    throw new Error('Expected an event with a string tenant and an integer seq');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

async function* lines(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
    stream.destroy();
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE }) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive safe integer');
  }
  let nextLine = 0;
  try {
    ({ nextLine } = JSON.parse(await readFile(checkpointPath, 'utf8')));
    if (!Number.isSafeInteger(nextLine) || nextLine < 0) throw new Error('Invalid checkpoint nextLine');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // The output is also the durable identity index: an interrupted checkpoint
  // update can safely replay lines that have already been appended.
  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      seen.add(identity(JSON.parse(line)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  const output = await open(outputPath, 'a+');
  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine };
  try {
    // Preserve a pre-existing final record even when it has no newline.
    const { size } = await output.stat();
    let needsSeparator = false;
    if (size > 0) {
      const last = Buffer.alloc(1);
      await output.read(last, 0, 1, size - 1);
      needsSeparator = last[0] !== 10;
    }
    let index = 0;
    let processed = 0;
    for await (const line of lines(inputPath)) {
      if (index++ < nextLine) continue;
      let key;
      try {
        key = identity(JSON.parse(line));
      } catch {
        report.rejected++;
      }
      if (key !== undefined) {
        if (seen.has(key)) {
          report.duplicates++;
        } else {
          await output.writeFile(`${needsSeparator ? '\n' : ''}${line}\n`);
          needsSeparator = false;
          seen.add(key);
          report.accepted++;
        }
      }
      report.nextLine = index;
      if (++processed >= batchSize) break;
    }
  } finally {
    await output.close();
  }

  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  try {
    const checkpoint = await open(temporary, 'wx');
    try {
      await checkpoint.writeFile(`${JSON.stringify({ nextLine: report.nextLine })}\n`);
    } finally {
      await checkpoint.close();
    }
    await rename(temporary, checkpointPath);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return report;
}
