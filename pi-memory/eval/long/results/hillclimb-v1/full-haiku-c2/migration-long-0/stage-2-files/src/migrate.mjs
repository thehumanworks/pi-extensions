import {copyFile, mkdir, readFile, rename, writeFile, access} from 'node:fs/promises';
import {dirname, join} from 'node:path';

const DEFAULT_REGION = 'eu-north-7';
const DEFAULT_RETRY = {maxAttempts: 5, backoffMs: 125};
const V1_KNOWN = new Set(['version', 'name', 'timeoutSeconds', 'flags']);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

function pickUnknown(source, known) {
  const legacy = {};
  for (const key of Object.keys(source)) {
    if (!known.has(key)) legacy[key] = source[key];
  }
  return legacy;
}

function convertV1(source, options) {
  const result = {
    version: 3,
    name: source.name,
    region: options.region ?? DEFAULT_REGION,
    retry: {...DEFAULT_RETRY},
    features: Object.keys(source.flags ?? {})
      .filter((key) => source.flags[key] === true)
      .sort(),
  };
  if (source.timeoutSeconds !== undefined) result.timeoutMs = source.timeoutSeconds * 1000;
  const legacy = pickUnknown(source, V1_KNOWN);
  if (Object.keys(legacy).length > 0) result.legacy = legacy;
  return result;
}

function convertV3(source, options) {
  const result = {...source};
  if (options.region !== undefined) result.region = options.region;
  return result;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const outputDir = dirname(outputPath);
  const backupPath = join(outputDir, 'backups', 'source.json');
  const recoveryPath = join(outputDir, 'recovery', 'source.bad.json');
  const inputText = await readFile(inputPath, 'utf8');

  let source;
  try {
    source = JSON.parse(inputText);
  } catch (error) {
    // Truncated input: quarantine the corrupt file and recover from the existing backup.
    if (!(await exists(backupPath))) {
      throw new Error(`invalid JSON in ${inputPath} and no backup at ${backupPath}: ${error.message}`);
    }
    if (await exists(recoveryPath)) {
      throw new Error(`refusing to overwrite existing ${recoveryPath}`);
    }
    await mkdir(dirname(recoveryPath), {recursive: true});
    await rename(inputPath, recoveryPath);
    source = JSON.parse(await readFile(backupPath, 'utf8'));
  }

  if (!(await exists(backupPath))) {
    await mkdir(dirname(backupPath), {recursive: true});
    await copyFile(inputPath, backupPath);
  }

  let result;
  if (source.version === 1) {
    result = convertV1(source, options);
  } else if (source.version === 3) {
    result = convertV3(source, options);
  } else {
    throw new Error(`unsupported config version: ${source.version}`);
  }

  await mkdir(outputDir, {recursive: true});
  await writeAtomic(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
