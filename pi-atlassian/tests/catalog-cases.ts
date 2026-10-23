import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixture, items, record, operation, string, stitch } from './helpers.ts';

test('discovery method/path metadata matches the bundled generated index', async t => {
  const { service, calls } = fixture(t, () => assert.fail('bundled catalog must not fetch'));
  const bundled = items(JSON.parse(await readFile(new URL('../docs/catalog/index.json', import.meta.url), 'utf8')) as unknown);
  assert.ok(bundled.length > 100, 'catalog must cover more than a handcrafted happy-path subset');
  for (const [product, method, path] of [
    ['jira', 'GET', '/rest/api/3/myself'],
    ['jira', 'POST', '/rest/api/3/search/jql'],
    ['jira', 'PUT', '/rest/api/3/issue/{issueIdOrKey}'],
    ['confluence', 'GET', '/wiki/api/v2/pages/{id}'],
    ['confluence', 'PUT', '/wiki/api/v2/pages/{id}'],
    ['confluence', 'GET', '/wiki/rest/api/content/search'],
  ]) {
    const expected = bundled.find(item => item.product === product && item.method === method && item.path === path);
    assert.ok(expected, 'generated index must contain the current method/path');
    const discovered = await operation(service, product!, method!, path!);
    for (const key of ['operationId', 'product', 'method', 'path', 'summary', 'write', 'docs']) assert.deepEqual(discovered[key], expected[key]);
  }
  assert.equal(calls.length, 0);
});

test('selective operation schemas expose required types and resolve local refs offline', async t => {
  const { service, calls } = fixture(t, () => assert.fail('schema retrieval must be offline'));
  const op = await operation(service, 'jira', 'GET', '/rest/api/3/issue/{issueIdOrKey}');
  const schema = await service.call('schema', { product: 'jira', operationId: op.operationId });
  const details = record(JSON.parse(await stitch(service, string(schema.handle))) as unknown);
  assert.equal(details.operationId, op.operationId);
  assert.equal(details.path, op.path);
  const parameters = items(details.parameters);
  const requiredPath = parameters.find(item => item.in === 'path' && item.name === 'issueIdOrKey');
  assert.ok(requiredPath);
  assert.equal(requiredPath.required, true);
  assert.equal(record(requiredPath.schema).type, 'string');
  const refs = new Set<string>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')) refs.add(child);
      else visit(child);
    }
  }
  visit(details.responses);
  assert.ok(refs.size > 0, 'real issue schema must expose response schema references');
  const ref = [...refs][0]!;
  const resolved = await service.call('schema', { product: 'jira', ref });
  const responseSchema = record(JSON.parse(await stitch(service, string(resolved.handle))) as unknown);
  assert.ok(Object.keys(responseSchema).length > 0);
  await assert.rejects(service.call('schema', { product: 'jira', ref: '#/components/schemas/does-not-exist' }), /unknown|schema|reference|ref/i);
  await assert.rejects(service.call('schema', { product: 'jira', operationId: op.operationId, pointer: '/missing' }), /pointer|exist|missing/i);
  assert.equal(calls.length, 0);
});

test('known retired operations cannot be executed even when present in the bundled index', async t => {
  const { service, calls } = fixture(t, () => assert.fail('retired operations must not reach the network'));
  const bundled = items(JSON.parse(await readFile(new URL('../docs/catalog/index.json', import.meta.url), 'utf8')) as unknown);
  const retired = bundled.find(item => item.product === 'jira' && item.method === 'GET' && item.path === '/rest/api/3/search');
  if (retired) {
    await assert.rejects(service.call('request', { product: 'jira', operationId: retired.operationId, query: { jql: 'ORDER BY key' } }), /retired|deprecated|reject/i);
  } else {
    const result = await service.call('discover', { product: 'jira', kind: 'operations', query: '/rest/api/3/search' });
    assert.ok(!items(result.items).some(item => item.path === '/rest/api/3/search' && item.write === false), 'retired search must not be advertised as an executable read');
  }
  assert.equal(calls.length, 0);
});
