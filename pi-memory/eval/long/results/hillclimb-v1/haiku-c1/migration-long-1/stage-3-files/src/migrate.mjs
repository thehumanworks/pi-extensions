import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_REGION = 'eu-north-7';
const DEFAULT_BACKOFF_MS = 125;
const V1_KNOWN_FIELDS = new Set(['version', 'name', 'timeoutSeconds', 'flags', 'region', 'retry']);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Replaces a truncated source with the valid backup; the corrupt bytes are moved, not discarded.
async function recoverFromBackup(sourcePath, backupPath, recoveryPath) {
  let config;
  try {
    config = JSON.parse(await readFile(backupPath, 'utf8'));
  } catch (error) {
    throw new Error(`Backup is not valid JSON: ${backupPath} (${error.message})`);
  }
  await mkdir(dirname(recoveryPath), { recursive: true });
  if (await exists(recoveryPath)) {
    throw new Error(`Refusing to overwrite existing corrupt-source evidence: ${recoveryPath}`);
  }
  await rename(sourcePath, recoveryPath);
  return config;
}

function toV3(config, options) {
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
    result.region ??= DEFAULT_REGION;
    result.retry = { backoffMs: DEFAULT_BACKOFF_MS, ...config.retry, maxAttempts: 5 };

    // Unknown source fields move under `legacy` so no source data is dropped.
    const legacy = Object.fromEntries(Object.entries(config).filter(([key]) => !V1_KNOWN_FIELDS.has(key)));
    for (const key of Object.keys(legacy)) delete result[key];
    if (Object.keys(legacy).length > 0) result.legacy = legacy;
  }
  if (options.region !== undefined) result.region = options.region;
  return result;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const source = resolve(inputPath);
  const output = resolve(outputPath);
  const outputDir = dirname(output);
  const backupPath = join(outputDir, 'backups', 'source.json');
  const recoveryPath = join(outputDir, 'recovery', 'source.bad.json');

  await mkdir(outputDir, { recursive: true });
  const lockPath = `${output}.lock`;
  const lock = await open(lockPath, 'wx');
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    const raw = await readFile(source, 'utf8');
    let config;
    try {
      config = JSON.parse(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      config = await recoverFromBackup(source, backupPath, recoveryPath);
    }

    // Exclusive creation keeps the first pre-migration backup; later runs never overwrite it.
    if (!(await exists(backupPath)) && (await exists(source))) {
      await mkdir(dirname(backupPath), { recursive: true });
      try {
        await copyFile(source, backupPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }

    const result = toV3(config, options);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
      // Atomic publication uses rename; fsync is unavailable in some sandboxes.
    } finally {
      await file.close();
    }
    await rename(temporary, output);
    return result;
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
}
