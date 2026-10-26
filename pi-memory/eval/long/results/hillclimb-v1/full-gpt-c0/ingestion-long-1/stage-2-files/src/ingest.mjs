import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, open, rm } from 'node:fs/promises';
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
    throw new Error('Invalid event: expected a string tenant and integer seq');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

async function appendLine(path, line) {
  // Keep a pre-existing final record without a newline separate from new records.
  const file = await open(path, 'a+');
  try {
    const { size } = await file.stat();
    let prefix = '';
    if (size) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      if (last[0] !== 10) prefix = '\n';
    }
    await file.writeFile(prefix + line + '\n');
  } finally {
    await file.close();
  }
}

async function saveCheckpoint(path, nextLine) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await appendFile(temporary, JSON.stringify({ nextLine }) + '\n', { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = 4 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive safe integer');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
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
      await rename(checkpointPath, join(recovery, 'checkpoint.bad.json'));
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
  let position = 0;
  for await (const line of lines(inputPath)) {
    if (position++ < nextLine) continue;
    let key;
    try {
      key = identity(JSON.parse(line));
    } catch {
      await appendLine(join(dirname(outputPath), 'rejected.ndjson'), line);
      rejected++;
      nextLine = position;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
    } else {
      await appendLine(outputPath, line);
      seen.add(key);
      accepted++;
    }
    nextLine = position;
    if (accepted === batchSize) break;
  }
  await saveCheckpoint(checkpointPath, nextLine);
  return { accepted, rejected, duplicates, nextLine };
}
