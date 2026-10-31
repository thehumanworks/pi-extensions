import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishUpdated } from './publish-updated.mjs';

function fixture(t, packages) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-publish-updated-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const workspaces = packages.map((_, i) => `pi-test-${i}`);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ workspaces }));
  packages.forEach((p, i) => {
    mkdirSync(join(cwd, workspaces[i]));
    writeFileSync(join(cwd, workspaces[i], 'package.json'), JSON.stringify({ name: `@nothumanwork/${workspaces[i]}`, version: p.local, publishConfig: { access: 'public' } }));
  });
  const queries = [], published = [];
  return {
    cwd, log() {}, queries, published,
    run(command, args) {
      assert.match(command, /^npm(?:\.cmd)?$/);
      assert.deepEqual([args[0], ...args.slice(2)], ['view', 'versions', '--json', '--registry=https://registry.npmjs.org/']);
      queries.push(args[1]);
      const p = packages[Number(args[1].split('-').at(-1))];
      return p.result ?? { status: 0, stdout: JSON.stringify(p.remote) };
    },
    publishPackage(args) {
      assert.equal(queries.length, packages.length, 'all lookups must finish before publishing');
      published.push(args[0]);
    },
  };
}

test('publishes only higher versions using numeric semver, not lexical ordering', t => {
  const f = fixture(t, [
    { local: '1.10.0', remote: ['1.9.0', '1.8.0'] },
    { local: '1.0.0', remote: '1.0.0' },
    { local: '1.9.0', remote: ['1.10.0'] },
  ]);
  const selected = publishUpdated([], f);
  assert.deepEqual(f.published, ['pi-test-0']);
  assert.equal(selected[0].previous, '1.9.0');
});
test('E404 means unpublished, including structured errors on stderr', t => {
  const f = fixture(t, [{ local: '0.1.0', result: { status: 1, stderr: JSON.stringify({ error: { code: 'E404' } }) } }]);
  assert.equal(publishUpdated([], f)[0].previous, null);
  assert.deepEqual(f.published, ['pi-test-0']);
});
test('compares highest version including prereleases; build metadata is not a bump', t => {
  const f = fixture(t, [
    { local: '2.0.0', remote: ['1.9.0', '2.0.0-rc.1'] },
    { local: '1.10.0', remote: ['1.9.0', '2.0.0-rc.1'] },
    { local: '1.0.0+new', remote: ['1.0.0+old'] },
    { local: '2.0.0-beta.10', remote: ['2.0.0-beta.9'] },
  ]);
  publishUpdated([], f);
  assert.deepEqual(f.published, ['pi-test-0', 'pi-test-3']);
});
test('dry run queries but never invokes publisher', t => {
  const f = fixture(t, [{ local: '2.0.0', remote: ['1.0.0'] }]);
  assert.equal(publishUpdated(['--dry-run'], f).length, 1);
  assert.equal(f.published.length, 0);
});
test('network, auth, and malformed responses abort before any upload', t => {
  for (const result of [
    { status: 1, stdout: JSON.stringify({ error: { code: 'E401' } }) },
    { status: 1, stderr: 'network unavailable' },
    { error: new Error('npm not found') },
    { status: 0, stdout: 'not json' },
    { status: 0, stdout: '[]' },
    { status: 0, stdout: '["invalid"]' },
  ]) {
    const f = fixture(t, [{ local: '2.0.0', remote: ['1.0.0'] }, { local: '2.0.0', result }]);
    assert.throws(() => publishUpdated([], f));
    assert.equal(f.published.length, 0);
  }
});
test('invalid local versions and arguments are rejected', t => {
  const f = fixture(t, [{ local: 'bad-version', remote: ['1.0.0'] }]);
  assert.throws(() => publishUpdated([], f), /Invalid version/);
  assert.throws(() => publishUpdated(['--all'], f), /Usage/);
  assert.equal(f.queries.length, 0);
});
test('stops on first publish failure', t => {
  const f = fixture(t, [{ local: '2.0.0', remote: ['1.0.0'] }, { local: '2.0.0', remote: ['1.0.0'] }]);
  f.publishPackage = args => { f.published.push(args[0]); throw new Error('publish failed'); };
  assert.throws(() => publishUpdated([], f), /publish failed/);
  assert.deepEqual(f.published, ['pi-test-0']);
});
test('rejects public packages outside the pi-* roster', t => {
  const f = fixture(t, []);
  mkdirSync(join(f.cwd, 'bot'));
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ workspaces: ['bot'] }));
  writeFileSync(join(f.cwd, 'bot/package.json'), JSON.stringify({ name: '@nothumanwork/bot', version: '0.1.0', publishConfig: { access: 'public' } }));
  assert.throws(() => publishUpdated(['--dry-run'], f), /Invalid publishable workspace manifest: bot/);
});
test('nested packages are selected while private roots and applications are never queried', t => {
  const f = fixture(t, []);
  const paths = ['group', 'group/packages/pi-one', 'group/packages/pi-two', 'group/apps/web'];
  const packages = [
    { name: '@nothumanwork/group', private: true },
    { name: '@nothumanwork/pi-one', version: '0.1.0', publishConfig: { access: 'public' } },
    { name: '@nothumanwork/pi-two', version: '0.1.0', publishConfig: { access: 'public' } },
    { name: '@nothumanwork/pi-web', private: true },
  ];
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ workspaces: paths }));
  paths.forEach((path, index) => {
    mkdirSync(join(f.cwd, path), { recursive: true });
    writeFileSync(join(f.cwd, path, 'package.json'), JSON.stringify(packages[index]));
  });
  const queried = [], published = [];
  f.run = (_command, args) => { queried.push(args[1]); return { status: 1, stderr: JSON.stringify({ error: { code: 'E404' } }) }; };
  f.publishPackage = args => published.push(args[0]);
  publishUpdated([], f);
  assert.deepEqual(queried, ['@nothumanwork/pi-one', '@nothumanwork/pi-two']);
  assert.deepEqual(published, ['pi-one', 'pi-two']);
});

test('no updates means no publisher or login check', t => {
  const f = fixture(t, [{ local: '1.0.0', remote: ['1.0.0'] }]);
  assert.deepEqual(publishUpdated([], f), []);
  assert.equal(f.published.length, 0);
});
