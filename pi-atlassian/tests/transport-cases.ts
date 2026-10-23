import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, json, operation, record, string, items, stitch, issue, page } from './helpers.ts';

test('read network retries are bounded and transient success remains recoverable', async t => {
  const { service, calls } = fixture(t, (_call, index) => {
    if (index < 2) throw new TypeError('fixture network unavailable');
    return json({ values: [], isLast: true });
  });
  const result = await service.call('list', { product: 'jira', kind: 'projects', limit: 1 });
  assert.equal(calls.length, 3);
  assert.equal(result.complete, true);
  assert.equal(await stitch(service, string(result.handle)), JSON.stringify({ values: [], isLast: true }));
});

test('perpetual read failures stop after a bounded number of attempts', async t => {
  const { service, calls } = fixture(t, () => json({ error: 'unavailable' }, 503), { ATLASSIAN_MAX_RETRIES: '1' });
  await assert.rejects(service.call('list', { product: 'jira', kind: 'projects' }), /503|unavailable|HTTP/i);
  assert.equal(calls.length, 2);
});

test('configured deadline aborts a hanging fetch without retrying past deadline', { timeout: 2000 }, async t => {
  const { service, calls } = fixture(t, call => new Promise<Response>((_resolve, reject) => {
    const signal = call.init.signal;
    assert.ok(signal, 'deadline must be propagated to injected fetch');
    signal.addEventListener('abort', () => reject(new DOMException('deadline fixture', 'AbortError')), { once: true });
  }), { ATLASSIAN_TIMEOUT_MS: '25' });
  await assert.rejects(service.call('list', { product: 'jira', kind: 'projects' }), /deadline|timeout|abort/i);
  assert.equal(calls.length, 1);
});

test('cancellation while streaming the body rejects rather than storing partial content', { timeout: 2000 }, async t => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  let announce: () => void = () => {};
  const started = new Promise<void>(resolve => { announce = resolve; });
  const { service, calls } = fixture(t, call => {
    signal = call.init.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(new TextEncoder().encode('{"values":['));
      assert.ok(signal);
      signal.addEventListener('abort', () => stream.error(new DOMException('stream cancelled', 'AbortError')), { once: true });
      announce();
    } }), { headers: { 'content-type': 'application/json' } });
  });
  const pending = service.call('list', { product: 'jira', kind: 'projects' }, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, /abort|cancel/i);
  assert.equal(calls.length, 1);
});

test('byte bound counts UTF8 bytes, including unknown-length streams, not UTF16 units', async t => {
  const raw = JSON.stringify({ values: [], padding: '😀'.repeat(100) });
  assert.ok(raw.length < 256 && Buffer.byteLength(raw, 'utf8') > 256);
  const { service, calls } = fixture(t, () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const bytes = new TextEncoder().encode(raw);
    controller.enqueue(bytes.slice(0, 150));
    controller.enqueue(bytes.slice(150));
    controller.close();
  } }), { headers: { 'content-type': 'application/json' } }), { ATLASSIAN_MAX_RESPONSE_BYTES: '256' });
  await assert.rejects(service.call('list', { product: 'jira', kind: 'projects' }), /large|size|byte|limit|exceed/i);
  assert.equal(calls.length, 1);
});

test('valid gateway continuation stays under the configured cloud/product root', async t => {
  const { service, calls } = fixture(t, (_call, index) => json({ results: [page], _links: index === 0 ? { next: '/wiki/api/v2/pages?cursor=REMOTE&limit=1' } : {} }), { ATLASSIAN_BASE_URL: 'https://api.atlassian.com', ATLASSIAN_CLOUD_ID: 'dummy-cloud' });
  const input = { product: 'confluence', kind: 'pages', limit: 1 };
  const first = await service.call('list', input);
  assert.equal(first.complete, false);
  const second = await service.call('list', { ...input, cursor: first.nextCursor });
  assert.equal(second.complete, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]);
  assert.equal(calls[1].url.origin, 'https://api.atlassian.com');
  assert.equal(calls[1].url.pathname, '/ex/confluence/dummy-cloud/wiki/api/v2/pages');
  assert.equal(calls[1].url.searchParams.get('cursor'), 'REMOTE');
});

for (const next of [
  'https://api.atlassian.com/ex/jira/dummy-cloud/rest/api/3/myself',
  'https://api.atlassian.com/ex/confluence/other-cloud/wiki/api/v2/pages',
  'https://attacker@evil.example/wiki/api/v2/pages',
  '/wiki/api/v2/%2f..%2f..%2fadmin',
]) {
  test(`gateway rejects product/cloud/traversal changes in continuations: ${next}`, async t => {
    const { service, calls } = fixture(t, () => json({ results: [page], _links: { next } }), { ATLASSIAN_BASE_URL: 'https://api.atlassian.com', ATLASSIAN_CLOUD_ID: 'dummy-cloud' });
    await assert.rejects(async () => {
      const first = await service.call('list', { product: 'confluence', kind: 'pages', limit: 1 });
      await service.call('list', { product: 'confluence', kind: 'pages', limit: 1, cursor: first.nextCursor });
    }, /origin|root|cloud|path|pagination|unsafe|URL|traversal/i);
    assert.equal(calls.length, 1);
  });
}

test('Jira comments total/startAt pagination is explicit and preserves unknown rich source', async t => {
  const comment = { id: '10050', body: issue.fields.description, author: { accountId: 'fixture-account', displayName: 'Fixture author' }, future: { nested: 'COMMENT_UNKNOWN_SENTINEL' } };
  const { service, calls } = fixture(t, (_call, index) => json({ startAt: index, maxResults: 1, total: 2, comments: [{ ...comment, id: String(10050 + index) }] }));
  const input = { product: 'jira', kind: 'comments', id: 'TEST-1', limit: 1 };
  const first = await service.call('list', input);
  assert.equal(first.total, 2);
  assert.equal(first.complete, false);
  assert.ok(!JSON.stringify(first.items).includes('UNPROJECTED_ADF_SENTINEL'));
  const second = await service.call('list', { ...input, cursor: first.nextCursor });
  assert.equal(second.complete, true);
  assert.ok(calls[1]);
  assert.equal(calls[1].url.searchParams.get('startAt'), '1');
  assert.match(await stitch(service, string(first.handle)), /COMMENT_UNKNOWN_SENTINEL/);
  assert.equal(calls.length, 2);
});

test('missing continuation and pagination cycles fail instead of pretending completeness', async t => {
  const missing = fixture(t, () => json({ issues: [issue], isLast: false }));
  await assert.rejects(missing.service.call('search', { product: 'jira', query: 'ORDER BY key', limit: 1 }), /page|continuation|more/i);
  const cycle = fixture(t, () => json({ results: [page], _links: { next: '/wiki/api/v2/pages?limit=1' } }));
  await assert.rejects(cycle.service.call('list', { product: 'confluence', kind: 'pages', limit: 1 }), /cycle|stall|continuation/i);
  assert.equal(cycle.calls.length, 1);
});

test('recognized semantic POST reads work, while missing required mutation body and binary writes fail locally', async t => {
  const { service, calls } = fixture(t, () => json({ issues: [], isLast: true }));
  const semantic = await operation(service, 'jira', 'POST', '/rest/api/3/search/jql');
  assert.equal(semantic.write, false);
  const result = await service.call('request', { product: 'jira', operationId: semantic.operationId, body: { jql: 'ORDER BY key', maxResults: 1 } });
  assert.equal(result.complete, true);
  assert.equal(calls.length, 1);
  const create = await operation(service, 'confluence', 'POST', '/wiki/api/v2/pages');
  await assert.rejects(service.call('plan', { product: 'confluence', operationId: create.operationId, reason: 'missing required body' }), /required|body|missing/i);
  const upload = await operation(service, 'jira', 'POST', '/rest/api/3/issue/{issueIdOrKey}/attachments');
  await assert.rejects(service.call('plan', { product: 'jira', operationId: upload.operationId, path: { issueIdOrKey: 'TEST-1' }, body: { file: 'not an upload' }, reason: 'unsupported multipart' }), /multipart|binary|non.JSON|unsupported/i);
  assert.equal(calls.length, 1);
});

test('catalog-typed Confluence update re-reads version and then attempts one exact PUT', async t => {
  const { service, calls } = fixture(t, call => call.method === 'GET' ? json(page) : json({ ...page, version: { number: 8 } }), { ATLASSIAN_ALLOW_WRITES: '1' });
  const op = await operation(service, 'confluence', 'PUT', '/wiki/api/v2/pages/{id}');
  const schema = await service.call('schema', { product: 'confluence', operationId: op.operationId });
  const details = record(JSON.parse(await stitch(service, string(schema.handle))) as unknown);
  const idParameter = items(details.parameters).find(param => param.in === 'path' && param.name === 'id');
  assert.ok(idParameter);
  const idType = record(idParameter.schema).type;
  assert.ok(idType === 'integer' || idType === 'string', 'choose path input from the current generated schema');
  const pathId = idType === 'integer' ? Number(page.id) : page.id;
  const body = { id: page.id, status: 'current', title: page.title, body: { representation: 'storage', value: '<p>approved fixture</p>' }, version: { number: 8 } };
  const plan = await service.call('plan', { product: 'confluence', operationId: op.operationId, path: { id: pathId }, body, expectedVersion: 7, reason: 'test version match' });
  assert.equal(calls.length, 0);
  const result = await service.call('apply', { planId: plan.planId, confirm: plan.planId });
  assert.equal(calls.length, 2);
  assert.ok(calls[0] && calls[1]);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(calls[1].body, body);
  assert.ok(result.handle);
  assert.match(await stitch(service, string(result.handle)), /approved|Fixture page/);
});

test('configured concurrency bound queues reads and cancellation removes a queued read', { timeout: 3000 }, async t => {
  let active = 0;
  let peak = 0;
  let reportTwo: () => void = () => {};
  const twoStarted = new Promise<void>(resolve => { reportTwo = resolve; });
  const release: Array<() => void> = [];
  const { service, calls } = fixture(t, call => new Promise<Response>((resolve, reject) => {
    active++; peak = Math.max(peak, active);
    if (active === 2) reportTwo();
    const complete = () => { active--; resolve(json({ values: [], isLast: true })); };
    release.push(complete);
    call.init.signal?.addEventListener('abort', () => { active--; reject(new DOMException('fixture abort', 'AbortError')); }, { once: true });
  }), { ATLASSIAN_MAX_CONCURRENCY: '2' });
  const input = { product: 'jira', kind: 'projects', limit: 1 };
  const first = service.call('list', input);
  const second = service.call('list', input);
  // Attach handlers immediately so assertion/cleanup cannot create unhandled rejections.
  const initial = Promise.allSettled([first, second]);
  await twoStarted;
  const queuedAbort = new AbortController();
  const queued = service.call('list', input, queuedAbort.signal);
  const rejection = assert.rejects(queued, /abort|cancel/i);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2, 'third request must remain queued');
  queuedAbort.abort();
  await rejection;
  for (const complete of release.splice(0)) complete();
  const results = await initial;
  assert.ok(results.every(result => result.status === 'fulfilled'));
  assert.equal(calls.length, 2, 'cancelled queued read must never reach authenticated fetch');
  assert.equal(peak, 2);
});

test('cursor IDs are runtime-scoped and replay an immutable continuation request', async t => {
  const first = fixture(t, (_call, index) => json({ issues: [issue], isLast: index > 0, ...(index === 0 ? { nextPageToken: 'remote-cursor-token' } : {}) }));
  const second = fixture(t, () => assert.fail('foreign cursor must never reach fetch'));
  const input = { product: 'jira', query: 'ORDER BY key', limit: 1 };
  const start = await first.service.call('search', input);
  const cursor = string(start.nextCursor);
  await assert.rejects(second.service.call('search', { ...input, cursor }), /cursor|unknown|expired|fetch/i);
  await first.service.call('search', { ...input, cursor });
  await first.service.call('search', { ...input, cursor });
  assert.ok(first.calls[1] && first.calls[2]);
  assert.deepEqual(first.calls[1].body, first.calls[2].body, 'reusing a cursor must not advance mutable cursor state');
  assert.equal(record(first.calls[2].body).nextPageToken, 'remote-cursor-token');
  const original = await stitch(first.service, string(start.handle));
  assert.equal(record(JSON.parse(original) as unknown).nextPageToken, 'remote-cursor-token', 'later pages must not mutate the first source');
});
