import { createReadStream } from 'node:fs';
import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const DEFAULT_BATCH_SIZE = 4;

function identity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.tenant !== 'string' || record.tenant.length === 0 ||
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

async function saveCheckpoint(path, nextLine) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx');
    await file.writeFile(`${JSON.stringify({ nextLine })}\n`);
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE }) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive safe integer');
  }
  if (new Set([inputPath, outputPath, checkpointPath].map(path => resolve(path))).size !== 3) {
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
    try {
      const checkpoint = JSON.parse(checkpointText);
      if (!checkpoint || !Number.isSafeInteger(checkpoint.nextLine) || checkpoint.nextLine < 0) {
        throw new Error('Invalid checkpoint nextLine');
      }
      nextLine = checkpoint.nextLine;
    } catch {
      // Preserve the original bytes before replaying from the beginning.
      // Existing output identities make replay safe after a lost checkpoint.
      await rename(checkpointPath, `${checkpointPath}.corrupt-${randomUUID()}`);
    }
  }

  // Rebuild identities from existing output, including writes preceding a failed checkpoint.
  const seen = new Set();
  let needsNewline = false;
  try {
    for await (const line of lines(outputPath)) {
      const key = identity(JSON.parse(line));
      if (key === null) throw new Error('Invalid record in existing output');
      seen.add(key);
    }
    const existing = await open(outputPath, 'r');
    try {
      const { size } = await existing.stat();
      if (size) {
        const last = Buffer.alloc(1);
        await existing.read(last, 0, 1, size - 1);
        needsNewline = last[0] !== 10;
      }
    } finally { await existing.close(); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  const output = await open(outputPath, 'a');
  let accepted = 0, rejected = 0, duplicates = 0, lineNumber = 0;
  try {
    for await (const line of lines(inputPath)) {
      if (lineNumber++ < nextLine) continue;
      let key;
      try { key = identity(JSON.parse(line)); } catch { key = null; }
      if (key === null) {
        rejected++;
      } else if (seen.has(key)) {
        duplicates++;
      } else {
        await output.writeFile(`${needsNewline ? '\n' : ''}${line}\n`);
        needsNewline = false;
        seen.add(key);
        accepted++;
      }
      nextLine = lineNumber;
      if (accepted === batchSize) break;
    }
  } finally {
    await output.close();
  }
  await saveCheckpoint(checkpointPath, nextLine);
  return { accepted, rejected, duplicates, nextLine };
}
