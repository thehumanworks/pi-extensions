import {copyFile, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, join} from 'node:path';

const DEFAULT_REGION = 'eu-north-7';
const DEFAULT_RETRY = {maxAttempts: 5, backoffMs: 125};
const V1_FIELDS = new Set(['version', 'name', 'timeoutSeconds', 'flags']);

export async function migrateFile(inputPath, outputPath, options = {}) {
  const outDir = dirname(outputPath);
  const backupPath = join(outDir, 'backups', 'source.json');
  const region = options.region;
  if (region !== undefined && (typeof region !== 'string' || region === '')) {
    throw new Error('region override must be a non-empty string');
  }

  const raw = await readFile(inputPath, 'utf8');
  let source;
  try {
    source = JSON.parse(raw);
    await mkdir(dirname(backupPath), {recursive: true});
    await copyFile(inputPath, backupPath, constants.COPYFILE_EXCL).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    source = await recoverFromBackup(inputPath, outDir, backupPath, err);
  }

  const result = migrate(source, region);
  await mkdir(outDir, {recursive: true});
  await writeAtomic(outputPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

// Truncated input: keep the corrupt file under recovery/, then load the
// exact backup taken by an earlier run. The backup itself is never modified.
async function recoverFromBackup(inputPath, outDir, backupPath, parseError) {
  let backupRaw;
  try {
    backupRaw = await readFile(backupPath, 'utf8');
  } catch {
    throw new Error(`invalid JSON in ${inputPath} and no backup at ${backupPath}: ${parseError.message}`);
  }
  let backup;
  try {
    backup = JSON.parse(backupRaw);
  } catch (err) {
    throw new Error(`invalid JSON in ${inputPath} and backup ${backupPath} is also invalid: ${err.message}`);
  }
  const recoveryDir = join(outDir, 'recovery');
  await mkdir(recoveryDir, {recursive: true});
  await rename(inputPath, join(recoveryDir, 'source.bad.json'));
  return backup;
}

function migrate(source, regionOverride) {
  if (!isPlainObject(source)) throw new Error('config must be a JSON object');

  if (source.version === 3) {
    const result = {...source};
    if (regionOverride !== undefined) result.region = regionOverride;
    return result;
  }

  if (source.version === 1) {
    return migrateV1(source, regionOverride);
  }

  throw new Error(`unsupported config version: ${JSON.stringify(source.version)}`);
}

function migrateV1(source, regionOverride) {
  const result = {version: 3};
  if (source.name !== undefined) result.name = source.name;
  result.region = regionOverride ?? DEFAULT_REGION;

  if (source.timeoutSeconds !== undefined) {
    if (!Number.isFinite(source.timeoutSeconds)) throw new Error('timeoutSeconds must be a finite number');
    result.timeoutMs = source.timeoutSeconds * 1000;
  }

  result.retry = {...DEFAULT_RETRY};

  if (source.flags !== undefined) {
    if (!isPlainObject(source.flags)) throw new Error('flags must be an object');
    result.features = Object.keys(source.flags)
      .filter((name) => source.flags[name] === true)
      .sort();
  }

  const legacy = {};
  for (const key of Object.keys(source)) {
    if (!V1_FIELDS.has(key)) legacy[key] = source[key];
  }
  if (Object.keys(legacy).length > 0) result.legacy = legacy;

  return result;
}

async function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, {flag: 'wx'});
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, {force: true });
    throw err;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
