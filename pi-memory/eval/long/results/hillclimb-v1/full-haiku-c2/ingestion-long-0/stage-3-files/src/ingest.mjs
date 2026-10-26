import {createReadStream} from 'node:fs';
import {access, appendFile, mkdir, open, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {dirname, join} from 'node:path';

export const DEFAULT_BATCH_SIZE = 4;

// Accepts up to batchSize new records per call. Identity is (tenant, seq); malformed lines go to rejected.ndjson.
export async function processBatch({inputPath, outputPath, checkpointPath, batchSize = DEFAULT_BATCH_SIZE}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer');

  const rejectedPath = join(dirname(outputPath), 'rejected.ndjson');
  const {nextLine: startLine, replay} = await loadCheckpoint(checkpointPath);

  // Existing output is the source of truth for what was already accepted, so replays never duplicate it.
  const seen = new Set();
  for await (const line of readLines(outputPath)) {
    const rec = parseRecord(line);
    if (rec) seen.add(keyOf(rec));
  }

  // Without a trustworthy checkpoint, earlier rejects may be replayed too; skip lines already quarantined.
  const seenRejects = new Set();
  if (replay) for await (const line of readLines(rejectedPath)) seenRejects.add(line);

  const report = {accepted: 0, rejected: 0, duplicates: 0, nextLine: startLine};
  const outLines = [];
  const rejLines = [];
  let lineNo = -1;

  for await (const raw of readLines(inputPath)) {
    lineNo++;
    if (lineNo < startLine) continue;
    if (report.accepted >= batchSize) break;
    report.nextLine = lineNo + 1;

    if (raw.trim() === '') continue;

    const rec = parseRecord(raw);
    if (!rec) {
      report.rejected++;
      if (!seenRejects.has(raw)) {
        seenRejects.add(raw);
        rejLines.push(raw);
      }
      continue;
    }

    const key = keyOf(rec);
    if (seen.has(key)) {
      report.duplicates++;
      continue;
    }
    seen.add(key);
    outLines.push(raw);
    report.accepted++;
  }

  await mkdir(dirname(outputPath), {recursive: true});
  if (outLines.length) await appendLines(outputPath, outLines);
  if (rejLines.length) await appendLines(rejectedPath, rejLines);
  await writeAtomic(checkpointPath, JSON.stringify({nextLine: report.nextLine}) + '\n');

  return report;
}

async function loadCheckpoint(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {nextLine: 0, replay: true};
    throw err;
  }
  try {
    const cp = JSON.parse(text);
    if (Number.isInteger(cp?.nextLine) && cp.nextLine >= 0) return {nextLine: cp.nextLine, replay: false};
  } catch {
    // fall through to quarantine
  }
  await quarantineCheckpoint(path);
  return {nextLine: 0, replay: true};
}

// Moves a corrupt checkpoint to recovery/checkpoint.bad.json beside it, never overwriting an earlier one.
async function quarantineCheckpoint(path) {
  const dir = join(dirname(path), 'recovery');
  await mkdir(dir, {recursive: true});
  let target = join(dir, 'checkpoint.bad.json');
  for (let n = 1; await exists(target); n++) target = join(dir, `checkpoint.bad.${n}.json`);
  await rename(path, target);
}

function parseRecord(raw) {
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (typeof rec.tenant !== 'string' || rec.tenant === '' || !Number.isInteger(rec.seq)) return null;
  return rec;
}

function keyOf(rec) {
  return JSON.stringify([rec.tenant, rec.seq]);
}

async function* readLines(path) {
  if (!(await exists(path))) return;
  const input = createReadStream(path, {encoding: 'utf8'});
  const rl = createInterface({input, crlfDelay: Infinity});
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    input.destroy();
  }
}

async function appendLines(path, lines) {
  const prefix = (await needsLeadingNewline(path)) ? '\n' : '';
  await appendFile(path, prefix + lines.map((l) => l + '\n').join(''));
}

async function needsLeadingNewline(path) {
  if (!(await exists(path))) return false;
  const {size} = await stat(path);
  if (size === 0) return false;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}

async function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
