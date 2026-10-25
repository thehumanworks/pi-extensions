import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProposalManager, consolidate, type ProposalKind } from '../src/maintenance.ts';
import { MemoryStore, serializeMemory } from '../src/store.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-proposals-'));
  const cwd = join(root, 'repo'); await mkdir(cwd);
  const store = new MemoryStore(join(root, 'memory'), 'project'); await store.initialize();
  const manager = new ProposalManager(store, { root: store.rootDir, cwd, projectKey: 'project', agentDir: join(root, 'agent') });
  const memory = await store.save({ title: 'Test before committing', body: 'Run focused tests before committing changes. Investigate failures before continuing.', type: 'procedure', source: { session: 'session', entries: ['u1'], origin: 'user_statement' } });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, cwd, store, manager, memory };
}

test('all codification kinds create reviewable drafts with provenance and guarded apply', async t => {
  const { manager, memory, cwd, store } = await fixture(t);
  for (const kind of ['skill', 'prompt', 'agent', 'hook', 'instructions'] as ProposalKind[]) {
    const proposal = await manager.propose(kind, [memory.id], `test-${kind}`, kind === 'hook' ? { tool: 'bash', pattern: 'git commit', action: 'confirm', message: 'Confirm focused tests passed.' } : undefined);
    assert.equal(proposal.provenance[0]!.session, 'session');
    await assert.rejects(manager.apply(proposal.id, false), /review/);
    const applied = await manager.apply(proposal.id, true);
    assert.equal(applied.status, 'applied');
    assert.equal(await readFile(applied.destination!, 'utf8'), proposal.draft);
  }
  assert.equal((await manager.list()).length, 5);
  assert.ok((await readFile(join(cwd, 'AGENTS.md'), 'utf8')).includes(memory.body));
  assert.equal((await readFile(join(store.rootDir, 'ledger.jsonl'), 'utf8')).trim().split('\n').length, 5);
});

test('proposal rejects traversal, unknown evidence and unreviewed instructions writes', async t => {
  const { manager, memory, cwd } = await fixture(t);
  await assert.rejects(manager.propose('skill', [memory.id], '../../outside'), /name/);
  await assert.rejects(manager.propose('prompt', ['missing'], 'test'), /sources/);
  await assert.rejects(manager.apply('../../outside', true), /ID/);
  const proposal = await manager.propose('instructions', [memory.id], 'tests');
  await assert.rejects(readFile(join(cwd, 'AGENTS.md')), /ENOENT/);
  await manager.reject(proposal.id);
  await assert.rejects(manager.apply(proposal.id, true), /pending/);
});

test('reviewed instructions append preserves existing contents and artifact collisions fail', async t => {
  const { manager, memory, cwd, store } = await fixture(t);
  await writeFile(join(cwd, 'AGENTS.md'), '# Existing instructions\n');
  const proposal = await manager.propose('instructions', [memory.id], 'tests');
  await manager.apply(proposal.id, true);
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), '# Existing instructions\n' + proposal.draft);
  const prompt = await manager.propose('prompt', [memory.id], 'existing');
  await mkdir(join(store.scopeDirectory(), 'prompts'), { recursive: true });
  await writeFile(join(store.scopeDirectory(), 'prompts', 'existing.md'), 'User content');
  await assert.rejects(manager.apply(prompt.id, true), /overwrite/);
});

test('reviewed apply refuses symlink destinations and stale evidence', async t => {
  const { manager, memory, store, root } = await fixture(t);
  const proposal = await manager.propose('skill', [memory.id], 'tests');
  const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(store.scopeDirectory(), 'skills'));
  await assert.rejects(manager.apply(proposal.id, true), /symlink/);
  const stale = await manager.propose('prompt', [memory.id], 'stale');
  await store.archive(memory.id);
  await assert.rejects(manager.apply(stale.id, true), /evidence changed/);
});

test('consolidation retains fresh memories and source evidence', async t => {
  const { store, memory } = await fixture(t);
  assert.deepEqual(await consolidate(store), { archived: 0, duplicates: 0 });
  assert.deepEqual(store.get([memory.id])[0]!.source.entries, ['u1']);
});

test('scoped cleanup disables hooks and later removes unchanged external artifacts from ledger', async t => {
  const { manager, memory, cwd } = await fixture(t);
  const agent = await manager.propose('agent', [memory.id], 'test-agent');
  const appliedAgent = await manager.apply(agent.id, true);
  await writeFile(join(cwd, 'AGENTS.md'), 'Original\n');
  const instructions = await manager.propose('instructions', [memory.id], 'test-instructions');
  await manager.apply(instructions.id, true);
  const hook = await manager.propose('hook', [memory.id], 'test-hook', { tool: 'bash', action: 'warn', message: 'Check tests.' });
  await manager.apply(hook.id, true);
  const first = await manager.cleanup('project', false);
  assert.equal(first.proposals, 3); assert.equal(first.artifacts, 0);
  assert.deepEqual(await manager.list(), []);
  assert.equal(await readFile(appliedAgent.destination!, 'utf8'), agent.draft);
  const second = await manager.cleanup('project', true);
  assert.equal(second.artifacts, 2);
  await assert.rejects(readFile(appliedAgent.destination!), /ENOENT/);
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), 'Original\n');
});

test('cleanup preserves user modifications and all-scope clears foreign proposals', async t => {
  const { manager, memory, store, root, cwd } = await fixture(t);
  const proposal = await manager.propose('agent', [memory.id], 'modified-agent');
  const applied = await manager.apply(proposal.id, true);
  await writeFile(applied.destination!, proposal.draft + '\nUser changes\n');
  const foreign = new MemoryStore(store.rootDir, 'foreign'); await foreign.initialize();
  t.after(() => foreign.close());
  const other = await foreign.save({ title: 'Other rule', body: 'Use other tests.', source: { session: 'other', entries: ['u2'], origin: 'user_statement' } });
  const otherManager = new ProposalManager(foreign, { root: store.rootDir, projectKey: 'foreign', cwd });
  await otherManager.propose('prompt', [other.id], 'foreign');
  const result = await manager.cleanup('all', true);
  assert.equal(result.proposals, 2); assert.equal(result.preserved.length, 1);
  assert.ok((await readFile(applied.destination!, 'utf8')).includes('User changes'));
  assert.deepEqual(await otherManager.list(), []);
});

test('earned multi-session procedures create only one unapplied proposal', async t => {
  const { manager, memory, store } = await fixture(t);
  await store.save({ ...memory, source: { session: 'second-session', entries: ['u2'], origin: 'user_confirmation' } });
  const proposals = await manager.proposeEarned();
  assert.equal(proposals.length, 1); assert.equal(proposals[0]!.status, 'pending');
  assert.equal((await manager.proposeEarned()).length, 0);
  assert.equal(store.get([memory.id])[0]!.status, 'active');
});


test('temporary evidence cannot escape expiry through persistent codification', async t => {
  const { manager, store, memory } = await fixture(t);
  const short = await store.save({ title: 'Temporary incident concurrency', body: 'Use one worker during the temporary incident.', type: 'procedure', retention: 'short', expiresAt: new Date(Date.now() + 3600000).toISOString(), source: { session: 'incident', entries: ['u3'], origin: 'user_statement' } });
  for (const kind of ['skill', 'prompt', 'agent', 'hook', 'instructions'] as ProposalKind[]) {
    await assert.rejects(manager.propose(kind, [short.id], `temporary-${kind}`, kind === 'hook' ? { tool: 'bash', action: 'warn', message: 'Temporary guard.' } : undefined), /Temporary memories cannot be codified/);
  }
  const existing = await manager.propose('skill', [memory.id], 'previously-durable');
  await writeFile(join(store.scopeDirectory(), 'items', `${memory.id}.md`), serializeMemory({ ...memory, retention: 'short', expiresAt: short.expiresAt }));
  await store.reindex();
  await assert.rejects(manager.apply(existing.id, true), /evidence changed/);
});

test('scoped clear removes dream hypotheses, reports and checkpoints without clearing another project', async t => {
  const { manager, store } = await fixture(t);
  const names = [join('hypotheses', `h_${'a'.repeat(24)}.json`), join('runs', `${'b'.repeat(64)}.json`), `processed-${'c'.repeat(24)}.json`];
  for (const name of names) {
    const path = join(store.rootDir, 'dream', name);
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(path, JSON.stringify({ scope: 'project:project', body: 'Private historical fact' }));
  }
  const foreign = join(store.rootDir, 'dream', 'hypotheses', `h_${'d'.repeat(24)}.json`);
  await writeFile(foreign, JSON.stringify({ scope: 'project:foreign', body: 'Another project' }));
  const result = await manager.cleanup('project', false);
  assert.equal(result.dreamFiles, 3);
  for (const name of names) await assert.rejects(readFile(join(store.rootDir, 'dream', name)), /ENOENT/);
  assert.ok(await readFile(foreign, 'utf8'));
  assert.equal((await manager.cleanup('all', false)).dreamFiles, 1);
});
