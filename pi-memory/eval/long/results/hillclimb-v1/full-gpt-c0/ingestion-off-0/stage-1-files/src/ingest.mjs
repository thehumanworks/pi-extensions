import { createReadStream } from 'node:fs';
import { open, readFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const DEFAULT_BATCH_SIZE = 1000;

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
      typeof record.tenant !== 'string' || record.tenant.length === 0 ||
      !Number.isSafeInteger(record.seq) || record.seq < 0) {
    throw new Error('Invalid event identity');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

async function sync(file) {
  try {
    await file.sync();
  } catch (error) {
    // Some sandboxed Node runtimes prohibit fsync; writes are still awaited.
    if (error.code !== 'ERR_ACCESS_DENIED') throw error;
  }
}

async function checkpoint(path, nextLine) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(`${JSON.stringify({ nextLine })}\n`);
      await sync(file);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function processBatch({ inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE }) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('batchSize must be a positive safe integer');
  }
  let nextLine = 0;
  try {
    const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
    if (!Number.isSafeInteger(saved.nextLine) || saved.nextLine < 0) {
      throw new Error('Invalid checkpoint nextLine');
    }
    nextLine = saved.nextLine;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      if (line.trim()) seen.add(identity(JSON.parse(line)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });
  const output = await open(outputPath, 'a+');
  const report = { accepted: 0, rejected: 0, duplicates: 0, nextLine };
  try {
    const { size } = await output.stat();
    let needsSeparator = false;
    if (size > 0) {
      const last = Buffer.alloc(1);
      await output.read(last, 0, 1, size - 1);
      needsSeparator = last[0] !== 10;
    }
    let index = 0;
    let processed = 0;
    for await (const line of lines(inputPath)) {
      if (index++ < nextLine) continue;
      let key;
      try {
        key = identity(JSON.parse(line));
      } catch {
        report.rejected++;
      }
      if (key !== undefined) {
        if (seen.has(key)) {
          report.duplicates++;
        } else {
          await output.writeFile(`${needsSeparator ? '\n' : ''}${line}\n`);
          needsSeparator = false;
          seen.add(key);
          report.accepted++;
        }
      }
      report.nextLine = index;
      if (++processed === batchSize) break;
    }
    // Commit output before the checkpoint. Replays after an interrupted commit
    // are deduplicated using the already persisted output identities.
    await sync(output);
    await checkpoint(checkpointPath, report.nextLine);
  } finally {
    await output.close();
  }
  return report;
}
