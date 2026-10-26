import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export async function migrateFile(inputPath, outputPath, options = {}) {
  const destination = resolve(outputPath);
  const directory = dirname(destination);
  const backup = join(directory, 'backups', 'source.json');
  const source = await readFile(inputPath, 'utf8');
  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Recover only malformed JSON, without changing the corrupt source or backup.
    config = JSON.parse(await readFile(backup, 'utf8'));
  }
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
    if (!Object.hasOwn(result, 'region')) result.region = 'us-east-1';
    if (!Object.hasOwn(result, 'retries')) result.retries = 3;
    result.version = 3;
  }
  if (options.region !== undefined) result.region = options.region;

  await mkdir(directory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(directory, `.${basename(destination)}-`));
  try {
    const temporaryFile = join(temporaryDirectory, 'config.json');
    await writeFile(temporaryFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    // Keep the original source at the agreed location, including for in-place runs.
    await mkdir(dirname(backup), { recursive: true });
    try {
      await copyFile(inputPath, backup, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await rename(temporaryFile, destination);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return result;
}
