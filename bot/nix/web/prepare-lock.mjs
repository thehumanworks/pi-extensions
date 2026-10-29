#!/usr/bin/env node
// Pure staging helper: no npm invocation, network, dependency install or writes
// to the checkout. Keeping workspace paths is essential for npm's local links.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareLock(root, destination) {
  root = resolve(root);
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error('Staging destination must not already exist');
  const isolatedRoot = join(root, 'nix/web');
  const manifest = JSON.parse(readFileSync(join(isolatedRoot, 'package.json'), 'utf8'));
  const workspaces = ['packages/ai-sdk', 'apps/web'];
  if (!manifest.private || manifest.name !== '@nothumanwork/bot-web-build'
      || JSON.stringify(manifest.workspaces) !== JSON.stringify(workspaces)) {
    throw new Error('Unexpected isolated workspace manifest');
  }
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(isolatedRoot, 'package.json'), join(destination, 'package.json'));
  const packages = { '': { name: manifest.name, version: manifest.version, workspaces } };
  for (const workspace of workspaces) {
    const target = join(destination, workspace, 'package.json');
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, workspace, 'package.json'), target);
    const pkg = JSON.parse(readFileSync(target, 'utf8'));
    packages[workspace] = Object.fromEntries(
      ['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies',
        'peerDependencies', 'peerDependenciesMeta', 'engines'].filter(key => key in pkg)
        .map(key => [key, pkg[key]]),
    );
    packages[`node_modules/${pkg.name}`] = { resolved: workspace, link: true };
  }
  const lock = join(isolatedRoot, 'package-lock.json');
  if (existsSync(lock)) {
    copyFileSync(lock, join(destination, 'package-lock.json'));
  } else {
    // A local-layout seed only, NOT a resolved installable dependency lock.
    writeFileSync(join(destination, 'package-lock.json'), JSON.stringify({
      name: manifest.name, version: manifest.version, lockfileVersion: 3,
      requires: true, packages,
    }, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: prepare-lock.mjs BOT_ROOT NEW_STAGING_DIRECTORY');
  prepareLock(process.argv[2], process.argv[3]);
}
