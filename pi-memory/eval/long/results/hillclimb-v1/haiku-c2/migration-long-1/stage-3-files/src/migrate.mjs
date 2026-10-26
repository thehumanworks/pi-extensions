import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_REGION = 'eu-north-7';
const DEFAULT_BACKOFF_MS = 125;
const MAX_ATTEMPTS = 5;
const KNOWN_FIELDS = new Set(['version', 'name', 'timeoutSeconds', 'timeoutMs', 'flags', 'features', 'region', 'retry', 'legacy']);

export async function migrateFile(inputPath, outputPath, options = {}) {
  const output = resolve(outputPath);
  const backupPath = join(dirname(output), 'backups', 'source.json');
  const config = await readSource(inputPath, backupPath, output);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Config must be a JSON object');
  }
  if (config.version !== 1 && config.version !== 3) {
    throw new Error(`Unsupported config version: ${config.version}`);
  }

  const result = { version: 3 };
  if (config.name !== undefined) result.name = config.name;
  if (Object.hasOwn(config, 'timeoutSeconds')) {
    if (typeof config.timeoutSeconds !== 'number' || !Number.isFinite(config.timeoutSeconds * 1000)) {
      throw new TypeError('timeoutSeconds must be a finite number');
    }
    result.timeoutMs = config.timeoutSeconds * 1000;
  } else if (config.timeoutMs !== undefined) {
    result.timeoutMs = config.timeoutMs;
  }
  const enabled = config.version === 1
    ? Object.entries(config.flags ?? {}).filter(([, on]) => on === true).map(([name]) => name)
    : [...(config.features ?? [])];
  result.features = enabled.sort();
  result.region = options.region ?? config.region ?? DEFAULT_REGION;
  result.retry = { backoffMs: DEFAULT_BACKOFF_MS, ...config.retry, maxAttempts: MAX_ATTEMPTS };

  // Fields this migration does not model are kept verbatim under `legacy`.
  const legacy = { ...config.legacy };
  for (const [key, value] of Object.entries(config)) {
    if (!KNOWN_FIELDS.has(key)) legacy[key] = value;
  }
  if (Object.keys(legacy).length > 0) result.legacy = legacy;

  await mkdir(dirname(output), { recursive: true });
  const lockPath = `${output}.lock`;
  const lock = await open(lockPath, 'wx');
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    // Exclusive backup creation preserves the first recovery copy on repeated runs.
    try {
      await copyFile(output, `${output}.bak`, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
    }
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
      // Atomic publication uses rename; fsync is unavailable in some sandboxes.
    } finally {
      await file.close();
    }
    await rename(temporary, output);
  } finally {
    try {
      await unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
  return result;
}

async function readSource(inputPath, backupPath, output) {
  const text = await readFile(inputPath, 'utf8');
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return recoverFromBackup(inputPath, backupPath, output);
  }
  // The exact source backup is created once; an existing backup is never replaced.
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(inputPath, backupPath, constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  return config;
}

async function recoverFromBackup(inputPath, backupPath, output) {
  // Validate the backup before touching the corrupt source.
  const config = JSON.parse(await readFile(backupPath, 'utf8'));
  const evidencePath = join(dirname(output), 'recovery', 'source.bad.json');
  await mkdir(dirname(evidencePath), { recursive: true });
  // Exclusive copy keeps earlier corrupt evidence; the original is removed only after that copy succeeds.
  await copyFile(inputPath, evidencePath, constants.COPYFILE_EXCL);
  await unlink(inputPath);
  return config;
}
