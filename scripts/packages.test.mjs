import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { publicWorkspaces } from './workspaces.mjs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root)));
const workspaces = publicWorkspaces(fileURLToPath(root));
const packs = JSON.parse(execFileSync('npm', ['pack', ...workspaces.map(({ pkg }) => `--workspace=${pkg.name}`), '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

test('root is a private workspace, with no Git submodules', () => {
  assert.equal(manifest.private, true);
  assert.equal(packs.length, workspaces.length);
  const index = execFileSync('git', ['ls-files', '--stage'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.doesNotMatch(index, /^160000 /m);
});

for (const { directory: dir } of workspaces) {
  test(`${dir} is independently publishable with its runtime files`, () => {
    const pkg = JSON.parse(readFileSync(new URL(`${dir}/package.json`, root)));
    const pack = packs.find(p => p.name === pkg.name);
    assert.ok(pack);
    assert.equal(pkg.name, `@nothumanwork/${dir}`);
    assert.notEqual(pkg.private, true);
    assert.equal(pkg.publishConfig.access, 'public');
    assert.ok(pkg.keywords.includes('pi-package'));
    assert.equal(pkg.repository.directory, dir);
    assert.ok(!existsSync(new URL(`${dir}/.git`, root)));
    const files = new Set(pack.files.map(f => f.path));
    const targets = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
    for (const entry of [...(pkg.pi?.extensions ?? []), ...Object.values(pkg.bin ?? {}), ...targets(pkg.exports ?? {})]) {
      assert.ok(files.has(entry.replace(/^\.\//, '')), `missing entry: ${entry}`);
    }
    for (const path of files) {
      assert.doesNotMatch(path, /(^|\/)(node_modules|tests?|\.git|\.env[^/]*|mise\.local\.toml|fnox\.toml)(\/|$)/);
      assert.doesNotMatch(path, /\.(test|spec)\.[cm]?[jt]s$/);
    }
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (pkg.pi) assert.ok(!['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'].includes(name), `host dependency bundled: ${name}`);
    }
    if (dir === 'pi-agent') {
      for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox']) {
        assert.equal(pkg.peerDependencies?.[name], '*', `host dependency must be a wildcard peer: ${name}`);
        assert.ok(pkg.devDependencies?.[name], `missing host dependency for development: ${name}`);
      }
      for (const file of ['src/agent.ts', 'src/discovery.ts', 'src/extension.ts', 'src/homes.ts', 'src/model.ts', 'src/session.ts', 'src/tools.ts', 'src/trust.ts']) assert.ok(files.has(file), `missing ${file}`);
      assert.ok(!files.has('PLAN.md'));
    }
    if (dir === 'pi-atlassian') {
      assert.ok(files.has('docs/catalog/index.json'));
      assert.ok([...files].some(f => f.startsWith('docs/catalog/jira/operations/')));
      assert.ok([...files].some(f => f.startsWith('docs/catalog/confluence/operations/')));
    }
    if (dir === 'pi-bot') {
      assert.equal(pkg.bin, undefined);
      assert.equal(pkg.dependencies, undefined, 'bots run on the host Pi alone');
      assert.ok(files.has('index.ts'));
      assert.ok(![...files].some(f => f.startsWith('src/')), 'the HTTP server is not part of the extension package');
      assert.ok(![...files].some(f => f.includes('fixtures')));
    }
    if (dir === 'pi-loop') assert.ok(files.has('dist/worker.js'));
    if (dir === 'pi-orchestration') {
      for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/recipes.js', 'dist/recipes.d.ts', 'dist/cli.js', 'dist/worker.js', 'dist/engine/index.js']) assert.ok(files.has(file), `missing ${file}`);
      assert.ok(files.has(pkg.types.replace(/^\.\//, '')));
      assert.equal([...files].filter(f => f.startsWith('examples/workflows/')).length, 9);
      assert.ok(![...files].some(f => f.startsWith('eval/')));
      assert.ok(files.has('LICENSE'));
    }
    if (dir === 'pi-xai') assert.ok(files.has('dist/src/index.js'));
    if (dir === 'pi-remote') {
      for (const file of ['hosts.ts', 'operations.ts', 'session.ts', 'README.md']) assert.ok(files.has(file), `missing ${file}`);
    }
    if (dir === 'pi-background-compaction') {
      for (const file of ['src/config.ts', 'src/controller.ts', 'src/plan.ts', 'src/prompts.ts', 'src/summarize.ts']) assert.ok(files.has(file), `missing ${file}`);
      assert.ok(![...files].some(f => f.startsWith('eval/')));
    }
    if (dir === 'pi-memory') {
      assert.ok(files.has('prompts/memory-agent.preset.md'));
      assert.ok(files.has('src/capture.ts'));
      assert.ok(files.has('src/store.ts'));
      assert.ok(![...files].some(f => f.startsWith('eval/')));
    }
  });
}

test('the vendored pi-durable job queue is identical in every package', () => {
  const [compaction, memory] = ['pi-background-compaction', 'pi-memory'].map(dir => readFileSync(new URL(`${dir}/src/jobs.ts`, root), 'utf8'));
  assert.equal(memory, compaction, 'copy pi-background-compaction/src/jobs.ts to pi-memory/src/jobs.ts');
});
