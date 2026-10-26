import {createReadStream} from 'node:fs';
import {appendFile, readFile, rename, writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';

// Assumed project default: the agreed value was not recorded in the repo.
export const DEFAULT_BATCH_SIZE = 1000;

// Event identity is the (tenant, seq) pair. The first occurrence wins.
function identityOf(record) {
  return JSON.stringify([record.tenant, record.seq]);
}

// Malformed lines (invalid JSON, non-object, missing tenant/seq) are rejected.
function parseRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  if (typeof record.tenant !== 'string' || record.tenant === '') return null;
  if (!Number.isSafeInteger(record.seq)) return null;
  return record;
}

async function readCheckpoint(checkpointPath) {
  let text;
  try {
    text = await readFile(checkpointPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  const {nextLine} = JSON.parse(text);
  if (!Number.isSafeInteger(nextLine) || nextLine < 0) {
    throw new Error(`invalid checkpoint: ${checkpointPath}`);
  }
  return nextLine;
}

// Write to a temp file then rename so readers never see a partial checkpoint.
async function writeCheckpoint(checkpointPath, nextLine) {
  const tmpPath = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify({nextLine})}\n`);
  await rename(tmpPath, checkpointPath);
}

// Identities already in the output, so a retry after a crash never re-appends them.
async function loadIdentities(outputPath) {
  const identities = new Set();
  const rl = createInterface({input: createReadStream(outputPath, {encoding: 'utf8'}), crlfDelay: Infinity});
  try {
    for await (const line of rl) {
      const record = parseRecord(line);
      if (record) identities.add(identityOf(record));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return identities;
}

export async function processBatch({inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE}) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError(`batchSize must be a positive integer, got ${batchSize}`);
  }

  const start = await readCheckpoint(checkpointPath);
  const identities = await loadIdentities(outputPath);
  const report = {accepted: 0, rejected: 0, duplicates: 0, nextLine: start};
  const acceptedLines = [];

  const input = createInterface({input: createReadStream(inputPath, {encoding: 'utf8'}), crlfDelay: Infinity});
  let linesRead = 0;
  let processed = 0;
  for await (const line of input) {
    if (linesRead < start) {
      linesRead++;
      continue;
    }
    if (processed === batchSize) break;
    linesRead++;
    processed++;

    const record = parseRecord(line);
    if (!record) {
      report.rejected++;
      continue;
    }
    const identity = identityOf(record);
    if (identities.has(identity)) {
      report.duplicates++;
      continue;
    }
    identities.add(identity);
    acceptedLines.push(line);
    report.accepted++;
  }
  input.close();

  if (linesRead < start) {
    throw new Error(`checkpoint nextLine ${start} is beyond end of input (${linesRead} lines)`);
  }

  // Append output before advancing the checkpoint. A crash in between is safe: the retry sees these identities as duplicates.
  if (acceptedLines.length > 0) {
    await appendFile(outputPath, acceptedLines.map((line) => `${line}\n`).join(''));
  }
  report.nextLine = start + processed;
  await writeCheckpoint(checkpointPath, report.nextLine);
  return report;
}
