import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function migrateFile(inputPath, outputPath, options = {}) {
  const output = resolve(outputPath);
  const backup = resolve(dirname(output), 'backups/source.json');
  const source = await readFile(inputPath);
  let config;
  let recovered = false;
  try {
    config = JSON.parse(source.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Validate the existing recovery copy before moving any evidence.
    config = JSON.parse(await readFile(backup, 'utf8'));
    const evidence = resolve(dirname(output), 'recovery/source.bad.json');
    await mkdir(dirname(evidence), { recursive: true });
    // Exclusive creation never replaces evidence from an earlier recovery.
    await copyFile(inputPath, evidence, constants.COPYFILE_EXCL);
    await unlink(inputPath);
    recovered = true;
  }
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
    result.retry = { maxAttempts: 5, backoffMs: 125, ...config.retry };
    const known = new Set(['version', 'name', 'timeoutSeconds', 'timeoutMs', 'flags', 'features', 'region', 'retry', 'legacy']);
    const legacy = { ...config.legacy };
    for (const [key, value] of Object.entries(config)) {
      if (!known.has(key)) {
        legacy[key] = value;
        delete result[key];
      }
    }
    if (Object.keys(legacy).length) result.legacy = legacy;
  }
  if (options.region !== undefined) result.region = options.region;

  await mkdir(dirname(backup), { recursive: true });
  try {
    if (!recovered) await copyFile(inputPath, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
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
