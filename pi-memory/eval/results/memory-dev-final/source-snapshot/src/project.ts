import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function git(cwd: string, args: string[]): string | undefined {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim(); }
  catch { return undefined; }
}

/** Common git directory makes sibling worktrees agree even without a remote. */
export function resolveProjectKey(cwd: string): string {
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  let identity: string;
  if (remote) {
    try {
      const url = new URL(remote.replace(/^git@([^:]+):/, 'ssh://git@$1/'));
      identity = `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')}`;
    } catch { identity = resolve(cwd, remote); }
  } else {
    const common = git(cwd, ['rev-parse', '--git-common-dir']);
    const path = common ? resolve(cwd, common) : resolve(cwd);
    try { identity = realpathSync(path); } catch { identity = path; }
  }
  return createHash('sha256').update(identity).digest('hex').slice(0, 24);
}
