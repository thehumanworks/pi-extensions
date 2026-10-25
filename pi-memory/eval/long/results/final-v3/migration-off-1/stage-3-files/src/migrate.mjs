import { readFile, mkdir, open, rename, copyFile, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';

export async function migrateFile(inputPath, outputPath, options = {}) {
  const destination = resolve(outputPath);
  const backup = join(dirname(destination), 'backups', 'source.json');
  let source = await readFile(inputPath, 'utf8');
  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Recover from the durable pre-migration backup, never from the output.
    // Leave the damaged input untouched as evidence.
    source = await readFile(backup, 'utf8');
    config = JSON.parse(source);
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
    result.version = 3;
    if (!Object.hasOwn(result, 'region')) result.region = 'us-east-1';
    if (!Object.hasOwn(result, 'retries')) result.retries = 3;
  }
  if (options.region !== undefined) result.region = options.region;

  await mkdir(dirname(destination), { recursive: true });
  await mkdir(dirname(backup), { recursive: true });
  try {
    await copyFile(inputPath, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}
