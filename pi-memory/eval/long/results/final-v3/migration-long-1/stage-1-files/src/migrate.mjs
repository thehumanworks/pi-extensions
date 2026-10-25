import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_REGION = 'eu-north-7';
const DEFAULT_RETRY = { maxAttempts: 5, backoffMs: 125 };

function parseConfig(text) {
  const config = JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Config must be a JSON object');
  }
  if (config.version !== 1 && config.version !== 3) {
    throw new Error(`Unsupported config version: ${config.version}`);
  }
  return config;
}

function migrate(config, options) {
  let result;
  if (config.version === 3) {
    result = { ...config };
  } else {
    const known = new Set(['version', 'name', 'timeoutSeconds', 'flags', 'region', 'retry', 'legacy']);
    const legacy = { ...config.legacy };
    for (const [key, value] of Object.entries(config)) {
      if (!known.has(key)) {
        Object.defineProperty(legacy, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    result = {
      version: 3,
      ...(Object.hasOwn(config, 'name') ? { name: config.name } : {}),
      ...(Object.hasOwn(config, 'timeoutSeconds') ? { timeoutMs: config.timeoutSeconds * 1000 } : {}),
      features: Object.keys(config.flags ?? {}).filter(key => config.flags[key] === true).sort(),
      region: config.region ?? DEFAULT_REGION,
      retry: { ...DEFAULT_RETRY, ...config.retry },
      ...(Object.keys(legacy).length || Object.hasOwn(config, 'legacy') ? { legacy } : {}),
    };
  }
  if (options.region !== undefined) result.region = options.region;
  return result;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const directory = dirname(resolve(outputPath));
  const backupPath = join(directory, 'backups', 'source.json');
  const source = await readFile(inputPath);
  let config;
  try {
    config = parseConfig(source.toString('utf8'));
  } catch (error) {
    // Only truncated JSON qualifies for the approved recovery procedure.
    if (!(error instanceof SyntaxError) || !/unexpected end|unterminated/i.test(error.message)) throw error;
    config = parseConfig(await readFile(backupPath, 'utf8'));
    const recoveryPath = join(directory, 'recovery', 'source.bad.json');
    if (resolve(inputPath) === backupPath) throw new Error('Cannot recover a corrupt backup from itself');
    await mkdir(dirname(recoveryPath), { recursive: true });
    // Exclusive creation avoids replacing evidence from an earlier recovery.
    await writeFile(recoveryPath, source, { flag: 'wx' });
    await rm(inputPath);
  }
  const result = migrate(config, options);
  await mkdir(dirname(backupPath), { recursive: true });
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
    await rm(temporaryPath, { force: true });
  }
  return result;
}
