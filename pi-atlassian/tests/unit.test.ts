import './catalog-cases.ts';
import './transport-cases.ts';
import './write-controls-cases.ts';
import './fields-cases.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createService } from '../src/service.ts';
import { DUMMY, fixture, mockFetch, json, record, string, items, operation, stitch, issue, page, storage } from './helpers.ts';

const neverFetch = () => assert.fail('offline/local operation must not fetch');

test('construction and offline discovery work without credentials or filesystem creation', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'atlassian-lazy-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const storeDir = join(parent, 'not-created');
  const mock = mockFetch(neverFetch);
  const timeout = t.mock.method(globalThis, 'setTimeout', () => assert.fail('factory must not create timers'));
  const interval = t.mock.method(globalThis, 'setInterval', () => assert.fail('factory must not create intervals'));
  let service: ReturnType<typeof createService>;
  try { service = createService({ config: loadConfig({}), fetch: mock.fetch, storeDir }); }
  finally { timeout.mock.restore(); interval.mock.restore(); }
  t.after(() => service.close());
  assert.deepEqual(await readdir(parent), []);
  const result = await service.call('discover', { kind: 'status' });
  assert.ok(Object.keys(result).length > 0);
  assert.deepEqual(await readdir(parent), []);
  assert.equal(mock.calls.length, 0);
  await assert.rejects(service.call('list', { product: 'jira', kind: 'projects', limit: 1 }), /config|credential|token|username|base.?url/i);
  assert.equal(mock.calls.length, 0);
});

test('catalog is offline, paged, accurate and schemas are selectively available', async t => {
  const { service } = fixture(t, neverFetch);
  const status = JSON.stringify(await service.call('discover', { kind: 'status' }));
  assert.ok(!status.includes(DUMMY.ATLASSIAN_API_TOKEN));
  assert.ok(!status.includes(DUMMY.ATLASSIAN_API_USERNAME));
  assert.ok(!status.includes(Buffer.from(`${DUMMY.ATLASSIAN_API_USERNAME}:${DUMMY.ATLASSIAN_API_TOKEN}`).toString('base64')));
  const first = await service.call('discover', { product: 'jira', kind: 'operations', limit: 2 });
  assert.equal(items(first.items).length, 2);
  assert.equal(first.eof, false);
  assert.equal(typeof first.nextOffset, 'number');
  const next = await service.call('discover', { product: 'jira', kind: 'operations', offset: first.nextOffset, limit: 2 });
  assert.notDeepEqual(items(first.items).map(x => x.operationId), items(next.items).map(x => x.operationId));
  for (const item of items(first.items)) {
    for (const key of ['operationId', 'product', 'method', 'path', 'summary']) assert.equal(typeof item[key], 'string');
    assert.equal(typeof item.write, 'boolean');
    assert.ok(item.docs !== undefined);
    assert.equal(item.requestBody, undefined, 'discovery must not dump request schemas');
  }
  const op = await operation(service, 'jira', 'GET', '/rest/api/3/issue/{issueIdOrKey}');
  assert.equal(op.write, false);
  const schema = await service.call('schema', { product: 'jira', operationId: op.operationId });
  const serialized = JSON.stringify(schema);
  assert.match(serialized, /issueIdOrKey/);
  assert.match(serialized, /required/);
  assert.match(serialized, /response/i);
  await assert.rejects(service.call('schema', { product: 'jira', ref: 'https://evil.example/schema.json' }), /ref|remote|local|schema/i);
  await assert.rejects(service.call('request', { product: 'jira', operationId: op.operationId }), /required|missing|issueIdOrKey/i);
  await assert.rejects(service.call('request', { product: 'jira', operationId: 'https://evil.example' }), /operation|unknown|recognized/i);
});

test('Jira get retains exact CRLF/whitespace/Unicode, unknown fields and ADF without hidden requests', async t => {
  const source = '\r\n  ' + JSON.stringify(issue, null, 2).replaceAll('\n', '\r\n') + '\r\n';
  const { service, calls } = fixture(t, () => new Response(source, { headers: { 'content-type': 'application/json' } }));
  const result = await service.call('get', { product: 'jira', kind: 'issue', id: 'TEST-1' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/rest/api/3/issue/TEST-1');
  assert.ok(calls[0].url.searchParams.get('fields'), 'default useful fields must be explicit');
  assert.ok(calls[0].url.searchParams.get('fields')!.split(',').includes('duedate'));
  assert.ok(!calls[0].url.searchParams.get('fields')!.includes('*all'), 'all values remain explicit opt-in');
  assert.deepEqual(result.fieldDiscovery, { tool: 'atlassian_list', input: { product: 'jira', kind: 'editableFields', id: 'TEST-1' } });
  assert.deepEqual(result.fieldsRequested, calls[0].url.searchParams.get('fields')!.split(','));
  assert.match(string(result.fieldSelectionNote), /not a capability inventory/);
  assert.ok([issue.id, issue.key].includes(string(record(result.metadata).id)), 'metadata id must identify the selected issue');
  assert.equal(record(result.metadata).product, 'jira');
  assert.equal(record(result.metadata).kind, 'issue');
  assert.ok(!JSON.stringify(result).includes('UNPROJECTED_ADF_SENTINEL'));
  const handle = string(result.handle);
  assert.equal(await stitch(service, handle), source);
  const sourceInfo = await service.call('read', { handle, mode: 'raw', length: 1 });
  const digest = createHash('sha256').update(source, 'utf8').digest('hex');
  assert.ok(JSON.stringify(sourceInfo).includes(digest), 'source checksum must remain available and match exact upstream bytes');
  assert.equal(await stitch(service, handle, '/fields/description'), JSON.stringify(issue.fields.description));
  assert.equal(await stitch(service, handle, '/fields/customfield_12345'), JSON.stringify(issue.fields.customfield_12345));
  assert.equal(calls.length, 1, 'local reads must not refetch or expand content');
});

test('Confluence page requests explicit storage format, exact ranges preserve long lines and macros', async t => {
  const { service, calls } = fixture(t, () => json(page));
  const result = await service.call('get', { product: 'confluence', kind: 'page', id: page.id });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(calls[0].url.pathname, '/wiki/api/v2/pages/20001');
  assert.equal(calls[0].url.searchParams.get('body-format'), 'storage');
  assert.equal(record(result.metadata).version, 7);
  assert.deepEqual(result.fieldDiscovery, { tool: 'atlassian_list', input: { product: 'confluence', kind: 'editableFields', id: page.id } });
  assert.ok(!JSON.stringify(result).includes('MACRO_SOURCE_SENTINEL'));
  const handle = string(result.handle);
  assert.equal(await stitch(service, handle, '/body/storage/value'), storage);
  const defaults = await service.call('read', { handle, pointer: '/body/storage/value', mode: 'raw' });
  assert.equal(string(defaults.text).length, 2000);
  const max = await service.call('read', { handle, pointer: '/body/storage/value', mode: 'raw', length: 16000 });
  assert.equal(string(max.text).length, 16000);
  const outline = await service.call('read', { handle, pointer: '/body/storage/value', mode: 'outline' });
  assert.match(JSON.stringify(outline), /derived/i);
  assert.match(JSON.stringify(outline), /Heading/);
  assert.match(JSON.stringify(outline), /Second/);
  assert.ok(!JSON.stringify(outline).includes('MACRO_SOURCE_SENTINEL'), 'unknown macros are not fabricated headings');
  const offsets: number[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, val] of Object.entries(value)) {
      if (/^(offset|start|startOffset|sourceOffset)$/.test(key) && typeof val === 'number') offsets.push(val);
      else visit(val);
    }
  }
  visit(outline);
  // Outline can be a labeled range of serialized derived JSON, as read promises.
  if (typeof outline.text === 'string') {
    try { visit(JSON.parse(outline.text) as unknown); } catch { /* checked by locator assertion below */ }
  }
  assert.ok(offsets.some(offset => offset >= storage.indexOf('<h2>') && offset < storage.indexOf('</h2>')), 'second heading locator must point into the original storage string, not stripped markdown');
  assert.equal(calls.length, 1);
});

test('RFC6901 pointers, empty values and UTF16 range edges are deterministic', async t => {
  const object = { ...issue, 'a/b': { '~key': 'A😀B\r\n世界', empty: '', nil: null, flag: false, zero: 0 }, array: ['first'] };
  const { service } = fixture(t, () => json(object));
  const result = await service.call('get', { product: 'jira', kind: 'issue', id: 'TEST-1' });
  const handle = string(result.handle);
  const pointer = '/a~1b/~0key';
  assert.equal(await stitch(service, handle, pointer, 1), object['a/b']['~key']);
  for (const [pointer, expected] of [['/a~1b/empty', ''], ['/a~1b/nil', 'null'], ['/a~1b/flag', 'false'], ['/a~1b/zero', '0'], ['/array/0', 'first']]) {
    assert.equal(await stitch(service, handle, pointer), expected);
  }
  const end = await service.call('read', { handle, pointer, offset: object['a/b']['~key'].length, length: 10 });
  assert.equal(end.text, ''); assert.equal(end.eof, true);
  for (const pointer of ['not/a/pointer', '/bad~2escape', '/missing', '/array/99']) {
    await assert.rejects(service.call('read', { handle, pointer }), /pointer|missing|exist|escape|invalid|index/i);
  }
  for (const range of [{ offset: -1 }, { offset: 0.5 }, { length: -1 }, { length: 16001 }]) {
    await assert.rejects(service.call('read', { handle, ...range }), /offset|length|range|integer|invalid/i);
  }
});

test('get does not cache away upstream version changes', async t => {
  const { service, calls } = fixture(t, (_call, index) => json({ ...page, version: { number: 7 + index } }));
  const first = await service.call('get', { product: 'confluence', kind: 'page', id: page.id });
  const second = await service.call('get', { product: 'confluence', kind: 'page', id: page.id });
  assert.equal(calls.length, 2);
  assert.notEqual(first.handle, second.handle);
  assert.equal(record(first.metadata).version, 7);
  assert.equal(record(second.metadata).version, 8);
});

test('Jira enhanced JQL pagination is explicit, immutable, query-bound and metadata-only', async t => {
  const { service, calls } = fixture(t, (_call, index) => json({ issues: [{ ...issue, key: `TEST-${index + 1}` }], isLast: index > 0, ...(index === 0 ? { nextPageToken: 'UPSTREAM_TOKEN_NOT_A_CURSOR' } : {}), future: { retained: true } }));
  const input = { product: 'jira', query: 'project = TEST ORDER BY key', limit: 1, fields: ['summary', 'description'] };
  const first = await service.call('search', input);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url.pathname, '/rest/api/3/search/jql');
  assert.equal(record(calls[0].body).jql, input.query);
  assert.equal(record(calls[0].body).maxResults, 1);
  assert.equal(first.complete, false);
  const cursor = string(first.nextCursor);
  assert.notEqual(cursor, 'UPSTREAM_TOKEN_NOT_A_CURSOR');
  assert.ok(!JSON.stringify(first).includes('UNPROJECTED_ADF_SENTINEL'));
  assert.equal(items(first.items).length, 1);
  assert.match(await stitch(service, string(first.handle)), /KEEP_UNKNOWN_SENTINEL/);
  for (const changed of [{ query: 'project = OTHER' }, { product: 'confluence' }, { limit: 2 }, { fields: ['summary'] }]) {
    await assert.rejects(service.call('search', { ...input, ...changed, cursor }), /cursor|bound|mismatch|input/i);
  }
  await assert.rejects(service.call('search', { ...input, cursor: cursor + '-tampered' }), /cursor|unknown|invalid|fetch/i);
  assert.equal(calls.length, 1);
  const second = await service.call('search', { ...input, cursor });
  assert.ok(calls[1]);
  assert.equal(record(calls[1].body).nextPageToken, 'UPSTREAM_TOKEN_NOT_A_CURSOR');
  assert.equal(second.complete, true);
  assert.equal(second.nextCursor, undefined);
  assert.equal(calls.length, 2);
});

test('Confluence CQL is the explicit v1 search exception, never a hidden page fetch', async t => {
  const { service, calls } = fixture(t, () => json({ results: [{ id: page.id, type: 'page', title: page.title, body: page.body, _links: { webui: '/pages/20001' }, unknown: 'KEEP_SEARCH_SOURCE' }], start: 0, limit: 1, size: 1, _links: {} }));
  const result = await service.call('search', { product: 'confluence', query: 'type = page AND space = "TEST"', limit: 1 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/wiki/rest/api/content/search');
  assert.equal(calls[0].url.searchParams.get('cql'), 'type = page AND space = "TEST"');
  assert.ok(!JSON.stringify(result.items).includes('MACRO_SOURCE_SENTINEL'));
  assert.match(await stitch(service, string(result.handle)), /KEEP_SEARCH_SOURCE/);
  assert.equal(calls.length, 1);
});

test('Confluence list pagination binds kind/id/space and preserves source', async t => {
  const { service, calls } = fixture(t, (_call, index) => json({ results: [{ ...page, id: String(20001 + index) }], _links: index === 0 ? { next: '/wiki/api/v2/pages?limit=1&cursor=REMOTE&space-id=30001' } : {}, future: ['KEEP_PAGING_SOURCE'] }));
  const input = { product: 'confluence', kind: 'pages', spaceId: '30001', limit: 1 };
  const first = await service.call('list', input);
  assert.equal(first.complete, false);
  const cursor = string(first.nextCursor);
  for (const change of [{ spaceId: '999' }, { kind: 'spaces' }, { id: 'other' }, { limit: 2 }]) {
    await assert.rejects(service.call('list', { ...input, ...change, cursor }), /cursor|bound|mismatch|input/i);
  }
  assert.equal(calls.length, 1);
  const second = await service.call('list', { ...input, cursor });
  assert.ok(calls[1]);
  assert.equal(calls[1].url.searchParams.get('cursor'), 'REMOTE');
  assert.equal(second.complete, true);
  assert.match(await stitch(service, string(first.handle)), /KEEP_PAGING_SOURCE/);
  assert.equal(calls.length, 2);
});

for (const next of [
  'https://evil.example/wiki/api/v2/pages?cursor=stolen',
  '//evil.example/wiki/api/v2/pages',
  '/rest/api/3/issue/10001',
  '/wiki/api/v2/../admin',
  '/wiki/api/v2/%2e%2e/admin',
  '/wiki/api/v2/%252e%252e/admin',
]) {
  test(`unsafe pagination link is rejected without credential forwarding: ${next}`, async t => {
    const { service, calls } = fixture(t, () => json({ results: [page], _links: { next } }));
    await assert.rejects(async () => {
      const first = await service.call('list', { product: 'confluence', kind: 'pages', limit: 1 });
      assert.equal(first.complete, false, 'unsafe next page must not be hidden as completion');
      await service.call('list', { product: 'confluence', kind: 'pages', limit: 1, cursor: first.nextCursor });
    }, /pagination|origin|path|root|unsafe|URL|link|traversal|protocol/i);
    assert.equal(calls.length, 1, 'hostile continuation must never reach fetch');
  });
}

for (const [env, product, expectedPath, auth] of [
  [{}, 'jira', '/rest/api/3/project/search', 'Basic ' + Buffer.from(`${DUMMY.ATLASSIAN_API_USERNAME}:${DUMMY.ATLASSIAN_API_TOKEN}`).toString('base64')],
  [{ ATLASSIAN_AUTH_MODE: 'bearer' }, 'jira', '/rest/api/3/project/search', `Bearer ${DUMMY.ATLASSIAN_API_TOKEN}`],
  [{ ATLASSIAN_BASE_URL: 'https://enterprise.example.test/wiki' }, 'confluence', '/wiki/api/v2/spaces', null],
  [{ ATLASSIAN_BASE_URL: 'https://api.atlassian.com', ATLASSIAN_CLOUD_ID: 'cloud-dummy' }, 'jira', '/ex/jira/cloud-dummy/rest/api/3/project/search', null],
  [{ ATLASSIAN_BASE_URL: 'https://api.atlassian.com', ATLASSIAN_CLOUD_ID: 'cloud-dummy' }, 'confluence', '/ex/confluence/cloud-dummy/wiki/api/v2/spaces', null],
] as const) {
  test(`auth and configured routing: ${product} ${expectedPath}`, async t => {
    const { service, calls } = fixture(t, () => json(product === 'jira' ? { values: [], isLast: true } : { results: [], _links: {} }), env);
    const result = await service.call('list', { product, kind: product === 'jira' ? 'projects' : 'spaces', limit: 1 });
    assert.ok(calls[0]);
    assert.equal(calls[0].url.pathname, expectedPath);
    if (auth) assert.equal(calls[0].headers.get('authorization'), auth);
    assert.equal(calls[0].init.redirect, 'error');
    const output = JSON.stringify(result);
    assert.ok(!output.includes(DUMMY.ATLASSIAN_API_TOKEN));
    assert.ok(!output.includes(DUMMY.ATLASSIAN_API_USERNAME));
    assert.ok(!output.includes(Buffer.from(`${DUMMY.ATLASSIAN_API_USERNAME}:${DUMMY.ATLASSIAN_API_TOKEN}`).toString('base64')));
  });
}

test('insecure production hosts and gateway without cloudId fail before fetch', async () => {
  for (const base of ['http://enterprise.example.test', 'https://api.atlassian.com']) {
    const mock = mockFetch(neverFetch);
    await assert.rejects(async () => {
      const service = createService({ config: loadConfig({ ...DUMMY, ATLASSIAN_BASE_URL: base }), fetch: mock.fetch });
      try { await service.call('list', { product: 'jira', kind: 'projects' }); } finally { await service.close(); }
    }, /https|secure|cloud|gateway/i);
    assert.equal(mock.calls.length, 0);
  }
});

test('generic requests forbid mutation, arbitrary endpoints, headers and malformed path IDs', async t => {
  const { service, calls } = fixture(t, neverFetch);
  const getOp = await operation(service, 'jira', 'GET', '/rest/api/3/issue/{issueIdOrKey}');
  const writeOp = await operation(service, 'jira', 'PUT', '/rest/api/3/issue/{issueIdOrKey}');
  await assert.rejects(service.call('request', { product: 'jira', operationId: writeOp.operationId, path: { issueIdOrKey: 'TEST-1' }, body: { fields: { summary: 'new' } } }), /write|mutat|plan|read.only/i);
  for (const id of ['../admin', '%2e%2e/admin', '//evil.example', 'a/b', 'TEST-1?expand=secret', 'TEST-1#fragment']) {
    await assert.rejects(service.call('request', { product: 'jira', operationId: getOp.operationId, path: { issueIdOrKey: id } }), /path|id|invalid|unsafe|parameter|traversal/i);
  }
  for (const extra of [{ url: 'https://evil.example' }, { headers: { authorization: 'Bearer attacker' } }]) {
    await assert.rejects(service.call('request', { product: 'jira', operationId: getOp.operationId, path: { issueIdOrKey: 'TEST-1' }, ...extra }), /unknown|unsupported|url|header|parameter|argument/i);
  }
  await assert.rejects(service.call('list', { product: 'jira', kind: 'not-real', id: 'TEST-1' }), /kind|unsupported/i);
  assert.equal(calls.length, 0);
});

test('204 remains valid and explicit; non-JSON responses do not pretend to be JSON', async t => {
  const { service } = fixture(t, (_call, index) => index === 0 ? new Response(null, { status: 204 }) : new Response('plain 😀 text', { headers: { 'content-type': 'text/plain' } }));
  const op = await operation(service, 'jira', 'GET', '/rest/api/3/myself');
  const empty = await service.call('request', { product: 'jira', operationId: op.operationId });
  assert.equal(await stitch(service, string(empty.handle)), '');
  const plain = await service.call('request', { product: 'jira', operationId: op.operationId });
  assert.equal(await stitch(service, string(plain.handle)), 'plain 😀 text');
  assert.match(JSON.stringify(plain), /text\/plain|non.?json|text/i);
});

for (const status of [401, 403]) {
  test(`auth status ${status} is not retried and errors redact secrets`, async t => {
    const basic = Buffer.from(`${DUMMY.ATLASSIAN_API_USERNAME}:${DUMMY.ATLASSIAN_API_TOKEN}`).toString('base64');
    const { service, calls } = fixture(t, () => json({ errorMessages: [`token ${DUMMY.ATLASSIAN_API_TOKEN} Authorization: Basic ${basic} Bearer ${DUMMY.ATLASSIAN_API_TOKEN}`, 'x'.repeat(50000)] }, status));
    let message = '';
    await assert.rejects(service.call('list', { product: 'jira', kind: 'projects' }), error => {
      message = String(error);
      assert.ok(!message.includes(DUMMY.ATLASSIAN_API_TOKEN));
      assert.ok(!message.includes(basic));
      assert.ok(message.length < 20000);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.match(message, new RegExp(`${status}|auth|forbidden`, 'i'));
  });
}

test('read retry handles bounded 429/5xx without losing the successful exact source', async t => {
  const { service, calls } = fixture(t, (_call, index) => index === 0 ? json({ error: 'rate limited' }, 429, { 'retry-after': '0' }) : index === 1 ? json({ error: 'temporarily unavailable' }, 503) : json({ values: [], isLast: true }));
  const result = await service.call('list', { product: 'jira', kind: 'projects', limit: 1 });
  assert.equal(calls.length, 3);
  assert.equal(result.complete, true);
});

test('unbounded Retry-After is surfaced, not slept or immediately retried', { timeout: 2000 }, async t => {
  const { service, calls } = fixture(t, () => json({ error: 'rate limited' }, 429, { 'retry-after': '86400' }));
  await assert.rejects(service.call('list', { product: 'jira', kind: 'projects' }), /429|retry|delay|rate/i);
  assert.equal(calls.length, 1);
});

test('pre-aborted and in-flight cancellation honor the supplied signal', { timeout: 2000 }, async t => {
  const controller = new AbortController();
  controller.abort();
  const immediate = fixture(t, neverFetch);
  await assert.rejects(immediate.service.call('list', { product: 'jira', kind: 'projects' }, controller.signal), /abort|cancel/i);
  assert.equal(immediate.calls.length, 0);
  const active = new AbortController();
  let notifyStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const { service, calls } = fixture(t, call => new Promise<Response>((_resolve, reject) => {
    const signal = call.init.signal;
    assert.ok(signal);
    signal.addEventListener('abort', () => reject(new DOMException('Aborted fixture', 'AbortError')), { once: true });
    notifyStarted();
  }));
  const pending = service.call('list', { product: 'jira', kind: 'projects' }, active.signal);
  await started;
  active.abort();
  await assert.rejects(pending, /abort|cancel/i);
  assert.equal(calls.length, 1);
});

test('oversize source fails explicitly rather than storing a complete truncated handle', async t => {
  // Deliberately above any sensible agent-response bound, while still cheap to stream.
  const { service, calls } = fixture(t, () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent++ < 128) controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      else controller.close();
    } });
    return new Response(stream, { headers: { 'content-type': 'application/json', 'content-length': String(128 * 1024 * 1024) } });
  });
  await assert.rejects(service.call('list', { product: 'jira', kind: 'projects' }), /large|size|bytes|limit|exceed/i);
  assert.equal(calls.length, 1);
});

test('redirects are never followed by authenticated fetch', async t => {
  const { service, calls } = fixture(t, () => new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } }));
  await assert.rejects(service.call('list', { product: 'jira', kind: 'projects' }), /302|redirect|HTTP/i);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(calls[0].init.redirect, 'error');
});

test('source handles are runtime scoped and cannot be replaced by filesystem paths', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'atlassian-private-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sentinel = join(parent, 'caller-owned.txt');
  await writeFile(sentinel, 'caller-owned');
  const storeDir = join(parent, 'store');
  const first = fixture(t, () => json(issue), {}, storeDir);
  const second = fixture(t, neverFetch);
  const source = await first.service.call('get', { product: 'jira', kind: 'issue', id: 'TEST-1' });
  const handle = string(source.handle);
  assert.ok(!handle.includes(parent));
  for (const bad of [handle, sentinel, '/etc/passwd', '../caller-owned.txt', 'unknown-handle']) {
    await assert.rejects(second.service.call('read', { handle: bad }), /handle|unknown|expired|fetch|path/i);
  }
  await assert.rejects(first.service.call('read', { handle: handle + 'tampered' }), /handle|unknown|expired|fetch/i);
  const found: string[] = [];
  async function inspect(path: string): Promise<void> {
    const info = await stat(path);
    if (info.isDirectory()) {
      assert.equal(info.mode & 0o777, 0o700, 'owned source directories must be private');
      for (const entry of await readdir(path)) await inspect(join(path, entry));
    } else {
      assert.equal(info.mode & 0o777, 0o600, 'source files must be private');
      found.push(path);
    }
  }
  await inspect(storeDir);
  assert.ok(found.length > 0);
  await first.service.close();
  await first.service.close();
  assert.equal(await readFile(sentinel, 'utf8'), 'caller-owned');
  for (const path of found) await assert.rejects(stat(path), /ENOENT/);
  await assert.rejects(first.service.call('read', { handle }), /closed|handle|expired|fetch/i);
});

async function jiraPlan(service: ReturnType<typeof createService>) {
  const op = await operation(service, 'jira', 'PUT', '/rest/api/3/issue/{issueIdOrKey}');
  return service.call('plan', { product: 'jira', operationId: op.operationId, path: { issueIdOrKey: 'TEST-1' }, body: { fields: { summary: 'approved fixture summary' } }, reason: 'independent test fixture' });
}

test('plans preview locally; default read-only mode prevents apply without a UI gate', async t => {
  const { service, calls } = fixture(t, neverFetch);
  const plan = await jiraPlan(service);
  assert.equal(typeof plan.planId, 'string');
  assert.equal(typeof plan.digest, 'string');
  const preview = JSON.stringify(plan);
  assert.match(preview, /PUT/); assert.match(preview, /TEST-1/); assert.match(preview, /approved fixture summary/);
  assert.match(preview, /atomic|CAS|concurren/i);
  assert.ok(!preview.includes(DUMMY.ATLASSIAN_API_TOKEN));
  await assert.rejects(service.call('apply', { planId: plan.planId, confirm: plan.planId }), /write|allow|read.only|disabled/i);
  assert.equal(calls.length, 0);
});

test('apply requires exact plan confirmation; write opt-in authorizes without an approval callback', async t => {
  const { service, calls } = fixture(t, () => new Response(null, { status: 204 }), { ATLASSIAN_ALLOW_WRITES: '1' });
  const plan = await jiraPlan(service);
  assert.equal(plan.approvalRequired, false);
  for (const confirm of ['yes', true, undefined, 'other-plan']) {
    await assert.rejects(service.call('apply', { planId: plan.planId, confirm }), /confirm|match/i);
  }
  assert.equal(calls.length, 0);
  const result = await service.call('apply', { planId: plan.planId, confirm: plan.planId });
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1);
});

test('plan snapshots caller body, consumes before request, and concurrent apply mutates once', async t => {
  const { service, calls } = fixture(t, () => new Response(null, { status: 204 }), { ATLASSIAN_ALLOW_WRITES: '1' });
  const op = await operation(service, 'jira', 'PUT', '/rest/api/3/issue/{issueIdOrKey}');
  const body = { fields: { summary: 'immutable approved payload' } };
  const plan = await service.call('plan', { product: 'jira', operationId: op.operationId, path: { issueIdOrKey: 'TEST-1' }, body, reason: 'test snapshot' });
  body.fields.summary = 'unapproved mutated payload';
  assert.ok(!(await stitch(service, string(plan.handle))).includes('unapproved mutated payload'));
  const apply = () => service.call('apply', { planId: plan.planId, confirm: plan.planId });
  const results = await Promise.allSettled([apply(), apply()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(record(record(calls[0].body).fields).summary, 'immutable approved payload');
  await assert.rejects(apply(), /used|consum|plan|unknown/i);
  assert.equal(calls.length, 1);
});

for (const failure of ['503', '429', 'network'] as const) {
  test(`mutations never retry and uncertain plans remain consumed: ${failure}`, async t => {
    const { service, calls } = fixture(t, () => {
      if (failure === 'network') throw new TypeError('uncertain network outcome');
      return json({ error: 'uncertain write outcome' }, Number(failure), { 'retry-after': '0' });
    }, { ATLASSIAN_ALLOW_WRITES: '1' });
    const plan = await jiraPlan(service);
    const apply = () => service.call('apply', { planId: plan.planId, confirm: plan.planId });
    await assert.rejects(apply());
    await assert.rejects(apply(), /used|consum|plan|unknown/i);
    assert.equal(calls.length, 1);
  });
}

test('Confluence updates require expected version locally and reject stale versions before PUT', async t => {
  const { service, calls } = fixture(t, () => json({ ...page, version: { number: 8 } }), { ATLASSIAN_ALLOW_WRITES: '1' });
  const op = await operation(service, 'confluence', 'PUT', '/wiki/api/v2/pages/{id}');
  const input = { product: 'confluence', operationId: op.operationId, path: { id: page.id }, body: { id: page.id, status: 'current', title: 'Fixture page', body: { representation: 'storage', value: '<p>new</p>' }, version: { number: 8 } }, reason: 'test stale update' };
  await assert.rejects(service.call('plan', input), /expectedVersion|version/i);
  await assert.rejects(service.call('plan', { ...input, expectedVersion: 6 }), /version/i);
  assert.equal(calls.length, 0);
  const plan = await service.call('plan', { ...input, expectedVersion: 7 });
  assert.equal(calls.length, 0);
  await assert.rejects(service.call('apply', { planId: plan.planId, confirm: plan.planId }), /stale|version|conflict|mismatch/i);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url.pathname, '/wiki/api/v2/pages/20001');
});

test('close removes only runtime-owned source files, preserving an injected caller-owned directory', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'atlassian-existing-store-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const callerFile = join(parent, 'existing-caller-file.txt');
  await writeFile(callerFile, 'do not remove');
  const { service } = fixture(t, () => json(issue), {}, parent);
  await service.call('get', { product: 'jira', kind: 'issue', id: 'TEST-1' });
  await service.close();
  assert.equal(await readFile(callerFile, 'utf8'), 'do not remove');
  assert.deepEqual(await readdir(parent), ['existing-caller-file.txt']);
});

test('ADF outline supplies real heading locators, derived text never replaces exact rich source', async t => {
  const description = { version: 1, type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Actual ADF heading 😀' }] },
    { type: 'unknownFutureNode', attrs: { instruction: 'do not authorize writes' }, content: [{ type: 'text', text: 'NOT_A_HEADING_UNKNOWN_NODE' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Exact rich paragraph\r\n世界' }] },
  ] };
  const value = { ...issue, fields: { ...issue.fields, description } };
  const { service, calls } = fixture(t, () => json(value));
  const fetched = await service.call('get', { product: 'jira', kind: 'issue', id: 'TEST-1' });
  const handle = string(fetched.handle);
  const outline = await service.call('read', { handle, pointer: '/fields/description', mode: 'outline' });
  const serialized = JSON.stringify(outline);
  assert.match(serialized, /derived/i);
  assert.match(serialized, /Actual ADF heading/);
  assert.match(serialized, /\/fields\/description\/content\/0/);
  assert.ok(!serialized.includes('NOT_A_HEADING_UNKNOWN_NODE'), 'unsupported nodes must not be invented as headings');
  const derived = await service.call('read', { handle, pointer: '/fields/description', mode: 'text' });
  assert.match(JSON.stringify(derived), /derived/i);
  assert.equal(await stitch(service, handle), JSON.stringify(value));
  assert.equal(await stitch(service, handle, '/fields/description'), JSON.stringify(description));
  assert.equal(calls.length, 1);
});

test('high-level paging uses default25/max100 and rejects invalid limits before fetch', async t => {
  const { service, calls } = fixture(t, call => json(call.method === 'POST' ? { issues: [], isLast: true } : { values: [], isLast: true }));
  await service.call('list', { product: 'jira', kind: 'projects' });
  assert.ok(calls[0]);
  assert.equal(calls[0].url.searchParams.get('maxResults'), '25');
  await service.call('search', { product: 'jira', query: 'ORDER BY key', limit: 100 });
  assert.ok(calls[1]);
  assert.equal(record(calls[1].body).maxResults, 100);
  for (const limit of [0, -1, 101, 1.5, '1']) {
    await assert.rejects(service.call('search', { product: 'jira', query: 'ORDER BY key', limit }), /limit|integer|range/i);
    await assert.rejects(service.call('list', { product: 'jira', kind: 'projects', limit }), /limit|integer|range/i);
  }
  assert.equal(calls.length, 2);
});

test('attachment list is metadata-only and never follows an arbitrary download URL', async t => {
  const attachment = { id: '90001', filename: 'fixture.bin', mimeType: 'application/octet-stream', size: 1234, content: 'https://evil.example/private-download', thumbnail: 'https://evil.example/thumbnail', unknown: { retained: true } };
  const response = { ...issue, fields: { attachment: [attachment] } };
  const { service, calls } = fixture(t, () => json(response));
  const result = await service.call('list', { product: 'jira', kind: 'attachments', id: 'TEST-1', limit: 1 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  assert.equal(calls[0].url.pathname, '/rest/api/3/issue/TEST-1');
  assert.equal(calls[0].url.searchParams.get('fields'), 'attachment');
  assert.equal(items(result.items)[0]?.id, attachment.id);
  assert.equal(result.complete, true);
  assert.equal(await stitch(service, string(result.handle)), JSON.stringify(response));
  assert.equal(calls.length, 1, 'source recovery must not fetch the binary/thumbnail URLs');
});

for (const [kind, endpoint] of [
  ['comments', 'footer-comments'], ['inlineComments', 'inline-comments'],
  ['children', 'direct-children'], ['ancestors', 'ancestors'], ['descendants', 'descendants'], ['attachments', 'attachments'],
] as const) {
  test(`Confluence ${kind} lists one page only and retains unprojected source`, async t => {
    const value = { results: [{ id: '21001', title: 'Fixture related resource', body: { storage: { value: 'UNREQUESTED_RELATED_BODY_SENTINEL' } }, future: { preserve: true } }], _links: {} };
    const { service, calls } = fixture(t, () => json(value));
    const result = await service.call('list', { product: 'confluence', kind, id: page.id, limit: 1 });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]);
    assert.equal(calls[0].url.pathname, `/wiki/api/v2/pages/${page.id}/${endpoint}`);
    assert.ok(!JSON.stringify(result.items).includes('UNREQUESTED_RELATED_BODY_SENTINEL'));
    assert.equal(await stitch(service, string(result.handle)), JSON.stringify(value));
    assert.equal(calls.length, 1, 'relationship listing must never crawl or fetch item bodies');
  });
}

test('large mutation previews are exact, locally recoverable and do not perform writes', async t => {
  const { service, calls } = fixture(t, neverFetch);
  const op = await operation(service, 'jira', 'PUT', '/rest/api/3/issue/{issueIdOrKey}');
  const body = { fields: { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Exact preview 😀\r\n'.repeat(4000) }] }] } } };
  const result = await service.call('plan', { product: 'jira', operationId: op.operationId, path: { issueIdOrKey: 'TEST-1' }, body, reason: 'large preview fixture' });
  assert.equal(typeof result.planId, 'string');
  assert.equal(typeof result.digest, 'string');
  const preview = record(JSON.parse(await stitch(service, string(result.handle), undefined, 16000)) as unknown);
  assert.equal(preview.planId, result.planId);
  assert.equal(preview.method, 'PUT');
  assert.deepEqual(preview.payload, body);
  assert.equal(preview.digest, result.digest);
  assert.equal(calls.length, 0);
});
