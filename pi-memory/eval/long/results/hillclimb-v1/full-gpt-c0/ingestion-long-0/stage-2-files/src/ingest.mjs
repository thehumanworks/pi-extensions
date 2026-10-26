import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

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

function identity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.tenant !== 'string' || !Number.isSafeInteger(record.seq)) {
    throw new Error('Event must have a string tenant and integer seq');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

// Also support appending to an existing file that lacks a final newline.
async function appendLine(path, line) {
  await mkdir(dirname(path), { recursive: true });
  let prefix = '';
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    if (size) {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      if (buffer[0] !== 10) prefix = '\n';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }
  await appendFile(path, `${prefix}${line}\n`);
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = 4 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive safe integer');
  }
  let nextLine = 0;
  let checkpoint;
  try {
    checkpoint = await readFile(checkpointPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (checkpoint !== undefined) {
    try {
      const parsed = JSON.parse(checkpoint);
      if (!Number.isSafeInteger(parsed?.nextLine) || parsed.nextLine < 0) {
        throw new Error('Invalid checkpoint');
      }
      nextLine = parsed.nextLine;
    } catch {
      const recovery = join(dirname(checkpointPath), 'recovery');
      await mkdir(recovery, { recursive: true });
      // Retain earlier recovery artifacts rather than overwriting them.
      const backup = join(recovery, 'checkpoint.bad.json');
      try {
        await readFile(backup);
        await rename(backup, join(recovery, `checkpoint.bad.${randomUUID()}.json`));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await rename(checkpointPath, backup);
    }
  }

  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      seen.add(identity(JSON.parse(line)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let index = 0;
  for await (const line of lines(inputPath)) {
    if (index++ < nextLine) continue;
    let key;
    try {
      key = identity(JSON.parse(line));
    } catch {
      await appendLine(join(dirname(outputPath), 'rejected.ndjson'), line);
      rejected++;
      nextLine = index;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
    } else {
      await appendLine(outputPath, line);
      seen.add(key);
      accepted++;
    }
    nextLine = index;
    if (accepted === batchSize) break;
  }

  await mkdir(dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  try {
    await appendFile(temporary, `${JSON.stringify({ nextLine })}\n`, { flag: 'wx' });
    await rename(temporary, checkpointPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return { accepted, rejected, duplicates, nextLine };
}
