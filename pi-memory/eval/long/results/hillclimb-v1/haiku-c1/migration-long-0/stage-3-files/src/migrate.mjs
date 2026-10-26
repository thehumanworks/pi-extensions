import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_REGION = 'eu-north-7';
const DEFAULT_BACKOFF_MS = 125;
const MAX_ATTEMPTS = 5;

// Reads the source; a truncated source is moved aside as evidence and replaced by the valid backup.
async function readConfig(inputPath, output) {
  const text = await readFile(inputPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backupPath = join(dirname(output), 'backups', 'source.json');
    const recovered = JSON.parse(await readFile(backupPath, 'utf8'));
    const badPath = join(dirname(output), 'recovery', 'source.bad.json');
    await mkdir(dirname(badPath), { recursive: true });
    // COPYFILE_EXCL keeps any earlier corrupt-source evidence instead of overwriting it.
    await copyFile(inputPath, badPath, constants.COPYFILE_EXCL);
    await unlink(inputPath);
    return recovered;
  }
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const output = resolve(outputPath);
  const config = await readConfig(inputPath, output);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Config must be a JSON object');
  }
  if (config.version !== 1 && config.version !== 3) {
    throw new Error(`Unsupported config version: ${config.version}`);
  }

  const { version, name, timeoutSeconds, flags, timeoutMs, features, region, retry, ...legacy } = config;
  const result = { version: 3, name };
  if (version === 1) {
    if (Object.hasOwn(config, 'timeoutSeconds')) {
      if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds * 1000)) {
        throw new TypeError('timeoutSeconds must be a finite number');
      }
      result.timeoutMs = timeoutSeconds * 1000;
    }
  } else if (timeoutMs !== undefined) {
    result.timeoutMs = timeoutMs;
  }
  const enabled = version === 1
    ? Object.entries(flags ?? {}).filter(([, on]) => on === true).map(([feature]) => feature)
    : features ?? [];
  result.features = [...enabled].sort();
  // Source values win; v3 defaults only fill gaps. maxAttempts is always the v3 value.
  result.region = options.region ?? region ?? DEFAULT_REGION;
  result.retry = { backoffMs: DEFAULT_BACKOFF_MS, ...retry, maxAttempts: MAX_ATTEMPTS };
  if (Object.keys(legacy).length > 0) result.legacy = legacy;

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
