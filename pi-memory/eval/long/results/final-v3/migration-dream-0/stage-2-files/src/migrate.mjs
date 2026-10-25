import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function migrate(source, options) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Config must be a JSON object');
  }
  let result;
  if (source.version === 3) {
    result = { ...source };
  } else if (source.version === 1) {
    const { version, name, timeoutSeconds, flags, region, retry, legacy, ...unknown } = source;
    result = {
      version: 3,
      ...(name !== undefined ? { name } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutMs: timeoutSeconds * 1000 } : {}),
      features: Object.keys(flags ?? {}).filter(key => flags[key] === true).sort(),
      region: region ?? 'eu-north-7',
      retry: { maxAttempts: 5, backoffMs: 125, ...retry },
      legacy: { ...legacy, ...unknown },
    };
  } else {
    throw new Error(`Unsupported config version: ${source.version}`);
  }
  if (options.region !== undefined) result.region = options.region;
  return result;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const directory = dirname(resolve(outputPath));
  const backupPath = join(directory, 'backups', 'source.json');
  const original = await readFile(inputPath);
  let source;
  let recovering = false;
  try {
    source = JSON.parse(original.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Validate the backup before moving the damaged source.
    source = JSON.parse(await readFile(backupPath, 'utf8'));
    recovering = true;
  }
  const result = migrate(source, options);
  await mkdir(directory, { recursive: true });
  if (recovering) {
    const recoveryPath = join(directory, 'recovery', 'source.bad.json');
    await mkdir(dirname(recoveryPath), { recursive: true });
    // Exclusive creation keeps earlier recovery evidence intact.
    await writeFile(recoveryPath, original, { flag: 'wx' });
    await unlink(inputPath);
  } else {
    await mkdir(dirname(backupPath), { recursive: true });
    try {
      await writeFile(backupPath, original, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
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
