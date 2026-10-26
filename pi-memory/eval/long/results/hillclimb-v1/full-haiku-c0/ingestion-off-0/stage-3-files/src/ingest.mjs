import {createReadStream} from 'node:fs';
import {access, appendFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createInterface} from 'node:readline';

// Placeholder for the agreed project default; an explicit batchSize overrides it.
export const DEFAULT_BATCH_SIZE = 100;

// An event's identity is its (tenant, seq) pair.
function eventKey(record) {
  return JSON.stringify([record.tenant, record.seq]);
}

// Returns the parsed event, or null when the line is malformed.
function parseEvent(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  if (typeof record.tenant !== 'string' || record.tenant === '') return null;
  if (!Number.isInteger(record.seq)) return null;
  return record;
}

// Keep the corrupt bytes as evidence under the first free `.corrupt` name; never overwrite them.
async function quarantineCheckpoint(checkpointPath) {
  let quarantinePath = `${checkpointPath}.corrupt`;
  for (let n = 2; ; n++) {
    try {
      await access(quarantinePath);
      quarantinePath = `${checkpointPath}.corrupt-${n}`;
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
  }
  await rename(checkpointPath, quarantinePath);
  return quarantinePath;
}

// A corrupt checkpoint is quarantined and processing restarts at line 0. Records already
// in the output are skipped by the rebuilt key set, so nothing is appended twice.
async function readCheckpoint(checkpointPath) {
  let text;
  try {
    text = await readFile(checkpointPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {nextLine: 0};
    throw err;
  }
  let nextLine;
  try {
    ({nextLine} = JSON.parse(text));
  } catch {
    nextLine = undefined;
  }
  if (!Number.isInteger(nextLine) || nextLine < 0) {
    const quarantinedTo = await quarantineCheckpoint(checkpointPath);
    return {nextLine: 0, quarantinedTo};
  }
  return {nextLine, quarantinedTo: undefined};
}

// Write to a temp file, then rename, so a crash never leaves a partial checkpoint.
async function writeCheckpoint(checkpointPath, nextLine) {
  const tmpPath = `${checkpointPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify({nextLine}) + '\n');
  await rename(tmpPath, checkpointPath);
}

// Rebuild the identities already written so re-processed lines are not appended twice.
async function loadWrittenKeys(outputPath) {
  const keys = new Set();
  let text;
  try {
    text = await readFile(outputPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return keys;
    throw err;
  }
  for (const line of text.split('\n')) {
    const record = line === '' ? null : parseEvent(line);
    if (record) keys.add(eventKey(record));
  }
  return keys;
}

export async function processBatch({inputPath,outputPath,checkpointPath,batchSize = DEFAULT_BATCH_SIZE}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }

  const {nextLine: startLine, quarantinedTo} = await readCheckpoint(checkpointPath);
  const writtenKeys = await loadWrittenKeys(outputPath);
  const report = {accepted: 0, rejected: 0, duplicates: 0, nextLine: startLine};
  if (quarantinedTo) report.quarantinedTo = quarantinedTo;
  const acceptedLines = [];

  // Stream the input so only one line is held in memory at a time.
  const rl = createInterface({input: createReadStream(inputPath), crlfDelay: Infinity});
  let lineIndex = 0;
  let processed = 0;
  try {
    for await (const line of rl) {
      if (lineIndex++ < startLine) continue;
      if (processed === batchSize) break;
      processed++;

      const record = parseEvent(line);
      if (!record) {
        report.rejected++;
        continue;
      }
      const key = eventKey(record);
      if (writtenKeys.has(key)) {
        report.duplicates++;
        continue;
      }
      writtenKeys.add(key);
      acceptedLines.push(line);
      report.accepted++;
    }
  } finally {
    rl.close();
  }

  report.nextLine = startLine + processed;

  // Output is appended before the checkpoint advances; a crash in between is harmless
  // because the rebuilt key set above suppresses the repeat on the next call.
  if (acceptedLines.length > 0) {
    await mkdir(dirname(outputPath), {recursive: true});
    await appendFile(outputPath, acceptedLines.map((line) => line + '\n').join(''));
  }
  await mkdir(dirname(checkpointPath), {recursive: true});
  await writeCheckpoint(checkpointPath, report.nextLine);

  return report;
}
