import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

function identity(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)
      || typeof record.tenant !== 'string' || !Number.isSafeInteger(record.seq)) {
    throw new Error('Event must have a string tenant and an integer seq');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

async function* lines(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  // Forward stream errors to the iterator as well as closing resources on early exit.
  let error;
  const onError = (cause) => { error = cause; reader.close(); };
  stream.on('error', onError);
  try {
    for await (const line of reader) yield line;
    if (error) throw error;
  } finally {
    reader.close();
    stream.destroy();
    stream.removeListener('error', onError);
  }
}

async function loadCheckpoint(checkpointPath) {
  let text;
  try {
    text = await readFile(checkpointPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  try {
    const checkpoint = JSON.parse(text);
    if (!Number.isSafeInteger(checkpoint?.nextLine) || checkpoint.nextLine < 0) {
      throw new Error('Invalid checkpoint');
    }
    return checkpoint.nextLine;
  } catch {
    const recovery = join(dirname(checkpointPath), 'recovery');
    await mkdir(recovery, { recursive: true });
    const badPath = join(recovery, 'checkpoint.bad.json');
    // Preserve any earlier recovery evidence too.
    try {
      await writeFile(badPath, text, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await writeFile(join(recovery, `checkpoint.bad.${randomUUID()}.json`), text, { flag: 'wx' });
    }
    await unlink(checkpointPath);
    return 0;
  }
}

async function saveCheckpoint(checkpointPath, nextLine) {
  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ nextLine })}\n`, { flag: 'wx' });
    await rename(temporary, checkpointPath);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = 4 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  const startLine = await loadCheckpoint(checkpointPath);
  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) seen.add(identity(JSON.parse(line)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine: startLine };
  const rejectedPath = join(dirname(outputPath), 'rejected.ndjson');
  let lineNumber = 0;
  for await (const line of lines(inputPath)) {
    if (lineNumber++ < startLine) continue;
    let key;
    try {
      key = identity(JSON.parse(line));
    } catch {
      await appendFile(rejectedPath, `${line}\n`);
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
