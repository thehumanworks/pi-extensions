import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function migrate(config, options) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Config must be a JSON object');
  }
  let result;
  if (config.version === 3) {
    result = { ...config };
  } else if (config.version === 1) {
    const known = new Set(['version', 'name', 'timeoutSeconds', 'flags', 'region', 'retry', 'legacy']);
    const legacy = { ...config.legacy };
    for (const [key, value] of Object.entries(config)) {
      if (!known.has(key)) {
        Object.defineProperty(legacy, key, { value, enumerable: true, configurable: true, writable: true });
      }
    }
    result = {
      version: 3,
      ...(Object.hasOwn(config, 'name') ? { name: config.name } : {}),
      ...(Object.hasOwn(config, 'timeoutSeconds') ? { timeoutMs: config.timeoutSeconds * 1000 } : {}),
      features: Object.keys(config.flags ?? {}).filter(key => config.flags[key] === true).sort(),
      region: config.region ?? 'eu-north-7',
      retry: { maxAttempts: 5, backoffMs: 125, ...config.retry },
      ...(Object.keys(legacy).length ? { legacy } : {}),
    };
  } else {
    throw new Error(`Unsupported config version: ${config.version}`);
  }
  if (options.region !== undefined) result.region = options.region;
  return result;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const directory = dirname(outputPath);
  const backupPath = join(directory, 'backups', 'source.json');
  const source = await readFile(inputPath, 'utf8');
  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Validate the recovery source before moving the damaged input.
    config = JSON.parse(await readFile(backupPath, 'utf8'));
    const recoveryPath = join(directory, 'recovery', 'source.bad.json');
    await mkdir(dirname(recoveryPath), { recursive: true });
    await copyFile(inputPath, recoveryPath, constants.COPYFILE_EXCL);
    await unlink(inputPath);
  }
  const result = migrate(config, options);
  await mkdir(dirname(backupPath), { recursive: true });
  // Exclusive creation preserves a previous backup, including during recovery.
  try {
    await writeFile(backupPath, source, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const temporaryPath = join(directory, `.migration-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}
