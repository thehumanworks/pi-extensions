import {createReadStream} from 'node:fs';
import {appendFile,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';

export const DEFAULT_BATCH_SIZE = 4;

// Event identity is the (tenant, seq) pair; seq alone is not unique across tenants.
const identityOf = (event) => JSON.stringify([event.tenant, event.seq]);

function parseEvent(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.tenant !== 'string' || value.tenant === '') return null;
  if (!Number.isInteger(value.seq)) return null;
  return value;
}

async function readIfExists(path) {
  try { return await readFile(path, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// Returns the line to resume from. A corrupt checkpoint is moved aside, never deleted,
// and processing restarts at 0; existing output is preserved and deduplicated by identity.
async function loadCheckpoint(checkpointPath) {
  const text = await readIfExists(checkpointPath);
  if (text === null) return 0;
  try {
    const {nextLine} = JSON.parse(text);
    if (Number.isInteger(nextLine) && nextLine >= 0) return nextLine;
  } catch { /* fall through to recovery */ }
  const recoveryDir = join(dirname(checkpointPath), 'recovery');
  await mkdir(recoveryDir, {recursive: true});
  await rename(checkpointPath, join(recoveryDir, 'checkpoint.bad.json'));
  return 0;
}

// Write to a temp file then rename so readers never observe a partial checkpoint.
async function writeCheckpoint(checkpointPath, nextLine) {
  const tmpPath = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify({nextLine}) + '\n');
  await rename(tmpPath, checkpointPath);
}

export async function processBatch({inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer');

  const outputDir = dirname(outputPath);
  const rejectedPath = join(outputDir, 'rejected.ndjson');
  await mkdir(outputDir, {recursive: true});
  await mkdir(dirname(checkpointPath), {recursive: true});

  // Identities already written to output, so resumed or replayed input never duplicates events.
  const seen = new Set();
  for (const line of (await readIfExists(outputPath) ?? '').split('\n')) {
    const event = parseEvent(line);
    if (event) seen.add(identityOf(event));
  }

  // Input line numbers already quarantined, so replayed malformed lines are not quarantined twice.
  const quarantined = new Set();
  for (const line of (await readIfExists(rejectedPath) ?? '').split('\n')) {
    try { quarantined.add(JSON.parse(line).line); } catch { /* blank or unreadable entry */ }
  }

  const startLine = await loadCheckpoint(checkpointPath);
  const report = {accepted: 0, rejected: 0, duplicates: 0, nextLine: startLine};
  const acceptedLines = [];
  const rejectedLines = [];

  const rl = createInterface({input: createReadStream(inputPath, {encoding: 'utf8'}), crlfDelay: Infinity});
  let lineNo = 0;
  try {
    for await (const line of rl) {
      const n = lineNo++;
      if (n < startLine) continue;

      const event = parseEvent(line);
      if (!event) {
        report.rejected++;
        if (!quarantined.has(n)) rejectedLines.push(JSON.stringify({line: n, raw: line}));
      } else {
        const id = identityOf(event);
        if (seen.has(id)) {
          report.duplicates++;
        } else {
          seen.add(id);
          acceptedLines.push(line);
          report.accepted++;
        }
      }
      report.nextLine = n + 1;

      // Stop right after the record that fills the batch so the next call resumes exactly there.
      if (report.accepted === batchSize) break;
    }
  } finally {
    rl.close();
  }

  // Output and quarantine are written before the checkpoint; a crash in between is safe because
  // replay deduplicates by identity and by quarantined line number.
  if (acceptedLines.length) await appendFile(outputPath, acceptedLines.map((l) => l + '\n').join(''));
  if (rejectedLines.length) await appendFile(rejectedPath, rejectedLines.map((l) => l + '\n').join(''));
  await writeCheckpoint(checkpointPath, report.nextLine);

  return report;
}
