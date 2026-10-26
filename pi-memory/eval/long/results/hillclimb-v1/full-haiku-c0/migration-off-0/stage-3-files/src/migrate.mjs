import {readFile, writeFile, rename, copyFile, access, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, basename, join} from 'node:path';

const CURRENT_VERSION = 3;

// Writes JSON atomically: temp file in the same directory, then rename.
async function writeJsonAtomic(path, value) {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(tmp, path);
  } finally {
    await rm(tmp, {force: true});
  }
}

// Keeps any existing output as a timestamped backup before it is replaced.
async function backupExisting(path) {
  try {
    await access(path);
  } catch {
    return null;
  }
  const backup = `${path}.bak-${Date.now()}`;
  await copyFile(path, backup);
  return backup;
}

function migrateV1(input) {
  const {version, name, timeoutSeconds, flags, ...rest} = input;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error('v1 config requires a non-negative numeric timeoutSeconds');
  }
  const features = Object.keys(flags ?? {})
    .filter((key) => flags[key] === true)
    .sort();
  // Unknown top-level fields (customer data) are carried over unchanged.
  return {
    ...rest,
    version: CURRENT_VERSION,
    name,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    features,
  };
}

function migrateV3(input) {
  return {...input};
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config must be a JSON object');
  }

  let result;
  if (input.version === 1) {
    result = migrateV1(input);
  } else if (input.version === CURRENT_VERSION) {
    result = migrateV3(input);
  } else {
    throw new Error(`unsupported config version: ${input.version}`);
  }

  // Region override is invocation-only: it is applied to the result but never persisted elsewhere.
  if (options.region !== undefined) {
    result.region = options.region;
  }

  await backupExisting(outputPath);
  await writeJsonAtomic(outputPath, result);
  return result;
}
