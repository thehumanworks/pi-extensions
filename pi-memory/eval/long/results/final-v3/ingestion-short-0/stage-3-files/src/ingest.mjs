import { createReadStream, constants } from 'node:fs';
import { open, readFile, mkdir, rename, rm, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

function identity(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)
      || typeof record.tenant !== 'string' || !Number.isSafeInteger(record.seq)) {
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

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = 4 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive safe integer');
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
      if (!Number.isSafeInteger(checkpoint?.nextLine) || checkpoint.nextLine < 0) {
        throw new Error('Invalid checkpoint nextLine');
      }
      nextLine = checkpoint.nextLine;
    } catch {
      // Preserve the original bytes before replaying from the beginning. Exclusive
      // copies retain earlier recovery evidence as well. I/O failures must abort.
      let backup = `${checkpointPath}.corrupt`;
      for (;;) {
        try {
          await copyFile(checkpointPath, backup, constants.COPYFILE_EXCL);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          backup = `${checkpointPath}.corrupt.${randomUUID()}`;
        }
      }
    }
  }

  // Output is the durable source of identities, including appends made before
  // an interrupted checkpoint update. Never rewrite or truncate existing data.
  const seen = new Set();
  let outputHasLines = false;
  try {
    for await (const line of lines(outputPath)) {
      seen.add(identity(JSON.parse(line)));
      outputHasLines = true;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  const output = await open(outputPath, 'a+');
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  try {
    // An otherwise valid final record need not have a terminating newline.
    const { size } = await output.stat();
    let needsSeparator = false;
    if (outputHasLines && size > 0) {
      const last = Buffer.alloc(1);
      await output.read(last, 0, 1, size - 1);
      needsSeparator = last[0] !== 10;
    }
    let index = 0;
    for await (const line of lines(inputPath)) {
      if (index++ < nextLine) continue;
      let key;
      try {
        key = identity(JSON.parse(line));
      } catch {
        rejected++;
        nextLine = index;
        continue;
      }
      if (seen.has(key)) {
        duplicates++;
        nextLine = index;
        continue;
      }
      await output.writeFile(`${needsSeparator ? '\n' : ''}${line}\n`);
      needsSeparator = false;
      seen.add(key);
      accepted++;
      nextLine = index;
      if (accepted === batchSize) break;
    }
  } finally {
    await output.close();
  }

  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  try {
    const checkpoint = await open(temporary, 'wx');
    try {
      await checkpoint.writeFile(`${JSON.stringify({ nextLine })}\n`);
    } finally {
      await checkpoint.close();
    }
    await rename(temporary, checkpointPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return { accepted, rejected, duplicates, nextLine };
}
