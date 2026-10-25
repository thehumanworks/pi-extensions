import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
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
    throw new Error('Event must have a string tenant and an integer seq');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

async function saveCheckpoint(path, nextLine) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ nextLine }) + '\n', { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = 4 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive safe integer');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  let nextLine = 0;
  let recovering = false;
  let checkpointText;
  try {
    checkpointText = await readFile(checkpointPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (checkpointText !== undefined) {
    try {
      const checkpoint = JSON.parse(checkpointText);
      if (!Number.isSafeInteger(checkpoint?.nextLine) || checkpoint.nextLine < 0) {
        throw new Error('Invalid checkpoint');
      }
      nextLine = checkpoint.nextLine;
    } catch {
      const recovery = join(dirname(checkpointPath), 'recovery');
      await mkdir(recovery, { recursive: true });
      // Keep earlier recovery evidence too, if recovery has already occurred.
      const backup = join(recovery, 'checkpoint.bad.json');
      try {
        await readFile(backup);
        await rename(backup, join(recovery, `checkpoint.bad.${randomUUID()}.json`));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await rename(checkpointPath, backup);
      recovering = true;
    }
  }

  const seen = new Set();
  let needsNewline = false;
  try {
    for await (const line of lines(outputPath)) {
      if (line.trim()) seen.add(identity(JSON.parse(line)));
    }
    // Appending to an existing unterminated record must not join two records.
    const { open } = await import('node:fs/promises');
    const file = await open(outputPath, 'r');
    try {
      const { size } = await file.stat();
      if (size) {
        const last = Buffer.alloc(1);
        await file.read(last, 0, 1, size - 1);
        needsNewline = last[0] !== 10;
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let accepted = 0, rejected = 0, duplicates = 0, lineNumber = 0;
  for await (const line of lines(inputPath)) {
    if (lineNumber++ < nextLine) continue;
    let key;
    try {
      key = identity(JSON.parse(line));
    } catch {
      await appendFile(join(dirname(outputPath), 'rejected.ndjson'), line + '\n');
      rejected++;
      nextLine = lineNumber;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
    } else {
      await appendFile(outputPath, (needsNewline ? '\n' : '') + line + '\n');
      needsNewline = false;
      seen.add(key);
      accepted++;
    }
    nextLine = lineNumber;
    // Recovery replays the entire input before replacing the checkpoint.
    if (!recovering && accepted === batchSize) break;
  }
  await saveCheckpoint(checkpointPath, nextLine);
  return { accepted, rejected, duplicates, nextLine };
}
