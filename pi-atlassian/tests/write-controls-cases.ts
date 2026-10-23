import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, operation, json, items, string, stitch, issue, page, mockFetch } from './helpers.ts';
import { createService, type Service } from '../src/service.ts';
import { loadConfig } from '../src/config.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function plan(service: Service, confluence = false) {
  const op = await operation(service, confluence ? 'confluence' : 'jira', 'PUT', confluence ? '/wiki/api/v2/pages/{id}' : '/rest/api/3/issue/{issueIdOrKey}');
  return service.call('plan', confluence ? {
    product: 'confluence', operationId: op.operationId, path: { id: page.id }, expectedVersion: 7,
    body: { id: page.id, status: 'current', title: page.title, body: { representation: 'storage', value: '<p>mock</p>' }, version: { number: 8 } }, reason: 'mock control regression',
  } : { product: 'jira', operationId: op.operationId, path: { issueIdOrKey: issue.key }, body: { fields: { summary: 'mock' } }, reason: 'mock control regression' });
}
const apply = (service: Service, proposal: Record<string, unknown>, signal?: AbortSignal) => service.call('apply', { planId: proposal.planId, confirm: proposal.planId }, signal);

test('trusted control updates effective state without altering config or exact reads/cursors; OFF expires plans', async t => {
  const raw = '{\r\n "values": [{"id":"1","future":"😀"},{"id":"2"}], "total":2\r\n}';
  const { service, calls } = fixture(t, () => new Response(raw));
  const input = { product: 'jira', kind: 'projects', limit: 1 };
  const first = await service.call('list', input);
  const old = await plan(service);
  assert.equal(old.writesEnabled, false);
  service.setAllowWrites(true);
  assert.equal((await service.call('discover', { kind: 'status' })).writesEnabled, true);
  service.setAllowWrites(false);
  service.setAllowWrites(true);
  await assert.rejects(apply(service, old), /unknown|expired|consumed/i);
  assert.equal(await stitch(service, string(first.handle)), raw);
  const next = await service.call('list', { ...input, cursor: first.nextCursor });
  assert.equal(items(next.items)[0]!.id, '2');
  assert.equal(next.handle, first.handle);
  assert.equal(calls.length, 1);
  const fresh = await plan(service);
  assert.equal(fresh.writesEnabled, true);
  await service.close();
  assert.throws(() => service.setAllowWrites(true), /closed/i);
  await assert.rejects(apply(service, fresh), /closed/i);
});

test('trusted write control keeps injected config private and has no model-callable action', async t => {
  const config = loadConfig({});
  const mock = mockFetch(() => assert.fail('trusted control must be offline'));
  const service = createService({ config, fetch: mock.fetch });
  t.after(() => service.close());
  service.setAllowWrites(true);
  assert.equal(config.allowWrites, false, 'construction clones caller config');
  assert.equal((await service.call('discover', { kind: 'status' })).writesEnabled, true);
  await assert.rejects(service.call('setAllowWrites', { enabled: true }), /unknown action/i);
  service.setAllowWrites(false);
  assert.equal((await service.call('discover', { kind: 'status' })).writesEnabled, false);
  assert.equal(mock.calls.length, 0);
});

test('caller cancellation during Confluence version re-read consumes the plan and prevents PUT', async t => {
  const entered = deferred<void>(), response = deferred<Response>();
  const { service, calls } = fixture(t, request => {
    assert.equal(request.method, 'GET');
    entered.resolve(); return response.promise;
  });
  service.setAllowWrites(true);
  const proposal = await plan(service, true);
  const caller = new AbortController();
  const pending = apply(service, proposal, caller.signal);
  const rejected = assert.rejects(pending, /abort|cancel/i);
  await entered.promise;
  caller.abort();
  response.resolve(json(page));
  await rejected;
  await assert.rejects(apply(service, proposal), /unknown|consumed|expired/i);
  assert.equal(calls.length, 1);
});

test('OFF then ON during Confluence version re-read prevents subsequent PUT, even with a fetch ignoring abort', async t => {
  const entered = deferred<void>(), response = deferred<Response>();
  const { service, calls } = fixture(t, request => {
    assert.equal(request.method, 'GET');
    entered.resolve(); return response.promise;
  });
  service.setAllowWrites(true);
  const proposal = await plan(service, true);
  const pending = apply(service, proposal);
  const rejected = assert.rejects(pending, /revoked|cancel|abort/i);
  await entered.promise;
  service.setAllowWrites(false); service.setAllowWrites(true);
  response.resolve(json(page));
  await rejected;
  await assert.rejects(apply(service, proposal), /unknown|consumed|expired/i);
  assert.equal(calls.length, 1);
});

test('OFF then ON aborts a queued mutation but not the unrelated in-flight read', async t => {
  const entered = deferred<void>(), response = deferred<Response>();
  const { service, calls } = fixture(t, request => {
    assert.equal(request.method, 'GET');
    entered.resolve(); return response.promise;
  }, { ATLASSIAN_MAX_CONCURRENCY: '1' });
  service.setAllowWrites(true);
  const proposal = await plan(service);
  const read = service.call('get', { product: 'jira', kind: 'issue', id: issue.key });
  await entered.promise;
  const pending = apply(service, proposal);
  const rejected = assert.rejects(pending, /revoked|cancel|abort/i);
  // Apply reaches transport without an approval await; it is blocked by the read.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  service.setAllowWrites(false); service.setAllowWrites(true);
  response.resolve(json(issue));
  const saved = await read;
  await rejected;
  assert.equal(await stitch(service, string(saved.handle)), JSON.stringify(issue));
  await assert.rejects(apply(service, proposal), /unknown|consumed|expired/i);
  assert.equal(calls.length, 1);
});
