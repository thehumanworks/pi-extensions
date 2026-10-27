#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { publish } from './publish.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org/';
const usage = 'Usage: node scripts/publish-updated.mjs [--dry-run]';

function isNotFound(result) {
  for (const output of [result.stdout, result.stderr]) {
    try {
      if (JSON.parse(output).error?.code === 'E404') return true;
    } catch { /* Not a structured npm error. */ }
  }
  return false;
}

export function publishUpdated(args, { cwd = root, run = spawnSync, log = console.log, publishPackage = publish } = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    log(usage);
    return [];
  }
  if (args.length > 1 || args.some(arg => arg !== '--dry-run')) throw new Error(usage);
  const dryRun = args.includes('--dry-run');
  const manifest = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.workspaces)) throw new Error('Expected an explicit workspaces array.');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const candidates = [];

  // Finish all lookups before publishing, so a lookup error cannot cause a partial release.
  for (const dir of manifest.workspaces) {
    if (typeof dir !== 'string' || !/^(?:bot|pi-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(dir)) {
      throw new Error(`Invalid workspace directory: ${dir}`);
    }
    const pkg = JSON.parse(readFileSync(resolve(cwd, dir, 'package.json'), 'utf8'));
    if (pkg.name !== `@nothumanwork/${dir}` || pkg.private === true || pkg.publishConfig?.access !== 'public') {
      throw new Error(`Invalid publishable workspace manifest: ${dir}`);
    }
    if (pkg.publishConfig?.registry && pkg.publishConfig.registry.replace(/\/$/, '') !== registry.replace(/\/$/, '')) {
      throw new Error(`Registry override in ${dir}; refusing to publish.`);
    }
    if (!semver.valid(pkg.version)) throw new Error(`Invalid version in ${dir}: ${pkg.version}`);
    const result = run(npm, ['view', pkg.name, 'versions', '--json', `--registry=${registry}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    let versions;
    if (result.status !== 0) {
      if (!isNotFound(result)) throw new Error(`Cannot query npm versions for ${pkg.name}; no packages were published. Check npm authentication and registry connectivity.`);
      versions = [];
    } else {
      try {
        const data = JSON.parse(result.stdout);
        versions = typeof data === 'string' ? [data] : data;
        if (!Array.isArray(versions) || versions.length === 0 || versions.some(v => typeof v !== 'string' || !semver.valid(v))) throw new Error();
      } catch {
        throw new Error(`Invalid npm version response for ${pkg.name}; no packages were published.`);
      }
    }
    const highest = versions.length ? semver.rsort([...versions])[0] : null;
    if (highest === null || semver.gt(pkg.version, highest)) {
      candidates.push({ directory: dir, name: pkg.name, version: pkg.version, previous: highest });
      log(`${dryRun ? 'Would publish' : 'Selected'} ${pkg.name}: ${highest ?? 'unpublished'} -> ${pkg.version}`);
    } else {
      log(`Skip ${pkg.name}: local ${pkg.version}, npm highest ${highest}`);
    }
  }
  if (!candidates.length) log('No newer or unpublished packages to publish.');
  if (dryRun) {
    log(`Dry run: ${candidates.length} package(s) selected; no builds, login checks, or uploads.`);
    return candidates;
  }
  // Reuse the single-package helper for auth, manifest validation, and lifecycle scripts.
  // Stop at the first failure; previous uploads cannot be rolled back.
  for (const candidate of candidates) {
    publishPackage([candidate.directory], { cwd, run, log });
  }
  if (candidates.length) log(`Published ${candidates.length} package(s).`);
  return candidates;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    publishUpdated(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
