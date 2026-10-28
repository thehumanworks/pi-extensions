import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DreamPipeline, compressSources, expandCompression, dreamGroups } from '../src/dream.ts';
import { MemoryStore, serializeMemory } from '../src/store.ts';
import type { MemoryItem } from '../src/types.ts';

const shared = 'For Beacon staging verification, run `pnpm beacon:smoke-v2` only after all staging migrations have passed. Never use the Beacon staging verification command against production.';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-dream-test-'));
  const store = new MemoryStore(root, 'project'); await store.initialize();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const items: MemoryItem[] = [];
  for (const [title, detail] of [['Beacon staging timeout', 'Beacon staging verification has a 45 second timeout.'], ['Beacon staging retries', 'Beacon staging verification permits 2 retries.'], ['Beacon staging workers', 'Beacon staging verification uses 3 workers.']]) {
    items.push(await store.save({ title: title!, body: `${shared} ${detail}`, keywords: ['beacon', 'staging', 'verification'], type: 'procedure', importance: 8, confidence: 0.95, source: { session: `session-${items.length}`, entries: ['u1'], origin: 'user_statement' } }));
  }
  return { root, store, items };
}
const output = (items: MemoryItem[]) => ({ groups: [{ sourceIds: items.map(item => item.id), title: 'Beacon staging verification', generalization: 'For Beacon staging only, after migrations pass, run pnpm beacon:smoke-v2 with a 45 second timeout, 2 retries and 3 workers. Never apply the staging command to production.', limitations: ['Staging only; migrations must pass first.'] }], declined: [] });
function context(value: unknown, before?: () => void | Promise<void>) {
  const requests: any[] = [];
  const ctx = { model: { id: 'test', maxTokens: 6000 }, modelRegistry: { hasConfiguredAuth: () => true, streamSimple: (_model: unknown, request: unknown) => {
    requests.push(request);
    return { result: async () => { await before?.(); return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(value) }], usage: { input: 101, output: 53, cacheRead: 17, cacheWrite: 29 } }; } };
  } } } as unknown as ExtensionContext;
  return { ctx, requests };
}

test('dictionary compression retains every title, condition, command, decimal and ordered fact', async t => {
  const { items } = await fixture(t);
  items[0]!.body += ' Use version 3.15 with threshold 0.75.';
  const plan = compressSources(items);
  assert.ok(plan.facts.length > 0);
  assert.deepEqual(expandCompression(plan).map(item => [item.title, item.body]), items.map(item => [item.title, item.body]));
  assert.ok(plan.body.includes('3.15')); assert.ok(plan.body.includes('0.75'));
  assert.ok(plan.body.includes('only after')); assert.ok(plan.body.includes('Never use'));
  assert.ok(plan.body.length < items.reduce((size, item) => size + item.body.length + item.title.length, 0));
});

test('dream saves smaller in-budget parents with linked provenance, keeps sources and hypotheses separate', async t => {
  const { root, store, items } = await fixture(t);
  const pipeline = new DreamPipeline(store, { root });
  const run = context(output(items));
  const result = await pipeline.run(run.ctx, new AbortController().signal, { force: true });
  assert.equal(result.status, 'completed'); assert.equal(result.savedIds.length, 1);
  assert.deepEqual(result.usage, { input: 101, output: 53, cacheRead: 17, cacheWrite: 29 });
  assert.ok(result.outputTokensEstimate < result.inputTokensEstimate);
  assert.ok(result.outputTokensEstimate <= 1200);
  const parent = store.get(result.savedIds)[0]!;
  assert.deepEqual(parent.links, items.map(item => item.id)); assert.equal(parent.source.origin, 'consolidation');
  assert.ok(!parent.body.includes('threshold invented by model'));
  assert.ok(items.every(item => store.get([item.id])[0]!.status === 'active'));
  const hypothesis = JSON.parse(await readFile(result.hypotheses[0]!.path, 'utf8'));
  assert.equal(hypothesis.status, 'unreviewed'); assert.equal(hypothesis.body, output(items).groups[0]!.generalization);
  const repeat = await pipeline.run(run.ctx, new AbortController().signal, { force: true });
  assert.equal(repeat.status, 'skipped'); assert.equal(run.requests.length, 1);
});

test('disjoint topics and scopes do not become a group merely because they are recent', async t => {
  const { items } = await fixture(t);
  const unrelated = { ...items[1]!, title: 'Invoice tax date', keywords: ['invoice', 'tax'], triggers: [], paths: [] };
  assert.deepEqual(dreamGroups([items[0]!, unrelated]), []);
  assert.deepEqual(dreamGroups([items[0]!, { ...items[1]!, scope: 'global' }]), []);
  assert.deepEqual(dreamGroups([{ ...items[0]!, paths: ['staging/**'] }, { ...items[1]!, paths: ['production/**'] }]), []);
});

test('foreign or invented provenance rejects the whole dream batch without writes', async t => {
  const { root, store, items } = await fixture(t);
  const response = output(items); response.groups[0]!.sourceIds[0] = 'invented';
  await assert.rejects(new DreamPipeline(store, { root }).run(context(response).ctx, new AbortController().signal, { force: true }), /source IDs/);
  assert.equal(store.list().length, items.length);
});

test('temporary parent and hypothesis inherit earliest explicit expiry without replacing long facts', async t => {
  const { root, store, items } = await fixture(t);
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const short = await store.save({ title: 'Beacon staging temporary retries', body: `${shared} During the Beacon incident, permit 1 retry only.`, keywords: ['beacon', 'staging', 'verification'], retention: 'short', expiresAt: expiry, source: { session: 'incident', entries: ['u2'], origin: 'user_statement' } });
  const group = [items[0]!, short];
  const result = await new DreamPipeline(store, { root }).run(context(output(group)).ctx, new AbortController().signal, { force: true, sourceIds: group.map(item => item.id) });
  const parent = store.get(result.savedIds)[0]!;
  assert.equal(parent.retention, 'short'); assert.equal(parent.expiresAt, expiry);
  assert.equal(result.hypotheses[0]!.expiresAt, expiry); assert.equal(items[0]!.retention, 'long');
  assert.ok(store.list().some(item => item.id === items[0]!.id));
});

test('abort and timeout prevent commits and release the scoped process lock', async t => {
  const { root, store, items } = await fixture(t);
  const controller = new AbortController();
  const aborted = context(output(items), () => controller.abort());
  await assert.rejects(new DreamPipeline(store, { root }).run(aborted.ctx, controller.signal, { force: true }), /abort/i);
  assert.equal(store.list().length, items.length);
  let release!: () => void, started!: () => void;
  const streaming = new Promise<void>(resolve => { started = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const slow = context(output(items), async () => { started(); await finish; });
  const first = new DreamPipeline(store, { root, timeoutMs: 50 }).run(slow.ctx, new AbortController().signal, { force: true });
  const settled = assert.rejects(first, /timed out/);
  await streaming;
  const second = await new DreamPipeline(store, { root }).run(context(output(items)).ctx, new AbortController().signal, { force: true });
  assert.equal(second.status, 'skipped'); assert.match(second.reason!, /lock/);
  await settled; release();
  assert.equal(store.list().length, items.length);
  const retry = await new DreamPipeline(store, { root }).run(context(output(items)).ctx, new AbortController().signal, { force: true });
  assert.equal(retry.savedIds.length, 1);
});

test('source changes during inference reject derived writes', async t => {
  const { root, store, items } = await fixture(t);
  const run = context(output(items), async () => { await store.archive(items[0]!.id); });
  await assert.rejects(new DreamPipeline(store, { root }).run(run.ctx, new AbortController().signal, { force: true }), /evidence changed/);
  assert.equal(store.list().length, items.length - 1);
});

test('soft byte pressure triggers compaction but never imposes destructive count eviction', async t => {
  const { root, store, items } = await fixture(t);
  const ordinary = context(output(items));
  assert.equal((await new DreamPipeline(store, { root }).run(ordinary.ctx, new AbortController().signal)).status, 'skipped');
  assert.equal(ordinary.requests.length, 0);
  const pressured = await new DreamPipeline(store, { root, softActiveBytes: 1 }).run(context(output(items)).ctx, new AbortController().signal);
  assert.equal(pressured.ceiling.overLimit, true); assert.equal(pressured.ceiling.softLimit, null);
  assert.equal(pressured.ceiling.destructive, false);
  assert.equal(pressured.ceiling.activeBytes, items.reduce((sum, item) => sum + Buffer.byteLength(serializeMemory(item)), 0));
  assert.ok(store.list().length >= items.length);
});

test('a compressed parent stops recalling immediately when source evidence is corrected', async t => {
  const { root, store, items } = await fixture(t);
  const result = await new DreamPipeline(store, { root }).run(context(output(items)).ctx, new AbortController().signal, { force: true });
  const parent = store.get(result.savedIds)[0]!;
  assert.equal(parent.derivedFrom?.length, items.length);
  await store.save({ title: items[0]!.title, body: 'Beacon staging verification now has a 90 second timeout.', keywords: ['beacon', 'staging', 'verification'], supersedes: [items[0]!.id], source: { session: 'correction', entries: ['u3'], origin: 'user_statement' } });
  assert.ok(!store.search('Beacon staging verification').some(item => item.id === parent.id));
  assert.equal(store.get([parent.id])[0]!.validity, 'stale-derived');
});

test('disjoint early entries do not consume the complete-group model budget', async t => {
  const { items } = await fixture(t);
  const singletons = Array.from({ length: 20 }, (_value, index) => ({ ...items[0]!, id: `singleton-${index}`, title: `uniquetopic${index}`, keywords: [`uniquetopic${index}`], triggers: [], importance: 10 }));
  const grouped = dreamGroups([...singletons, ...items], 3);
  assert.equal(grouped.length, 1); assert.deepEqual(grouped[0]!.map(item => item.id), items.map(item => item.id).sort((a, b) => a.localeCompare(b)));
});

test('processed group ledger advances later passes to new groups without copying source text into reports', async t => {
  const { root, store, items } = await fixture(t);
  const other: MemoryItem[] = [];
  for (const detail of ['Set the invoice limit to 2.', 'Set the invoice timeout to 30.', 'Set the invoice workers to 1.']) other.push(await store.save({ title: `Orion invoice allocation ${other.length}`, body: `For Orion invoice allocation, always validate the complete invoice before reserving a budget. Never allocate invalid invoices. ${detail}`, keywords: ['orion', 'invoice', 'allocation'], importance: 7, source: { session: 'invoices', entries: ['u2'], origin: 'user_statement' } }));
  const pipeline = new DreamPipeline(store, { root, maxSourceItems: 3 });
  const first = await pipeline.run(context(output(items)).ctx, new AbortController().signal, { force: true });
  // Equal-importance sources are ordered by ID, not save order; IDs may share
  // a timestamp prefix and differ only in their random suffix.
  assert.deepEqual(first.sourceIds, items.map(item => item.id).sort((a, b) => a.localeCompare(b)));
  const second = await pipeline.run(context(output(other)).ctx, new AbortController().signal, { force: true });
  assert.deepEqual(second.sourceIds, other.map(item => item.id).sort((a, b) => a.localeCompare(b)));
  const third = context({ groups: [], declined: [] });
  assert.equal((await pipeline.run(third.ctx, new AbortController().signal, { force: true })).status, 'skipped');
  assert.equal(third.requests.length, 0);
  const report = await readFile(store.get(first.savedIds)[0]!.source.session, 'utf8');
  assert.ok(!report.includes(items[0]!.body));
  assert.ok(!report.includes(output(items).groups[0]!.generalization));
});
