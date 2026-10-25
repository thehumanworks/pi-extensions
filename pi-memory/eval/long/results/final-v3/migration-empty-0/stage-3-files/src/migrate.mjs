import { readFile, mkdir, open, rename, unlink, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function migrateFile(inputPath, outputPath, options = {}) {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  const backup = join(dirname(output), 'backups', 'source.json');
  let source = await readFile(input, 'utf8');
  let config;
  let recovered = false;
  try {
    config = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Never alter the damaged input or the established recovery backup.
    source = await readFile(backup, 'utf8');
    config = JSON.parse(source);
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
      delete result.timeoutSeconds;
    }
    if (Object.hasOwn(config, 'flags')) {
      if (!config.flags || typeof config.flags !== 'object' || Array.isArray(config.flags)) {
        throw new TypeError('flags must be an object');
      }
      result.features = Object.keys(config.flags).filter(key => config.flags[key] === true).sort();
      delete result.flags;
    }
    result.retry = { ...config.retry, maxAttempts: 5 };
  }
  if (options.region !== undefined) result.region = options.region;

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  await mkdir(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(serialized, 'utf8');
    await handle.close();
    handle = undefined;
    // Keep a pre-migration source backup, never replacing existing evidence.
    if (!recovered) {
      await mkdir(dirname(backup), { recursive: true });
      try {
        await copyFile(input, backup, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    await rename(temporary, output);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}
