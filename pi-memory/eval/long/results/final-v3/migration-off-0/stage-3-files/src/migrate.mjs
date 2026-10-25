import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Migrate a JSON configuration, preserving customer-owned fields. */
export async function migrateFile(inputPath, outputPath, options = {}) {
  const sourceText = await readFile(inputPath, 'utf8');
  let source;
  try {
    source = JSON.parse(sourceText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Recover only malformed JSON from the agreed pre-migration backup.
    // Neither the corrupt input nor this backup is modified.
    const backupPath = resolve(dirname(resolve(outputPath)), 'backups/source.json');
    source = JSON.parse(await readFile(backupPath, 'utf8'));
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Configuration must be a JSON object');
  }
  if (![1, 2, 3].includes(source.version)) {
    throw new Error(`Unsupported configuration version: ${source.version}`);
  }

  const result = { ...source };
  if (source.version !== 3) {
    if (Object.hasOwn(source, 'timeoutSeconds')) {
      if (typeof source.timeoutSeconds !== 'number' || !Number.isFinite(source.timeoutSeconds * 1000)) {
        throw new TypeError('timeoutSeconds must be a finite number');
      }
      result.timeoutMs = source.timeoutSeconds * 1000;
      delete result.timeoutSeconds;
    }
    if (Object.hasOwn(source, 'flags')) {
      if (source.flags === null || typeof source.flags !== 'object' || Array.isArray(source.flags)) {
        throw new TypeError('flags must be an object');
      }
      result.features = Object.keys(source.flags).filter(key => source.flags[key] === true).sort();
      delete result.flags;
    }
    result.version = 3;
  }
  if (options.region !== undefined) result.region = options.region;

  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await handle.close();
    handle = undefined;
    // Never replace an earlier backup. Failure to preserve existing data aborts.
    try {
      await copyFile(destination, `${destination}.bak`, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
    }
    await rename(temporary, destination);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return result;
}
