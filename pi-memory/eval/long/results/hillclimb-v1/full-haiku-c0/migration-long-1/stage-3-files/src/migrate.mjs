import {copyFile, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, join} from 'node:path';

const DEFAULT_REGION = 'eu-north-7';
const DEFAULT_RETRY = {maxAttempts: 5, backoffMs: 125};
const V1_KNOWN_FIELDS = new Set(['version', 'name', 'timeoutSeconds', 'flags']);

function parseConfig(text) {
  return JSON.parse(text);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Keeps a byte-for-byte copy of the source beside the output. An existing backup is never overwritten.
async function ensureBackup(inputPath, backupPath) {
  await mkdir(dirname(backupPath), {recursive: true});
  try {
    await copyFile(inputPath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// Reads the source. If it is truncated or invalid JSON, the corrupt file is moved to recovery/source.bad.json
// and the valid backup is used instead. The backup itself is left unchanged.
async function loadSource(inputPath, backupPath, recoveryPath) {
  const text = await readFile(inputPath, 'utf8');
  try {
    return parseConfig(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    let backup;
    try {
      backup = parseConfig(await readFile(backupPath, 'utf8'));
    } catch {
      throw new Error(`source is invalid JSON and no valid backup exists at ${backupPath}: ${error.message}`);
    }
    await mkdir(dirname(recoveryPath), {recursive: true});
    await rename(inputPath, recoveryPath);
    return backup;
  }
}

function migrateV1(source, region) {
  const features = isObject(source.flags)
    ? Object.keys(source.flags).filter((name) => source.flags[name] === true).sort()
    : [];

  const legacy = {};
  for (const key of Object.keys(source)) {
    if (!V1_KNOWN_FIELDS.has(key)) legacy[key] = source[key];
  }

  const result = {
    version: 3,
    name: source.name,
    region,
    retry: {...DEFAULT_RETRY},
    features,
  };
  if (source.timeoutSeconds !== undefined) result.timeoutMs = source.timeoutSeconds * 1000;
  if (Object.keys(legacy).length > 0) result.legacy = legacy;
  return result;
}

async function writeAtomic(outputPath, value) {
  await mkdir(dirname(outputPath), {recursive: true});
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, outputPath);
  } catch (error) {
    await rm(tempPath, {force: true});
    throw error;
  }
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  if (options.region !== undefined && (typeof options.region !== 'string' || options.region === '')) {
    throw new Error('options.region must be a non-empty string');
  }

  const outputDir = dirname(outputPath);
  const backupPath = join(outputDir, 'backups', 'source.json');
  const recoveryPath = join(outputDir, 'recovery', 'source.bad.json');

  await ensureBackup(inputPath, backupPath);
  const source = await loadSource(inputPath, backupPath, recoveryPath);

  if (!isObject(source)) throw new Error('config must be a JSON object');

  let result;
  if (source.version === 1) {
    result = migrateV1(source, options.region ?? DEFAULT_REGION);
  } else if (source.version === 3) {
    result = structuredClone(source);
    if (options.region !== undefined) result.region = options.region;
  } else {
    throw new Error(`unsupported config version: ${source.version}`);
  }

  await writeAtomic(outputPath, result);
  return result;
}
