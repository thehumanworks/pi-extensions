import {readFile, writeFile, rename, copyFile, rm, access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const CURRENT_VERSION = 3;
const DEFAULT_REGION = 'default';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function migrateV1(input) {
  const {version, timeoutSeconds, flags, ...rest} = input;
  const out = {...rest, version: CURRENT_VERSION};
  if (timeoutSeconds !== undefined) out.timeoutMs = timeoutSeconds * 1000;
  out.features = Object.entries(flags ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name)
    .sort();
  return out;
}

export async function migrateFile(inputPath, outputPath, options = {}) {
  const input = JSON.parse(await readFile(inputPath, 'utf8'));

  let config;
  if (input.version === CURRENT_VERSION) {
    config = {...input};
  } else if (input.version === 1) {
    config = migrateV1(input);
  } else {
    throw new Error(`unsupported config version: ${input.version}`);
  }

  config.region = options.region ?? config.region ?? DEFAULT_REGION;

  // Backup policy: never silently overwrite an existing output file.
  if (await exists(outputPath)) {
    await copyFile(outputPath, `${outputPath}.bak`);
  }

  // Atomic write: stage in the same directory, then rename into place.
  const tmpPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    await rename(tmpPath, outputPath);
  } catch (err) {
    await rm(tmpPath, {force: true});
    throw err;
  }

  return config;
}
