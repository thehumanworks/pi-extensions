import { readFile, mkdir, open, rename, unlink, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function migrateFile(inputPath, outputPath, options = {}) {
  const config = JSON.parse(await readFile(inputPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Config must be a JSON object');
  }
  if (![1, 2, 3].includes(config.version)) {
    throw new Error(`Unsupported config version: ${config.version}`);
  }

  const result = { ...config };
  if (config.version !== 3) {
    if (config.version === 1) {
      if (Object.hasOwn(config, 'timeoutSeconds')) {
        if (typeof config.timeoutSeconds !== 'number' || !Number.isFinite(config.timeoutSeconds * 1000)) {
          throw new TypeError('timeoutSeconds must be a finite number');
        }
        result.timeoutMs = config.timeoutSeconds * 1000;
        delete result.timeoutSeconds;
      }
      if (Object.hasOwn(config, 'flags')) {
        if (!config.flags || typeof config.flags !== 'object' || Array.isArray(config.flags)) {
          throw new TypeError('flags must be an object');
        }
        result.features = Object.keys(config.flags).filter(key => config.flags[key] === true).sort();
        delete result.flags;
      }
    }
    result.region = config.region ?? 'eu-west-1';
    result.retry = { backoff: 'exponential', ...config.retry, maxAttempts: 5 };
    result.version = 3;
  }
  if (options.region !== undefined) result.region = options.region;

  const directory = dirname(outputPath);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
    try {
      await handle.sync();
    } catch (error) {
      // Node's permission model can prohibit fsync; rename remains atomic.
      if (error.code !== 'ERR_ACCESS_DENIED') throw error;
    }
    await handle.close();
    handle = undefined;
    // Preserve the first recovery copy, including for in-place migration.
    try {
      await copyFile(outputPath, `${outputPath}.bak`, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
    }
    await rename(temporary, outputPath);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}
