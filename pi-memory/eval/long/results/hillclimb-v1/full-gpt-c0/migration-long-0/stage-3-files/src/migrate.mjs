import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function convert(source, options) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Config must be a JSON object');
  }
  let result;
  if (source.version === 3) {
    result = { ...source };
  } else if (source.version === 1) {
    const { version, timeoutSeconds, flags, legacy, ...fields } = source;
    result = {
      version: 3,
      region: fields.region ?? 'eu-north-7',
      retry: { maxAttempts: 5, backoffMs: 125, ...fields.retry },
      features: Object.keys(flags ?? {}).filter(key => flags[key] === true).sort(),
    };
    if (Object.hasOwn(source, 'name')) result.name = source.name;
    if (timeoutSeconds !== undefined) result.timeoutMs = timeoutSeconds * 1000;
    const unknown = Object.fromEntries(
      Object.entries(fields).filter(([key]) => !['name', 'region', 'retry'].includes(key)),
    );
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
  let bytes = await readFile(inputPath);
  let source;
  let result;
  try {
    source = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Verify the recovery copy before moving the damaged input.
    const backup = await readFile(backupPath);
    source = JSON.parse(backup.toString('utf8'));
    // Validate migration before removing the only copy at the input path.
    result = convert(source, options);
    const recoveryDirectory = join(directory, 'recovery');
    await mkdir(recoveryDirectory, { recursive: true });
    // Exclusive creation protects any earlier recovery evidence.
    await writeFile(join(recoveryDirectory, 'source.bad.json'), bytes, { flag: 'wx' });
    await unlink(inputPath);
    bytes = backup;
  }
  result ??= convert(source, options);
  await mkdir(dirname(backupPath), { recursive: true });
  try {
    await writeFile(backupPath, bytes, { flag: 'wx' });
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
