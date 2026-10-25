import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function migrateFile(inputPath, outputPath, options = {}) {
  const original = JSON.parse(await readFile(inputPath, 'utf8'));
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw new TypeError('Config must be a JSON object');
  }
  if (original.version !== 1 && original.version !== 3) {
    throw new Error(`Unsupported config version: ${original.version}`);
  }

  const config = { ...original };
  if (original.version === 1) {
    config.version = 3;
    if (Object.hasOwn(original, 'timeoutSeconds')) {
      if (typeof original.timeoutSeconds !== 'number' || !Number.isFinite(original.timeoutSeconds * 1000)) {
        throw new TypeError('timeoutSeconds must be a finite number');
      }
      config.timeoutMs = original.timeoutSeconds * 1000;
    }
    if (Object.hasOwn(original, 'flags')) {
      if (!original.flags || typeof original.flags !== 'object' || Array.isArray(original.flags)) {
        throw new TypeError('flags must be an object');
      }
      config.features = Object.keys(original.flags).filter(key => original.flags[key] === true).sort();
    }
    delete config.timeoutSeconds;
    delete config.flags;
    if (!Object.hasOwn(config, 'region')) config.region = 'us-east-1';
    if (!Object.hasOwn(config, 'retries')) config.retries = 3;
  }
  if (options.region !== undefined) config.region = options.region;

  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const destination = resolve(outputPath);
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, '.migrate-'));
  try {
    const staged = join(temporary, 'config.json');
    await writeFile(staged, serialized, { flag: 'wx' });
    try {
      await copyFile(destination, `${destination}.bak`, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
    }
    await rename(staged, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return config;
}
