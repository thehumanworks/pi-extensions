import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Explicit workspace paths only: never expand caller-controlled globs or traversal. */
export function registeredWorkspaces(cwd) {
  const manifest = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.workspaces)) throw new Error('Expected an explicit workspaces array.');
  const names = new Set();
  return manifest.workspaces.map(directory => {
    if (typeof directory !== 'string' || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(directory)) {
      throw new Error(`Invalid workspace directory: ${directory}`);
    }
    const pkg = JSON.parse(readFileSync(resolve(cwd, directory, 'package.json'), 'utf8'));
    if (typeof pkg.name !== 'string' || !/^@nothumanwork\/[a-z0-9-]+$/.test(pkg.name) || names.has(pkg.name)) {
      throw new Error(`Invalid or duplicate workspace name in ${directory}`);
    }
    names.add(pkg.name);
    return { directory, pkg };
  });
}

export function publicWorkspaces(cwd) {
  return registeredWorkspaces(cwd).filter(({ pkg }) => pkg.private !== true);
}
