import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function migrateFile(inputPath, outputPath, options = {}) {
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  const lockPath = `${output}.lock`;
  const lock = await open(lockPath, 'wx');
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
  let config;
  const source = await readFile(inputPath, 'utf8');
  try {
    config = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backup = resolve(dirname(output), 'backups/source.json');
    const evidence = resolve(dirname(output), 'recovery/source.bad.json');
    // Never overwrite the recovery backup or previously preserved evidence.
    if (resolve(inputPath) === backup) throw error;
    const recovered = JSON.parse(await readFile(backup, 'utf8'));
    if (!recovered || typeof recovered !== 'object' || Array.isArray(recovered)
        || ![1, 3].includes(recovered.version)) {
      throw new TypeError('Recovery backup must be a supported config object');
    }
    await mkdir(dirname(evidence), { recursive: true });
    await copyFile(inputPath, evidence, constants.COPYFILE_EXCL);
    await unlink(inputPath);
    config = recovered;
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
    result.region ??= 'us-east-1';
    result.retry = { backoffMs: 1000, ...config.retry, maxAttempts: 5 };
  }
  if (options.region !== undefined) result.region = options.region;

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
