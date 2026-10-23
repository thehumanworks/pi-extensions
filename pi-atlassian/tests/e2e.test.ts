import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createService } from '../src/service.ts';
import type { RecordValue } from './helpers.ts';

// dotenvx is invoked by the supervisor. Never read .env files, print tenant data,
// or use a separate HTTP client. This suite cannot call plan/apply.
const enabled = process.env.ATLASSIAN_E2E === '1';

test('live public-service read-only Jira and Confluence journeys', {
  skip: !enabled && 'requires ATLASSIAN_E2E=1 and supervisor-supplied configuration',
  timeout: 180000,
}, async t => {
  for (const key of ['ATLASSIAN_BASE_URL', 'ATLASSIAN_API_USERNAME', 'ATLASSIAN_API_TOKEN']) {
    assert.ok(Boolean(process.env[key]), `live configuration requires ${key}`);
  }
  const parent = await mkdtemp(join(tmpdir(), 'atlassian-e2e-private-'));
  const service = createService({ config: loadConfig({ ...process.env, ATLASSIAN_ALLOW_WRITES: '0' }), storeDir: join(parent, 'sources') });
  // Service failures can contain tenant URLs/identifiers. Replace them rather
  // than attaching causes; node:test diagnostics must contain assertions only.
  async function call(action: string, input: RecordValue): Promise<RecordValue> {
    assert.ok(['discover', 'request', 'list', 'search', 'get', 'read'].includes(action), 'live test action must be read-only');
    try { return await service.call(action, input); }
    catch { throw new Error(`Live ${action} assertion failed (remote diagnostics intentionally suppressed)`); }
  }
  function array(value: unknown): RecordValue[] {
    assert.ok(Array.isArray(value), 'expected navigation array');
    assert.ok((value as unknown[]).every(item => item !== null && typeof item === 'object'), 'expected navigation objects');
    return value as RecordValue[];
  }
  function handle(result: RecordValue): string {
    assert.ok(typeof result.handle === 'string' && result.handle.length > 0, 'response must provide a source handle');
    return result.handle as string;
  }
  function id(item: RecordValue): string {
    const selected = item.id ?? item.key;
    assert.ok(typeof selected === 'string' && selected.length > 0, 'selected navigation item requires an id');
    return selected as string;
  }
  async function rawSource(sourceHandle: string): Promise<string> {
    let source = '';
    let offset = 0;
    for (let iteration = 0; iteration < 10000; iteration++) {
      const range = await call('read', { handle: sourceHandle, mode: 'raw', offset, length: 16000 });
      assert.ok(typeof range.text === 'string', 'raw source range must contain text');
      const text = range.text as string;
      assert.ok(range.offset === offset, 'raw source offset must be exact');
      assert.ok(text.length <= 16000, 'raw source must obey range budget');
      source += text;
      if (range.eof === true) {
        assert.ok(source.length === range.totalLength, 'raw source stitching must reach exact total length');
        return source;
      }
      assert.ok(text.length > 0 && range.nextOffset === offset + text.length, 'raw source ranges must progress exactly');
      offset += text.length;
    }
    assert.fail('raw source recovery exceeded bounded range count');
  }
  try {
    await t.test('Jira authenticated myself and project list assertions', async () => {
      let operationId: unknown;
      let offset = 0;
      for (let iteration = 0; iteration < 100; iteration++) {
        const catalog = await call('discover', { product: 'jira', kind: 'operations', query: 'myself', offset, limit: 100 });
        const op = array(catalog.items).find(item => item.method === 'GET' && item.path === '/rest/api/3/myself');
        if (op) { operationId = op.operationId; break; }
        if (catalog.eof === true) break;
        assert.ok(typeof catalog.nextOffset === 'number' && catalog.nextOffset > offset, 'catalog must make progress');
        offset = catalog.nextOffset as number;
      }
      assert.ok(typeof operationId === 'string', 'authenticated identity operation must be discoverable');
      const myself = await call('request', { product: 'jira', operationId });
      handle(myself);
      const projects = await call('list', { product: 'jira', kind: 'projects', limit: 1 });
      assert.ok(array(projects.items).length <= 1, 'project limit1 must be respected');
      assert.ok(typeof projects.complete === 'boolean', 'projects must explicitly report pagination');
      handle(projects);
    });

    const issues = await call('search', { product: 'jira', query: 'updated >= -30d ORDER BY updated DESC', limit: 1 });
    const selectedIssues = array(issues.items);
    assert.ok(selectedIssues.length <= 1, 'enhanced JQL limit1 must be respected');
    assert.ok(typeof issues.complete === 'boolean', 'JQL must explicitly report pagination');
    handle(issues);
    await t.test('Jira selected issue and comments assertions', { skip: selectedIssues.length === 0 && 'no accessible Jira issue from enhanced JQL' }, async () => {
      const selectedId = id(selectedIssues[0]!);
      const fetched = await call('get', { product: 'jira', kind: 'issue', id: selectedId });
      const source = await rawSource(handle(fetched));
      let parsed: unknown;
      try { parsed = JSON.parse(source); } catch { assert.fail('issue source must be complete valid JSON'); }
      assert.ok(parsed !== null && typeof parsed === 'object', 'issue source must be an object');
      const comments = await call('list', { product: 'jira', kind: 'comments', id: selectedId, limit: 1 });
      assert.ok(array(comments.items).length <= 1, 'comments limit1 must be respected');
      assert.ok(typeof comments.complete === 'boolean', 'comments must explicitly report pagination');
      handle(comments);
    });

    await t.test('Confluence authenticated space list assertions', async () => {
      const spaces = await call('list', { product: 'confluence', kind: 'spaces', limit: 1 });
      assert.ok(array(spaces.items).length <= 1, 'spaces limit1 must be respected');
      assert.ok(typeof spaces.complete === 'boolean', 'spaces must explicitly report pagination');
      handle(spaces);
    });
    const pages = await call('list', { product: 'confluence', kind: 'pages', limit: 1 });
    const selectedPages = array(pages.items);
    assert.ok(selectedPages.length <= 1, 'pages limit1 must be respected');
    assert.ok(typeof pages.complete === 'boolean', 'pages must explicitly report pagination');
    handle(pages);
    await t.test('Confluence selected page storage, outline and exact range assertions', { skip: selectedPages.length === 0 && 'no accessible Confluence page' }, async () => {
      const fetched = await call('get', { product: 'confluence', kind: 'page', id: id(selectedPages[0]!), bodyFormat: 'storage' });
      const sourceHandle = handle(fetched);
      const source = await rawSource(sourceHandle);
      let parsed: { body?: { storage?: { value?: unknown } } };
      try { parsed = JSON.parse(source) as typeof parsed; } catch { assert.fail('page source must be complete valid JSON'); }
      const storage = parsed.body?.storage?.value;
      assert.ok(typeof storage === 'string', 'page must have requested storage source');
      const pointer = '/body/storage/value';
      const first = await call('read', { handle: sourceHandle, pointer, mode: 'raw', offset: 0, length: 127 });
      assert.ok(first.text === storage.slice(0, 127), 'first storage range must exactly match upstream UTF16 source');
      assert.ok(first.totalLength === storage.length, 'storage total length must match upstream');
      const second = await call('read', { handle: sourceHandle, pointer, mode: 'raw', offset: Math.min(127, storage.length), length: 127 });
      assert.ok(second.text === storage.slice(127, 254), 'second storage range must exactly match upstream');
      const outline = await call('read', { handle: sourceHandle, pointer, mode: 'outline' });
      assert.ok(/derived/i.test(JSON.stringify(outline)), 'outline must be explicitly labeled derived');
    });
  } finally {
    try { await service.close(); }
    catch { throw new Error('Live source cleanup assertion failed (diagnostics suppressed)'); }
    finally { await rm(parent, { recursive: true, force: true }); }
  }
});
