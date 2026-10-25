import { createReadStream } from 'node:fs';
import { open, readFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const DEFAULT_BATCH_SIZE = 1000;

function identity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.tenant !== 'string' || !record.tenant.length ||
      !Number.isSafeInteger(record.seq) || record.seq < 0) return null;
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
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive safe integer');
  }
  if (new Set([inputPath, outputPath, checkpointPath].map(p => resolve(p))).size !== 3) {
    throw new Error('Input, output, and checkpoint paths must be distinct');
  }
  let nextLine = 0;
  let checkpointText;
  try {
    checkpointText = await readFile(checkpointPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (checkpointText !== undefined) {
    let checkpoint;
    try {
      checkpoint = JSON.parse(checkpointText);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (checkpoint && Number.isSafeInteger(checkpoint.nextLine) && checkpoint.nextLine >= 0) {
      nextLine = checkpoint.nextLine;
    } else {
      // Preserve the exact corrupt bytes before replaying from the beginning.
      // Existing output identities make replay append-only and idempotent.
      await rename(checkpointPath, `${checkpointPath}.corrupt.${randomUUID()}`);
    }
  }

  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      const key = identity(JSON.parse(line));
      if (key === null) throw new Error('Invalid record in existing output');
      seen.add(key);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  const output = await open(outputPath, 'a+');
  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine };
  try {
    const { size } = await output.stat();
    let needsNewline = false;
    if (size) {
      const last = Buffer.alloc(1);
      await output.read(last, 0, 1, size - 1);
      needsNewline = last[0] !== 10;
    }
    let index = 0;
    for await (const line of lines(inputPath)) {
      if (index++ < nextLine) continue;
      let key = null;
      try { key = identity(JSON.parse(line)); } catch { /* Reject malformed JSON. */ }
      if (key === null) report.rejected++;
      else if (seen.has(key)) report.duplicates++;
      else {
        await output.writeFile(`${needsNewline ? '\n' : ''}${line}\n`);
        needsNewline = false;
        seen.add(key);
        report.accepted++;
      }
      report.nextLine++;
      if (report.nextLine - nextLine >= batchSize) break;
    }
    // Writes are awaited before publishing the checkpoint.
  } finally {
    await output.close();
  }

  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  try {
    const checkpoint = await open(temporary, 'wx');
    try {
      await checkpoint.writeFile(`${JSON.stringify({ nextLine: report.nextLine })}\n`);
      // Closing before rename makes the complete checkpoint visible atomically.
    } finally {
      await checkpoint.close();
    }
    await rename(temporary, checkpointPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return report;
}
