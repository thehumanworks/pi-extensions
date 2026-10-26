import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const V1_KNOWN_KEYS = new Set(['version', 'name', 'timeoutSeconds', 'flags', 'region', 'retry']);

// Reads the source; when it is truncated JSON, recovers from the exact backup beside the output.
async function readSource(inputPath, output) {
  const raw = await readFile(inputPath, 'utf8');
  try {
    return { raw, config: JSON.parse(raw) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const dir = dirname(output);
  const backupRaw = await readFile(join(dir, 'backups', 'source.json'), 'utf8');
  const config = JSON.parse(backupRaw);
  // Move the corrupt bytes aside as evidence; COPYFILE_EXCL never clobbers earlier evidence.
  const badPath = join(dir, 'recovery', 'source.bad.json');
  await mkdir(dirname(badPath), { recursive: true });
  await copyFile(inputPath, badPath, constants.COPYFILE_EXCL);
  await unlink(inputPath);
  return { raw: backupRaw, config };
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const output = resolve(outputPath);
  const { raw, config } = await readSource(inputPath, output);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Config must be a JSON object');
  }
  if (config.version !== 1 && config.version !== 3) {
    throw new Error(`Unsupported config version: ${config.version}`);
  }

  const result = { ...config };
  if (config.version === 1) {
    result.version = 3;
    if (Object.hasOwn(config, 'timeoutSeconds')) {
      if (typeof config.timeoutSeconds !== 'number' || !Number.isFinite(config.timeoutSeconds * 1000)) {
        throw new TypeError('timeoutSeconds must be a finite number');
      }
      result.timeoutMs = config.timeoutSeconds * 1000;
    }
    result.features = Object.entries(config.flags ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name)
      .sort();
    delete result.timeoutSeconds;
    delete result.flags;
    result.region ??= 'eu-north-7';
    result.retry = { backoffMs: 125, ...config.retry, maxAttempts: 5 };
    // Unknown source fields are kept under `legacy` instead of being dropped.
    const legacy = {};
    for (const key of Object.keys(config)) {
      if (!V1_KNOWN_KEYS.has(key)) {
        legacy[key] = config[key];
        delete result[key];
      }
    }
    if (Object.keys(legacy).length > 0) result.legacy = legacy;
  }
  if (options.region !== undefined) result.region = options.region;

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
    // The exact source backup is written once and never overwritten.
    const backupPath = join(dirname(output), 'backups', 'source.json');
    await mkdir(dirname(backupPath), { recursive: true });
    try {
      await writeFile(backupPath, raw, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
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
