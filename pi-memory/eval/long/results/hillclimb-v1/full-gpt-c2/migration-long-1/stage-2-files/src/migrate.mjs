import { readFile, writeFile, mkdir, rename, unlink, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
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
    };
    if (legacy !== undefined || Object.keys(unknown).length) {
      result.legacy = { ...legacy, ...unknown };
    }
  } else {
    throw new Error(`Unsupported config version: ${source.version}`);
  }
  if (options.region !== undefined) result.region = options.region;
  return result;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const directory = dirname(outputPath);
  const backupPath = join(directory, 'backups', 'source.json');
  let raw = await readFile(inputPath);
  let source;
  let recovered = false;
  try {
    source = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError) || !/unexpected end|unterminated/i.test(error.message)) throw error;
    // Validate the backup before moving the damaged source out of the way.
    const backup = await readFile(backupPath);
    source = JSON.parse(backup.toString('utf8'));
    migrate(source, options);
    const recoveryDirectory = join(directory, 'recovery');
    await mkdir(recoveryDirectory, { recursive: true });
    await copyFile(inputPath, join(recoveryDirectory, 'source.bad.json'), constants.COPYFILE_EXCL);
    await unlink(inputPath);
    raw = backup;
    recovered = true;
  }
  const result = migrate(source, options);
  await mkdir(join(directory, 'backups'), { recursive: true });
  if (!recovered) {
    try {
      await writeFile(backupPath, raw, { flag: 'wx' });
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
