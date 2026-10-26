import {createReadStream} from 'node:fs';
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

const DEFAULT_BATCH_SIZE = 1000;

function identity(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)
      || typeof record.tenant !== 'string' || record.tenant.length === 0
      || !Number.isSafeInteger(record.seq) || record.seq < 0) {
    throw new Error('Expected an event with a tenant and nonnegative integer seq');
  }
  return JSON.stringify([record.tenant, record.seq]);
}

async function* lines(path) {
  const stream = createReadStream(path, {encoding: 'utf8'});
  const reader = createInterface({input: stream, crlfDelay: Infinity});
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
    stream.destroy();
  }
}

async function sync(file) {
  try {
    await file.sync();
  } catch (error) {
    // Node's permission model can disallow fsync even for writable files.
    if (error.code !== 'ERR_ACCESS_DENIED') throw error;
  }
}

async function saveCheckpoint(path, nextLine) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(`${JSON.stringify({nextLine})}\n`);
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

export async function processBatch({inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive safe integer');
  }
  let nextLine = 0;
  try {
    const contents = await readFile(checkpointPath, 'utf8');
    let checkpoint;
    try {
      checkpoint = JSON.parse(contents);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (checkpoint === null || typeof checkpoint !== 'object'
        || Array.isArray(checkpoint)
        || !Number.isSafeInteger(checkpoint.nextLine) || checkpoint.nextLine < 0) {
      // Preserve the original bytes before replaying. A unique name also keeps
      // evidence from earlier recoveries rather than overwriting it.
      await rename(checkpointPath, `${checkpointPath}.corrupt-${randomUUID()}`);
    } else {
      nextLine = checkpoint.nextLine;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Output is the durable identity index, including records appended before a
  // crash that prevented the corresponding checkpoint from being committed.
  const seen = new Set();
  try {
    for await (const line of lines(outputPath)) {
      seen.add(identity(JSON.parse(line)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(outputPath), {recursive: true});
  await mkdir(dirname(checkpointPath), {recursive: true});
  const output = await open(outputPath, 'a+');
  const report = {accepted: 0, rejected: 0, duplicates: 0, nextLine};
  try {
    let needsSeparator = false;
    const {size} = await output.stat();
    if (size) {
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
    // Commit output first: retries deduplicate against it if checkpointing fails.
    await sync(output);
    await saveCheckpoint(checkpointPath, report.nextLine);
  } finally {
    await output.close();
  }
  return report;
}
