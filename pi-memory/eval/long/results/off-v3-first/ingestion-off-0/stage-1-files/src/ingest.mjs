import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const DEFAULT_BATCH_SIZE = 1000;

function identity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.tenant !== 'string' || !record.tenant.length ||
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
  try {
    await writeDurably(temporary, `${JSON.stringify({ nextLine })}\n`);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function sync(file) {
  try {
    await file.sync();
  } catch (error) {
    // Node's permission model disables fsync even for writable files.
    if (error.code !== 'ERR_ACCESS_DENIED') throw error;
  }
}

async function writeDurably(path, contents) {
  const file = await open(path, 'wx');
  try {
    await file.writeFile(contents);
    await sync(file);
  } finally {
    await file.close();
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE }) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('batchSize must be a positive safe integer');
  }
  let nextLine = 0;
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    if (!Number.isSafeInteger(checkpoint.nextLine) || checkpoint.nextLine < 0) {
      throw new Error('Invalid checkpoint nextLine');
    }
    nextLine = checkpoint.nextLine;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      const key = identity(JSON.parse(line));
      if (key === null) throw new Error('Invalid record in existing output');
      seen.add(key);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  const output = await open(outputPath, 'a+');
  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine };
  try {
    // Keep an existing final record intact even if its newline is absent.
    const { size } = await output.stat();
    let needsSeparator = false;
    if (size) {
      const last = Buffer.alloc(1);
      await output.read(last, 0, 1, size - 1);
      needsSeparator = last[0] !== 10;
    }
    let index = 0;
    let processed = 0;
    for await (const line of lines(inputPath)) {
      if (index++ < nextLine) continue;
      let key = null;
      try { key = identity(JSON.parse(line)); } catch { /* Reject malformed JSON. */ }
      if (key === null) {
        report.rejected++;
      } else if (seen.has(key)) {
        report.duplicates++;
      } else {
        await output.writeFile(`${needsSeparator ? '\n' : ''}${line}\n`);
        needsSeparator = false;
        seen.add(key);
        report.accepted++;
      }
      report.nextLine = index;
      if (++processed === batchSize) break;
    }
    // Output must reach disk before checkpoint advancement. On a retry,
    // identities already in the output suppress replayed records.
    await sync(output);
    await saveCheckpoint(checkpointPath, report.nextLine);
    return report;
  } finally {
    await output.close();
  }
}
