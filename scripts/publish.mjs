#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { registeredWorkspaces } from './workspaces.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org/';
const usage = 'Usage: node scripts/publish.mjs <workspace> [--dry-run]';

// Injection keeps tests entirely offline: never run a real npm publish in tests.
export function publish(args, { cwd = root, run = spawnSync, log = console.log } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    log(usage);
    return;
  }
  const [shortName, ...options] = args;
  if (!/^pi-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shortName ?? '') ||
      options.length > 1 || options.some(option => option !== '--dry-run')) {
    throw new Error(usage);
  }
  const name = `@nothumanwork/${shortName}`;
  const entry = registeredWorkspaces(cwd).find(({ pkg }) => pkg.name === name);
  if (!entry) throw new Error(`Not a registered workspace: ${shortName}`);
  const { pkg } = entry;
  if (pkg.name !== name || pkg.private === true || pkg.publishConfig?.access !== 'public') {
    throw new Error(`${shortName} must be a public, publishable package named ${name}.`);
  }
  if (pkg.publishConfig?.registry && pkg.publishConfig.registry.replace(/\/$/, '') !== registry.replace(/\/$/, '')) {
    throw new Error(`${shortName} overrides the npm registry; refusing to publish.`);
  }
  const dryRun = options.includes('--dry-run');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (!dryRun) {
    const auth = run(npm, ['whoami', `--registry=${registry}`], { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    if (auth.error || auth.status !== 0) {
      throw new Error(`Cannot verify npm login. Run npm login --registry=${registry} and retry. If already logged in, check registry connectivity. Nothing was published.`);
    }
    log(`Publishing as ${auth.stdout.trim()}: ${name}@${pkg.version}`);
  } else {
    log(`Dry run: ${name}@${pkg.version} (no login check or upload; npm lifecycle scripts still run)`);
  }
  const result = run(npm, ['publish', `--workspace=${name}`, '--access=public', `--registry=${registry}`, ...(dryRun ? ['--dry-run'] : [])], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm publish failed${result.signal ? ` (${result.signal})` : ` (exit ${result.status})`}. See npm output above.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    publish(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
