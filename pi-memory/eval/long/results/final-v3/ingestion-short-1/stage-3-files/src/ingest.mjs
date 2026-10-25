import { constants, createReadStream } from 'node:fs';
import { appendFile, copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

function identity(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.tenant !== 'string' || record.tenant.length === 0 ||
      !Number.isSafeInteger(record.seq) || record.seq < 0) {
    throw new Error('Invalid event identity');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

async function* lines(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    yield* reader;
  } finally {
    reader.close();
    stream.destroy();
  }
}

async function saveCheckpoint(path, nextLine) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(`${JSON.stringify({ nextLine })}\n`);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
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
      // Preserve evidence before replaying. Never overwrite an earlier backup.
      let backupPath = `${checkpointPath}.corrupt`;
      for (;;) {
        try {
          await copyFile(checkpointPath, backupPath, constants.COPYFILE_EXCL);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          backupPath = `${checkpointPath}.${randomUUID()}.corrupt`;
        }
      }
    }
  }

  // Output is the source of truth for deduplication, including when an earlier
  // append succeeded but its checkpoint update did not.
  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      seen.add(identity(JSON.parse(line)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine };
  await mkdir(dirname(outputPath), { recursive: true });
  let lineNumber = 0;
  for await (const line of lines(inputPath)) {
    if (lineNumber++ < nextLine) continue;
    let key;
    try {
      key = identity(JSON.parse(line));
    } catch {
      report.rejected++;
      report.nextLine = lineNumber;
      continue;
    }
    if (seen.has(key)) {
      report.duplicates++;
    } else {
      await appendFile(outputPath, `${line}\n`);
      seen.add(key);
      report.accepted++;
    }
    report.nextLine = lineNumber;
    if (report.accepted === batchSize) break;
  }
  await saveCheckpoint(checkpointPath, report.nextLine);
  return report;
}
