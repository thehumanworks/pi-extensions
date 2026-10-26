import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

function identity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
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

async function appendLine(path, line) {
  // Do not join a new record onto an existing unterminated final line.
  let separator = '';
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    if (size) {
      const byte = Buffer.alloc(1);
      await handle.read(byte, 0, 1, size - 1);
      if (byte[0] !== 10) separator = '\n';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }
  await appendFile(path, `${separator}${line}\n`);
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
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
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
      if (!Number.isSafeInteger(checkpoint?.nextLine) || checkpoint.nextLine < 0) {
        throw new Error('Invalid checkpoint');
      }
      nextLine = checkpoint.nextLine;
    } catch {
      const recovery = join(dirname(checkpointPath), 'recovery');
      await mkdir(recovery, { recursive: true });
      const backup = join(recovery, 'checkpoint.bad.json');
      // Preserve earlier recovery evidence too, if present.
      try {
        await readFile(backup);
        await rename(backup, join(recovery, `checkpoint.bad.${randomUUID()}.json`));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await rename(checkpointPath, backup);
      // A corrupt cursor cannot be trusted. Replay from the beginning; the
      // output identity set below prevents already-written events being lost
      // or appended again, including events from tenants sharing a sequence.
      nextLine = 0;
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

  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine };
  let lineNumber = 0;
  for await (const line of lines(inputPath)) {
    if (lineNumber++ < nextLine) continue;
    let key;
    try {
      key = identity(JSON.parse(line));
    } catch {
      await appendLine(join(dirname(outputPath), 'rejected.ndjson'), line);
      report.rejected++;
      report.nextLine = lineNumber;
      continue;
    }
    if (seen.has(key)) {
      report.duplicates++;
    } else {
      await appendLine(outputPath, line);
      seen.add(key);
      report.accepted++;
    }
    report.nextLine = lineNumber;
    if (report.accepted === batchSize) break;
  }
  await saveCheckpoint(checkpointPath, report.nextLine);
  return report;
}
