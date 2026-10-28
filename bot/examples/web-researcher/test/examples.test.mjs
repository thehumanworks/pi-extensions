import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from '@nothumanwork/bot';

for (const name of ['sdk', 'pi-bot']) {
  test(`${name} inherits global defaults and adds a local research tool`, async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'researcher-config-'));
    try {
      const project = await loadProject(fileURLToPath(new URL(`../${name}`, import.meta.url)), { agentDir });
      assert.equal(project.definition.inherit, 'global');
      assert.equal(project.definition.tools, undefined);
      assert.equal(project.definition.builtinTools, undefined);
      assert.equal(project.native, true);
      assert.ok(project.tools.some(tool => tool.name === 'research_clock'));
      assert.ok(project.tools.some(tool => tool.name === 'bot_write'));
      assert.equal(project.tools.some(tool => tool.name === 'web_search_exa'), false,
        'Exa must come from MCP discovery, not a duplicated adapter');
      const value = project.tools.find(tool => tool.name === 'research_clock').execute({});
      assert.ok(Number.isFinite(Date.parse(value.utc)));
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });
}

test('the two sources keep identical additive tools', async () => {
  assert.equal(
    await readFile(new URL('../sdk/tools/research-clock.ts', import.meta.url), 'utf8'),
    await readFile(new URL('../pi-bot/tools/research-clock.ts', import.meta.url), 'utf8'),
  );
});
