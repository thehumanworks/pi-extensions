import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publish } from './publish.mjs';

function fixture(t, overrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-publish-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'pi-example'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ workspaces: ['pi-example'] }));
  writeFileSync(join(cwd, 'pi-example/package.json'), JSON.stringify({ name: '@nothumanwork/pi-example', version: '0.1.0', publishConfig: { access: 'public' }, ...overrides }));
  const calls = [];
  return { cwd, calls, log() {}, run(...args) { calls.push(args); return { status: 0, stdout: 'publisher\n' }; } };
}

test('checks login then publishes only the selected scoped workspace', t => {
  const f = fixture(t);
  publish(['pi-example'], f);
  assert.deepEqual(f.calls.map(c => c[1]), [
    ['whoami', '--registry=https://registry.npmjs.org/'],
    ['publish', '--workspace=@nothumanwork/pi-example', '--access=public', '--registry=https://registry.npmjs.org/'],
  ]);
  assert.equal(f.calls[1][2].cwd, f.cwd);
  assert.equal(f.calls[1][2].stdio, 'inherit');
});
test('dry run skips auth and forwards --dry-run', t => {
  const f = fixture(t);
  publish(['pi-example', '--dry-run'], f);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0][1].includes('--dry-run'));
});
test('failed login check never publishes', t => {
  const f = fixture(t);
  f.run = (...args) => { f.calls.push(args); return { status: 1 }; };
  assert.throws(() => publish(['pi-example'], f), /npm login/);
  assert.equal(f.calls.length, 1);
});
test('rejects paths, scopes, unknown workspaces, and arbitrary flags before running npm', t => {
  const f = fixture(t);
  for (const args of [[], ['../pi-example'], ['@other/pi-example'], ['pi-missing'], ['pi-example', '--workspaces'], ['pi-example', '--dry-run', '--dry-run']]) {
    assert.throws(() => publish(args, f));
  }
  assert.equal(f.calls.length, 0);
});
test('rejects unsafe manifests before running npm', t => {
  for (const overrides of [{ name: '@other/pi-example' }, { private: true }, { publishConfig: { access: 'restricted' } }, { publishConfig: { access: 'public', registry: 'https://example.com' } }]) {
    const f = fixture(t, overrides);
    assert.throws(() => publish(['pi-example'], f));
    assert.equal(f.calls.length, 0);
  }
});
test('propagates publish errors', t => {
  const f = fixture(t);
  f.run = () => ({ status: 1 });
  assert.throws(() => publish(['pi-example', '--dry-run'], f), /npm publish failed/);
  f.run = () => ({ error: new Error('npm unavailable') });
  assert.throws(() => publish(['pi-example', '--dry-run'], f), /npm unavailable/);
});
test('publishes the standalone SDK only when explicitly registered and scoped', t => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, 'bot'));
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ workspaces: ['bot', 'pi-example'] }));
  writeFileSync(join(f.cwd, 'bot/package.json'), JSON.stringify({ name: '@nothumanwork/bot', version: '0.1.0', publishConfig: { access: 'public' } }));
  publish(['bot', '--dry-run'], f);
  assert.ok(f.calls[0][1].includes('--workspace=@nothumanwork/bot'));
  assert.throws(() => publish(['bot-missing'], f));
});
test('resolves nested bot packages by public name without publishing private applications', t => {
  const f = fixture(t);
  const paths = ['bot', 'bot/packages/runtime', 'bot/packages/ai-sdk', 'bot/apps/web'];
  const packages = [
    { name: '@nothumanwork/bot-workspace', private: true },
    { name: '@nothumanwork/bot', version: '0.1.0', publishConfig: { access: 'public' } },
    { name: '@nothumanwork/bot-ai-sdk', version: '0.1.0', publishConfig: { access: 'public' } },
    { name: '@nothumanwork/bot-ui', private: true },
  ];
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ workspaces: paths }));
  paths.forEach((path, index) => {
    mkdirSync(join(f.cwd, path), { recursive: true });
    writeFileSync(join(f.cwd, path, 'package.json'), JSON.stringify(packages[index]));
  });
  publish(['bot', '--dry-run'], f);
  publish(['bot-ai-sdk', '--dry-run'], f);
  assert.deepEqual(f.calls.map(call => call[1].find(arg => arg.startsWith('--workspace='))), ['--workspace=@nothumanwork/bot', '--workspace=@nothumanwork/bot-ai-sdk']);
  assert.throws(() => publish(['bot-ui', '--dry-run'], f));
  assert.throws(() => publish(['bot/packages/runtime'], f));
});

test('help does not call npm', t => {
  const f = fixture(t);
  publish(['--help'], f);
  assert.equal(f.calls.length, 0);
});
