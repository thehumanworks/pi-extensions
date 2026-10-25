import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export const DEFAULT_BATCH_SIZE = 100;

function identity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.tenant !== 'string' || !Number.isSafeInteger(record.seq)) {
    throw new Error('Expected an event with a string tenant and integer seq');
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
    throw new TypeError('batchSize must be a positive safe integer');
  }
  let nextLine = 0;
  let checkpointText;
  try {
    checkpointText = await readFile(checkpointPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (checkpointText !== undefined) {
    try {
      const checkpoint = JSON.parse(checkpointText);
      if (!checkpoint || !Number.isSafeInteger(checkpoint.nextLine) || checkpoint.nextLine < 0) {
        throw new Error('Invalid checkpoint nextLine');
      }
      nextLine = checkpoint.nextLine;
    } catch {
      // Preserve the damaged bytes before replaying against the durable output index.
      // A unique name retains evidence across repeated recoveries.
      await rename(checkpointPath, `${checkpointPath}.${randomUUID()}.corrupt`);
    }
  }

  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      // Never silently ignore damaged output: it is our durable identity index.
      seen.add(identity(JSON.parse(line)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  // Keep an existing final record separate when appending to a file without a newline.
  let separator = '';
  const { open } = await import('node:fs/promises');
  try {
    const file = await open(outputPath, 'r');
    try {
      const { size } = await file.stat();
      if (size) {
        const byte = Buffer.alloc(1);
        await file.read(byte, 0, 1, size - 1);
        if (byte[0] !== 10) separator = '\n';
      }
    } finally { await file.close(); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let accepted = 0, rejected = 0, duplicates = 0, lineNumber = 0, processed = 0;
  for await (const line of lines(inputPath)) {
    if (lineNumber++ < nextLine) continue;
    let key;
    try { key = identity(JSON.parse(line)); }
    catch { rejected++; }
    if (key !== undefined) {
      if (seen.has(key)) duplicates++;
      else {
        await appendFile(outputPath, `${separator}${line}\n`, 'utf8');
        separator = '';
        seen.add(key);
        accepted++;
      }
    }
    nextLine++;
    if (++processed === batchSize) break;
  }

  const temporaryPath = `${checkpointPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ nextLine })}\n`, { flag: 'wx' });
    await rename(temporaryPath, checkpointPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { accepted, rejected, duplicates, nextLine };
}
