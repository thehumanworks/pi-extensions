import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
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
      typeof record.tenant !== 'string' || !record.tenant.length ||
      !Number.isSafeInteger(record.seq)) {
    throw new Error('Event requires a nonempty tenant and an integer seq');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

// Also support pre-existing NDJSON files whose last line has no newline.
async function appendLine(path, line) {
  let prefix = '';
  let file;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    if (size) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      if (last[0] !== 10) prefix = '\n';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await file?.close();
  }
  await appendFile(path, `${prefix}${line}\n`);
}

async function saveCheckpoint(path, nextLine) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await appendFile(temporary, `${JSON.stringify({ nextLine })}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = 4 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('batchSize must be a positive safe integer');
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
      const badPath = join(recovery, 'checkpoint.bad.json');
      // Preserve earlier recovery evidence as well, if present.
      try {
        await rename(badPath, join(recovery, `checkpoint.bad.${randomUUID()}.json`));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await rename(checkpointPath, badPath);
    }
  }

  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      if (line.trim()) seen.add(identity(JSON.parse(line)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine };
  let index = 0;
  for await (const line of lines(inputPath)) {
    if (index++ < nextLine) continue;
    let key;
    try {
      key = identity(JSON.parse(line));
    } catch {
      await appendLine(join(dirname(outputPath), 'rejected.ndjson'), line);
      report.rejected++;
      report.nextLine = index;
      continue;
    }
    if (seen.has(key)) {
      report.duplicates++;
    } else {
      await appendLine(outputPath, line);
      seen.add(key);
      report.accepted++;
    }
    report.nextLine = index;
    if (report.accepted === batchSize) break;
  }
  await saveCheckpoint(checkpointPath, report.nextLine);
  return report;
}
