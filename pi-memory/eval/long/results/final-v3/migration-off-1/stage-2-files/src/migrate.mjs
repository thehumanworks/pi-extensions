import { readFile, mkdir, open, rename, copyFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';

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
    result.version = 3;
    if (!Object.hasOwn(result, 'region')) result.region = 'us-east-1';
    if (!Object.hasOwn(result, 'retries')) result.retries = 3;
  }
  if (options.region !== undefined) result.region = options.region;

  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await handle.close();
    handle = undefined;
    try {
      // Never overwrite a backup from an earlier migration.
      await copyFile(destination, `${destination}.bak`, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
    }
    await rename(temporary, destination);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}
