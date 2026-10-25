import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

function identity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.tenant !== 'string' || !Number.isSafeInteger(record.seq)) {
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

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function checkpoint(path, nextLine) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ nextLine }) + '\n', { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = 4 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive safe integer');
  }
  for (const path of [inputPath, outputPath, checkpointPath]) {
    if (typeof path !== 'string' || !path) throw new TypeError('File paths are required');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  let nextLine = 0;
  let saved;
  try { saved = await readFile(checkpointPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved !== undefined) {
    try {
      const parsed = JSON.parse(saved);
      if (!Number.isSafeInteger(parsed.nextLine) || parsed.nextLine < 0) throw new Error('Invalid checkpoint');
      nextLine = parsed.nextLine;
    } catch {
      const recovery = join(dirname(checkpointPath), 'recovery');
      await mkdir(recovery, { recursive: true });
      let backup = join(recovery, 'checkpoint.bad.json');
      if (await exists(backup)) backup = join(recovery, `checkpoint.bad.${randomUUID()}.json`);
      await rename(checkpointPath, backup);
    }
  }

  const seen = new Set();
  if (await exists(outputPath)) {
    for await (const line of lines(outputPath)) {
      if (line.trim()) seen.add(identity(JSON.parse(line)));
    }
    // Ensure an existing final record without a newline is not joined to the next one.
    const handle = await import('node:fs/promises').then(fs => fs.open(outputPath, 'r'));
    try {
      const { size } = await handle.stat();
      if (size) {
        const byte = Buffer.alloc(1);
        await handle.read(byte, 0, 1, size - 1);
        if (byte[0] !== 10) await appendFile(outputPath, '\n');
      }
    } finally { await handle.close(); }
  }

  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine };
  let index = 0;
  for await (const line of lines(inputPath)) {
    if (index++ < nextLine) continue;
    let key;
    try { key = identity(JSON.parse(line)); }
    catch {
      await appendFile(join(dirname(outputPath), 'rejected.ndjson'), line + '\n');
      report.rejected++;
      report.nextLine = index;
      continue;
    }
    if (seen.has(key)) report.duplicates++;
    else {
      await appendFile(outputPath, line + '\n');
      seen.add(key);
      report.accepted++;
    }
    report.nextLine = index;
    if (report.accepted === batchSize) break;
  }
  await checkpoint(checkpointPath, report.nextLine);
  return report;
}
