import {readFile, writeFile, rename, mkdir, access} from 'node:fs/promises';
import {dirname, join} from 'node:path';

const DEFAULT_REGION = 'eu-north-7';
const DEFAULT_BACKOFF_MS = 125;
const MAX_ATTEMPTS = 5;
const V1_KNOWN_FIELDS = new Set(['version', 'name', 'timeoutSeconds', 'flags', 'region', 'retry']);

export async function migrateFile(inputPath, outputPath, options = {}) {
  const outDir = dirname(outputPath);
  const backupPath = join(outDir, 'backups', 'source.json');
  const raw = await readFile(inputPath, 'utf8');

  let source;
  try {
    source = JSON.parse(raw);
  } catch (cause) {
    source = await recoverSource(inputPath, outDir, backupPath, cause);
  }

  if (!(await exists(backupPath))) {
    await mkdir(dirname(backupPath), {recursive: true});
    await writeFile(backupPath, raw);
  }

  const result = migrate(source, options);
  await writeAtomic(outputPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

async function recoverSource(inputPath, outDir, backupPath, cause) {
  if (!(await exists(backupPath))) {
    throw new Error(`invalid JSON in ${inputPath} and no backup at ${backupPath}`, {cause});
  }
  const recovered = JSON.parse(await readFile(backupPath, 'utf8'));

  const recoveryPath = await freeRecoveryPath(join(outDir, 'recovery'));
  await mkdir(dirname(recoveryPath), {recursive: true});
  await rename(inputPath, recoveryPath);
  return recovered;
}

// Keeps earlier corrupt-source evidence: picks source.bad.json, then source.bad.1.json, ...
async function freeRecoveryPath(dir) {
  for (let n = 0; ; n++) {
    const candidate = join(dir, n === 0 ? 'source.bad.json' : `source.bad.${n}.json`);
    if (!(await exists(candidate))) return candidate;
  }
}

function migrate(source, options) {
  if (source.version === 3) {
    const result = {...source};
    if (options.region !== undefined) result.region = options.region;
    return result;
  }
  if (source.version !== 1) {
    throw new Error(`unsupported config version: ${source.version}`);
  }

  const {version, name, timeoutSeconds, flags = {}, region, retry = {}, ...rest} = source;
  const legacy = Object.fromEntries(Object.entries(rest).filter(([key]) => !V1_KNOWN_FIELDS.has(key)));

  const result = {
    version: 3,
    name,
    region: options.region ?? region ?? DEFAULT_REGION,
    retry: {
      ...retry,
      maxAttempts: MAX_ATTEMPTS,
      backoffMs: retry.backoffMs ?? DEFAULT_BACKOFF_MS,
    },
    features: Object.keys(flags).filter((key) => flags[key] === true).sort(),
  };
  if (timeoutSeconds !== undefined) result.timeoutMs = timeoutSeconds * 1000;
  if (Object.keys(legacy).length) result.legacy = legacy;
  return result;
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), {recursive: true});
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
