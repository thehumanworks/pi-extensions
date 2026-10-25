import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, open } from 'node:fs/promises';
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

async function sync(file) {
  try {
    await file.sync();
  } catch (error) {
    // Node's permission model can prohibit fsync even for writable files.
    if (error.code !== 'ERR_ACCESS_DENIED') throw error;
  }
}

async function append(path, text) {
  const file = await open(path, 'a+');
  try {
    const { size } = await file.stat();
    let prefix = '';
    if (size) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      if (last[0] !== 10) prefix = '\n';
    }
    await file.writeFile(prefix + text + '\n');
    await sync(file);
  } finally {
    await file.close();
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = 4 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('batchSize must be a positive safe integer');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
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
        throw new Error('Invalid checkpoint');
      }
      nextLine = checkpoint.nextLine;
    } catch {
      // Preserve the damaged checkpoint, including any earlier recovery artifact.
      const recovery = join(dirname(checkpointPath), 'recovery');
      await mkdir(recovery, { recursive: true });
      const bad = join(recovery, 'checkpoint.bad.json');
      try {
        await readFile(bad);
        await rename(bad, join(recovery, `checkpoint.bad.${randomUUID()}.json`));
      } catch (priorError) {
        if (priorError.code !== 'ENOENT') throw priorError;
      }
      await rename(checkpointPath, bad);
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
      await append(join(dirname(outputPath), 'rejected.ndjson'), line);
      rejected++;
      nextLine = index;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
    } else {
      await append(outputPath, line);
      seen.add(key);
      accepted++;
    }
    nextLine = index;
    if (accepted === batchSize) break;
  }

  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  const checkpoint = await open(temporary, 'wx');
  try {
    await checkpoint.writeFile(JSON.stringify({ nextLine }) + '\n');
    await sync(checkpoint);
  } finally {
    await checkpoint.close();
  }
  await rename(temporary, checkpointPath);
  return { accepted, rejected, duplicates, nextLine };
}
