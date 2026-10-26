import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function migrate(source, options) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Config must be a JSON object');
  }
  if (source.version === 3) {
    return options.region === undefined ? source : { ...source, region: options.region };
  }
  if (source.version !== 1) throw new Error(`Unsupported config version: ${source.version}`);

  const { version, timeoutSeconds, flags, legacy, ...fields } = source;
  const known = new Set(['name', 'region', 'retry', 'timeoutMs', 'features']);
  const customerFields = Object.fromEntries(Object.entries(fields).filter(([key]) => !known.has(key)));
  const result = {
    version: 3,
    ...(Object.hasOwn(source, 'name') ? { name: source.name } : {}),
    timeoutMs: timeoutSeconds === undefined ? (source.timeoutMs ?? 0) : timeoutSeconds * 1000,
    features: flags === undefined
      ? [...(source.features ?? [])].sort()
      : Object.keys(flags).filter(key => flags[key] === true).sort(),
    region: options.region ?? source.region ?? 'eu-north-7',
    retry: { maxAttempts: 5, backoffMs: 125, ...source.retry },
  };
  if (legacy !== undefined || Object.keys(customerFields).length) {
    result.legacy = { ...legacy, ...customerFields };
  }
  return result;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const directory = dirname(resolve(outputPath));
  const backupPath = join(directory, 'backups', 'source.json');
  const originalBytes = await readFile(inputPath);
  let bytes = originalBytes;
  let source;
  let recovering = false;
  try {
    source = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError) || !/unexpected end|unterminated/i.test(error.message)) throw error;
    bytes = await readFile(backupPath);
    source = JSON.parse(bytes.toString('utf8'));
    recovering = true;
  }
  const result = migrate(source, options);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  await mkdir(directory, { recursive: true });
  if (recovering) {
    const recoveryDirectory = join(directory, 'recovery');
    await mkdir(recoveryDirectory, { recursive: true });
    const recoveryPath = join(recoveryDirectory, 'source.bad.json');
    // Never replace an earlier recovered source.
    await writeFile(recoveryPath, originalBytes, { flag: 'wx' });
    await rm(inputPath);
  } else {
    await mkdir(dirname(backupPath), { recursive: true });
    try {
      await writeFile(backupPath, bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const temporaryPath = join(directory, `.migration-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, serialized, { flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return result;
}
