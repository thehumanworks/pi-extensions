import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

async function preserve(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

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
  const backupPath = join(dirname(outputPath), 'backups', 'source.json');
  if (resolve(outputPath) === resolve(backupPath)) {
    throw new Error('Output must not overwrite the source backup');
  }
  let bytes = await readFile(inputPath);
  let source;
  try {
    source = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Validate the recovery copy before moving the corrupt source.
    const recovered = await readFile(backupPath);
    source = JSON.parse(recovered.toString('utf8'));
    const badPath = join(dirname(outputPath), 'recovery', 'source.bad.json');
    if (resolve(inputPath) === resolve(backupPath)) throw error;
    await mkdir(dirname(badPath), { recursive: true });
    await writeFile(badPath, bytes, { flag: 'wx' });
    await unlink(inputPath);
    bytes = recovered;
  }
  const result = migrate(source, options);
  await preserve(backupPath, bytes);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = join(dirname(outputPath), `.migration-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, outputPath);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}
