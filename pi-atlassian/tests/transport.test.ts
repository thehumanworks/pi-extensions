import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, json, items, string, stitch, operation, record } from './helpers.ts';
import { pathSegment, id } from '../src/util.ts';

for (const base of ['enterprise.example.test', 'enterprise.example.test:8443/wiki', 'enterprise.example.test/context/wiki']) {
  test(`safe configured hostname shorthand uses HTTPS: ${base}`, async t => {
    const { service, calls } = fixture(t, () => json({ results: [] }), { ATLASSIAN_BASE_URL: base });
    await service.call('list', { product: 'confluence', kind: 'pages', limit: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url.href, `https://${base.replace(/\/wiki$/, '')}/wiki/api/v2/pages?limit=1`);
  });
}
for (const base of [
  'http://enterprise.example.test', '//enterprise.example.test', 'user@enterprise.example.test',
  'https://user:password@enterprise.example.test', 'enterprise.example.test?x=1', 'enterprise.example.test#x',
  'enterprise.example.test/../admin', 'https://enterprise.example.test/wiki/../admin',
  'enterprise.example.test/%2e%2e/admin', 'enterprise.example.test/%252e%252e/admin',
  'enterprise.example.test/wiki\\admin', ' enterprise.example.test', 'https:enterprise.example.test',
  'https:///enterprise.example.test',
]) {
  test(`unsafe configured base fails before fetch: ${base}`, async t => {
    const { service, calls } = fixture(t, () => assert.fail('unsafe base must not fetch'), { ATLASSIAN_BASE_URL: base });
    await assert.rejects(service.call('list', { product: 'jira', kind: 'projects', limit: 1 }));
    assert.equal(calls.length, 0);
  });
}

for (const product of ['jira', 'confluence']) {
  test(`${product} oversized upstream page drains locally then resumes once, retaining source and cursor replay`, async t => {
    const raw = product === 'jira'
      ? ' {"issues":[{"id":"1","fields":{"description":"KEEP"}},{"id":"2"}],"nextPageToken":"next","isLast":false}\r\n'
      : ' {"results":[{"id":"1","body":"KEEP"},{"id":"2"}],"_links":{"next":"/api/v2/pages?cursor=next"}}\r\n';
    const { service, calls } = fixture(t, (request, index) => {
      if (index === 0) return new Response(raw, { headers: { 'content-type': 'application/json' } });
      if (product === 'jira') assert.equal(record(request.body).nextPageToken, 'next');
      else assert.equal(request.url.searchParams.get('cursor'), 'next');
      return json(product === 'jira' ? { issues: [{ id: '3' }], isLast: true } : { results: [{ id: '3' }] });
    });
    const action = product === 'jira' ? 'search' : 'list';
    const input = product === 'jira' ? { product, query: 'updated >= -30d', limit: 1 } : { product, kind: 'pages', limit: 1 };
    const first = await service.call(action, input);
    assert.deepEqual(items(first.items).map(x => x.id), ['1']);
    assert.equal(first.complete, false);
    assert.equal(await stitch(service, string(first.handle)), raw);
    const local = await service.call(action, { ...input, cursor: first.nextCursor });
    assert.deepEqual(items(local.items).map(x => x.id), ['2']);
    assert.equal(local.handle, first.handle);
    assert.equal(local.complete, false);
    assert.equal(local.hasMore, true);
    assert.equal(calls.length, 1);
    const replay = await service.call(action, { ...input, cursor: first.nextCursor });
    assert.deepEqual(items(replay.items), items(local.items));
    assert.equal(replay.handle, first.handle);
    assert.equal(calls.length, 1);
    const last = await service.call(action, { ...input, cursor: local.nextCursor });
    assert.deepEqual(items(last.items).map(x => x.id), ['3']);
    assert.equal(last.complete, true);
    assert.equal(last.nextCursor, undefined);
    assert.notEqual(last.handle, first.handle);
    assert.equal(calls.length, 2);
  });
}

test('unpaginated arrays drain losslessly from the same source without refetching', async t => {
  const values = [{ id: '1', unknown: 'KEEP' }, { id: '2' }, { id: '3' }];
  const { service, calls } = fixture(t, () => json(values));
  const input = { product: 'jira', kind: 'remoteLinks', id: 'TEST-1', limit: 1 };
  let result = await service.call('list', input);
  const handle = string(result.handle);
  for (const expected of ['1', '2', '3']) {
    assert.deepEqual(items(result.items).map(x => x.id), [expected]);
    assert.equal(result.handle, handle);
    if (result.nextCursor) result = await service.call('list', { ...input, cursor: result.nextCursor });
  }
  assert.equal(result.complete, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(await stitch(service, handle)), values);
});

for (const base of ['https://enterprise.example.test/wiki', 'https://enterprise.example.test/context/wiki', 'https://api.atlassian.com']) {
  test(`Confluence /api/v2-relative continuation retains configured root: ${base}`, async t => {
    const { service, calls } = fixture(t, (_request, index) => json(index === 0
      ? { results: [{ id: '1' }], _links: { next: '/api/v2/pages?cursor=next' } }
      : { results: [{ id: '2' }] }), { ATLASSIAN_BASE_URL: base, ATLASSIAN_CLOUD_ID: 'dummy-cloud' });
    const input = { product: 'confluence', kind: 'pages', limit: 1 };
    const first = await service.call('list', input);
    await service.call('list', { ...input, cursor: first.nextCursor });
    assert.equal(calls[1]!.url.pathname, calls[0]!.url.pathname);
    assert.equal(calls[1]!.url.searchParams.get('cursor'), 'next');
  });
}
for (const next of ['/api/v2/spaces?cursor=x', '/api/v2/../admin', '/api/v2/%2e%2e/pages', '/api/v2/%252fadmin', '//evil.example/api/v2/pages']) {
  test(`Confluence relative continuation still rejects hostile or different operation: ${next}`, async t => {
    const { service, calls } = fixture(t, () => json({ results: [], _links: { next } }));
    await assert.rejects(service.call('list', { product: 'confluence', kind: 'pages', limit: 1 }), /pagination|Pagination/);
    assert.equal(calls.length, 1);
  });
}

test('generic documented dotted property keys encode safely; resource IDs remain strict', async t => {
  assert.equal(pathSegment('account:123'), 'account%3A123');
  assert.throws(() => id('account:123'), /Invalid id/);
  assert.throws(() => id('app.property'), /Invalid id/);
  const { service, calls } = fixture(t, () => json({ value: 'retained' }));
  const op = await operation(service, 'jira', 'GET', '/rest/api/3/user/properties/{propertyKey}');
  await service.call('request', { product: 'jira', operationId: op.operationId, path: { propertyKey: 'app.property' }, query: { accountId: 'account:123' } });
  assert.equal(calls[0]!.url.pathname, '/rest/api/3/user/properties/app.property');
  assert.equal(calls[0]!.url.searchParams.get('accountId'), 'account:123');
  const user = await operation(service, 'jira', 'GET', '/rest/api/3/user/properties/{propertyKey}');
  for (const propertyKey of ['.', '..', '../bad', 'a/b', 'a\\b', '%2e%2e', 'a?x', 'a#x']) {
    await assert.rejects(service.call('request', { product: 'jira', operationId: user.operationId, path: { propertyKey }, query: { accountId: 'account:123' } }), /path parameter/);
  }
  assert.equal(calls.length, 1);
});

for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
  test(`permanent TLS failure ${code} is actionable, safe and not retried`, async t => {
    const { service, calls } = fixture(t, () => { throw new TypeError('sensitive server detail', { cause: Object.assign(new Error('sensitive certificate detail'), { code }) }); });
    await assert.rejects(service.call('list', { product: 'jira', kind: 'projects', limit: 1 }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /TLS certificate verification failed/);
      assert.match(error.message, /NODE_EXTRA_CA_CERTS/);
      assert.ok(!error.message.includes('sensitive'));
      return true;
    });
    assert.equal(calls.length, 1);
  });
}
