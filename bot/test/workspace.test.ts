import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const manifest = async (path: string) => JSON.parse(await readFile(new URL(`${path}/package.json`, root), 'utf8'));
const dependencies = (pkg: Record<string, any>) => Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });

test('workspace packages have independent public boundaries and retain the runtime consumer contract', async () => {
  const coordinator = await manifest('.');
  assert.equal(coordinator.private, true);
  assert.deepEqual(coordinator.workspaces, ['packages/runtime', 'packages/ai-sdk', 'apps/web']);
  const runtime = await manifest('packages/runtime');
  const adapter = await manifest('packages/ai-sdk');
  const ui = await manifest('apps/web');
  assert.equal(runtime.name, '@nothumanwork/bot');
  assert.equal(runtime.bin.bot, 'bin/bot.mjs');
  assert.ok(runtime.exports['.']);
  assert.equal(runtime.repository.directory, 'bot/packages/runtime');
  assert.ok(!dependencies(runtime).some(name => /^(?:ai|@ai-sdk\/|next$|react(?:-dom)?$)/.test(name)));
  assert.equal(adapter.name, '@nothumanwork/bot-ai-sdk');
  assert.equal(adapter.private, undefined);
  assert.equal(adapter.publishConfig.access, 'public');
  assert.ok(!dependencies(adapter).some(name => /^(?:@nothumanwork\/bot$|@earendil-works\/pi-|next$|react(?:-dom)?$)/.test(name)));
  assert.equal(ui.name, '@nothumanwork/bot-ui');
  assert.equal(ui.private, true);
  assert.ok(dependencies(ui).includes('@nothumanwork/bot-ai-sdk'));
  assert.ok(dependencies(ui).includes('@ai-sdk/react'));
  assert.ok(!dependencies(ui).some(name => name === '@nothumanwork/bot' || name.startsWith('@earendil-works/pi-')));
  for (const pkg of [runtime, adapter, ui]) {
    for (const script of ['build', 'check', 'test']) assert.equal(typeof pkg.scripts[script], 'string');
  }
  for (const file of await readdir(new URL('packages/ai-sdk/src/', root))) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(new URL(`packages/ai-sdk/src/${file}`, root), 'utf8');
    assert.ok(!/(?:from|import\s*\()\s*['"](?:@nothumanwork\/bot(?:['"/])|@earendil-works\/pi-|\.{2}\/.*runtime)/.test(source), `Adapter imports runtime internals: ${file}`);
  }
});
