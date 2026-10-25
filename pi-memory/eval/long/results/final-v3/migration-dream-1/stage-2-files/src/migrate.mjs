import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function migrate(config, options) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Config must be a JSON object');
  }
  if (config.version === 3) {
    return options.region === undefined ? config : { ...config, region: options.region };
  }
  if (config.version !== 1) throw new Error(`Unsupported config version: ${config.version}`);

  const known = new Set(['version', 'name', 'timeoutSeconds', 'flags', 'region', 'retry', 'legacy', 'timeoutMs', 'features']);
  const legacy = { ...config.legacy };
  for (const [key, value] of Object.entries(config)) {
    if (!known.has(key)) {
      Object.defineProperty(legacy, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  const result = {
    version: 3,
    ...(Object.hasOwn(config, 'name') ? { name: config.name } : {}),
    region: options.region ?? config.region ?? 'eu-north-7',
    retry: { maxAttempts: 5, backoffMs: 125, ...config.retry },
    features: Object.entries(config.flags ?? {}).filter(([, enabled]) => enabled === true).map(([name]) => name).sort(),
  };
  if (Object.hasOwn(config, 'timeoutSeconds')) result.timeoutMs = config.timeoutSeconds * 1000;
  else if (Object.hasOwn(config, 'timeoutMs')) result.timeoutMs = config.timeoutMs;
  if (Object.keys(legacy).length) result.legacy = legacy;
  return result;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const directory = dirname(resolve(outputPath));
  const backupPath = join(directory, 'backups', 'source.json');
  const source = await readFile(inputPath);
  let config;
  try {
    config = JSON.parse(source.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Verify the recovery copy before moving any customer data.
    config = JSON.parse(await readFile(backupPath, 'utf8'));
    const recoveryDirectory = join(directory, 'recovery');
    await mkdir(recoveryDirectory, { recursive: true });
    const recoveryPath = join(recoveryDirectory, 'source.bad.json');
    // Exclusive creation ensures a previous recovery is never overwritten.
    await writeFile(recoveryPath, source, { flag: 'wx' });
    await unlink(inputPath);
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
    await unlink(temporaryPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}
