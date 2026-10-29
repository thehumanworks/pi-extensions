import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareLock } from './prepare-lock.mjs';

test('isolated staging preserves workspace layout and never changes source locks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'web-lock-test-'));
  try {
    const root = join(tmp, 'bot');
    const manifests = {
      'nix/web': { name: '@nothumanwork/bot-web-build', version: '0.1.0', private: true,
        workspaces: ['packages/ai-sdk', 'apps/web'] },
      'packages/ai-sdk': { name: '@nothumanwork/bot-ai-sdk', version: '0.1.0', peerDependencies: { ai: '^7.0.0' } },
      'apps/web': { name: '@nothumanwork/bot-ui', version: '0.1.0', dependencies: { '@nothumanwork/bot-ai-sdk': '0.1.0' } },
    };
    for (const [path, manifest] of Object.entries(manifests)) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, 'package.json'), JSON.stringify(manifest));
    }
    writeFileSync(join(root, 'package-lock.json'), 'parent sentinel');
    const stage = join(tmp, 'first');
    prepareLock(root, stage);
    const seed = JSON.parse(readFileSync(join(stage, 'package-lock.json'), 'utf8'));
    assert.deepEqual(seed.packages[''].workspaces, ['packages/ai-sdk', 'apps/web']);
    assert.deepEqual(seed.packages['node_modules/@nothumanwork/bot-ai-sdk'], {
      resolved: 'packages/ai-sdk', link: true,
    });
    assert.equal(seed.packages['packages/runtime'], undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(stage, 'apps/web/package.json'), 'utf8')), manifests['apps/web']);
    assert.throws(() => prepareLock(root, stage), /must not already exist/);
    // The old isolated seed must be copied byte for byte, not re-resolved.
    const oldLock = JSON.stringify({ ...seed, marker: 'old resolution' }) + '\n';
    writeFileSync(join(root, 'nix/web/package-lock.json'), oldLock);
    prepareLock(root, join(tmp, 'second'));
    assert.equal(readFileSync(join(tmp, 'second/package-lock.json'), 'utf8'), oldLock);
    assert.equal(readFileSync(join(root, 'nix/web/package-lock.json'), 'utf8'), oldLock);
    assert.equal(readFileSync(join(root, 'package-lock.json'), 'utf8'), 'parent sentinel');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
