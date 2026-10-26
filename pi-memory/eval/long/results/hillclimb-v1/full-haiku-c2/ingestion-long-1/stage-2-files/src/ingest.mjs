import {createReadStream} from 'node:fs';
import {appendFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {dirname, join} from 'node:path';

export const DEFAULT_BATCH_SIZE = 4;

// Events are identified by the (tenant, seq) pair; seq alone is not unique across tenants.
const identityOf = (tenant, seq) => JSON.stringify([tenant, seq]);

function parseEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
  if (typeof event.tenant !== 'string' || event.tenant === '') return null;
  if (!Number.isInteger(event.seq)) return null;
  return event;
}

async function readLines(path, onLine) {
  const rl = createInterface({input: createReadStream(path, 'utf8'), crlfDelay: Infinity});
  try {
    for await (const line of rl) {
      if (onLine(line) === false) break;
    }
  } finally {
    rl.close();
  }
}

async function loadExisting(outputPath) {
  const seen = new Set();
  let lastLine = null;
  try {
    await readLines(outputPath, (line) => {
      lastLine = line;
      const event = parseEvent(line);
      if (event) seen.add(identityOf(event.tenant, event.seq));
    });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return {seen, needsNewline: false};
  }
  return {seen, needsNewline: lastLine !== null && !(await endsWithNewline(outputPath))};
}

async function endsWithNewline(path) {
  const text = await readFile(path, 'utf8');
  return text === '' || text.endsWith('\n');
}

async function loadCheckpoint(checkpointPath) {
  let raw;
  try {
    raw = await readFile(checkpointPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {nextLine: 0};
    throw err;
  }
  try {
    const checkpoint = JSON.parse(raw);
    if (Number.isInteger(checkpoint.nextLine) && checkpoint.nextLine >= 0) return checkpoint;
  } catch {
    // fall through to recovery
  }
  // Corrupt checkpoint: move it aside and replay input from the start.
  // Identity checks against existing output prevent re-appending events.
  const recoveryDir = join(dirname(checkpointPath), 'recovery');
  await mkdir(recoveryDir, {recursive: true});
  await rename(checkpointPath, join(recoveryDir, 'checkpoint.bad.json'));
  return {nextLine: 0};
}

async function writeCheckpointAtomic(checkpointPath, nextLine) {
  await mkdir(dirname(checkpointPath), {recursive: true});
  const tmpPath = `${checkpointPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify({nextLine}) + '\n');
  await rename(tmpPath, checkpointPath);
}

export async function processBatch({inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, got ${batchSize}`);
  }

  const checkpoint = await loadCheckpoint(checkpointPath);
  const existing = await loadExisting(outputPath);
  const seen = existing.seen;
  const rejectedPath = join(dirname(outputPath), 'rejected.ndjson');

  const report = {accepted: 0, rejected: 0, duplicates: 0, nextLine: checkpoint.nextLine};
  const acceptedLines = [];
  const rejectedLines = [];
  let index = -1;

  await readLines(inputPath, (line) => {
    index++;
    if (index < checkpoint.nextLine) return true;

    const event = parseEvent(line);
    if (!event) {
      rejectedLines.push(line);
      report.rejected++;
    } else {
      const id = identityOf(event.tenant, event.seq);
      if (seen.has(id)) {
        report.duplicates++;
      } else {
        seen.add(id);
        acceptedLines.push(line);
        report.accepted++;
      }
    }
    report.nextLine = index + 1;
    return report.accepted < batchSize;
  });

  await mkdir(dirname(outputPath), {recursive: true});
  if (acceptedLines.length > 0) {
    const prefix = existing.needsNewline ? '\n' : '';
    await appendFile(outputPath, prefix + acceptedLines.join('\n') + '\n');
  }
  if (rejectedLines.length > 0) {
    await appendFile(rejectedPath, rejectedLines.join('\n') + '\n');
  }
  await writeCheckpointAtomic(checkpointPath, report.nextLine);

  return report;
}
