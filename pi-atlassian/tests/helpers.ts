import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createService } from '../src/service.ts';

export type RecordValue = Record<string, unknown>;
export type Service = ReturnType<typeof createService>;
export type CapturedRequest = { url: URL; method: string; headers: Headers; body: unknown; init: RequestInit };
export const DUMMY = {
  ATLASSIAN_BASE_URL: 'https://enterprise.example.test',
  ATLASSIAN_API_USERNAME: 'dummy-user@example.test',
  ATLASSIAN_API_TOKEN: 'dummy-token-never-real-9c83',
};
export function record(value: unknown): RecordValue {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}
export function string(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}
export function items(value: unknown): RecordValue[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
export function mockFetch(handler: (request: CapturedRequest, index: number) => Response | Promise<Response>) {
  const calls: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const rawBody = init.body;
    let body: unknown = rawBody;
    if (typeof rawBody === 'string') {
      try { body = JSON.parse(rawBody); } catch { /* non-JSON remains observable */ }
    }
    const call = {
      url: new URL(request?.url ?? String(input)),
      method: (init.method ?? request?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init.headers ?? request?.headers), body, init,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch, calls };
}
export function fixture(t: TestContext, handler: Parameters<typeof mockFetch>[0], env: Record<string, string | undefined> = {}, storeDir?: string) {
  const mock = mockFetch(handler);
  const service = createService({ config: loadConfig({ ...DUMMY, ...env }), fetch: mock.fetch, ...(storeDir === undefined ? {} : { storeDir }) });
  t.after(() => service.close());
  return { service, ...mock };
}
export async function operation(service: Service, product: string, method: string, path: string): Promise<RecordValue> {
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const result = await service.call('discover', { product, kind: 'operations', offset, limit: 100 });
    const match = items(result.items).find(item => string(item.method).toUpperCase() === method && item.path === path);
    if (match) return match;
    if (result.eof === true) break;
    assert.equal(typeof result.nextOffset, 'number', 'catalog must expose progress');
    assert.ok(Number(result.nextOffset) > offset);
    offset = Number(result.nextOffset);
  }
  assert.fail(`Bundled catalog must contain ${product} ${method} ${path}`);
}
export async function stitch(service: Service, handle: string, pointer?: string, length = 137): Promise<string> {
  let offset = 0;
  let text = '';
  for (let page = 0; page < 10000; page++) {
    const result = await service.call('read', { handle, mode: 'raw', ...(pointer === undefined ? {} : { pointer }), offset, length });
    assert.equal(result.offset, offset);
    const part = string(result.text);
    assert.ok(part.length <= length, 'range must obey the requested UTF16 budget');
    text += part;
    if (result.eof === true) {
      assert.equal(text.length, result.totalLength);
      return text;
    }
    assert.equal(result.nextOffset, offset + part.length);
    assert.ok(part.length > 0, 'non-final range must progress');
    offset = Number(result.nextOffset);
  }
  assert.fail('read did not reach EOF');
}
export const issue = {
  expand: 'renderedFields', id: '10001', key: 'TEST-1', self: `${DUMMY.ATLASSIAN_BASE_URL}/rest/api/3/issue/10001`,
  fields: { summary: 'Fixture issue', status: { id: '1', name: 'Open' },
    description: { version: 1, type: 'doc', content: [{ type: 'unknownFutureNode', attrs: { private: 'UNPROJECTED_ADF_SENTINEL' }, content: [{ type: 'text', text: 'Hello 😀\r\n世界' }] }] },
    customfield_12345: { unknown: ['KEEP_UNKNOWN_SENTINEL'] } },
  future: { nested: true },
};
export const storage = '<h1>😀 Heading</h1>\r\n<p>' + 'long 😀 世界 '.repeat(2300) + '</p><ac:structured-macro ac:name="unknown"><ac:plain-text-body><![CDATA[MACRO_SOURCE_SENTINEL]]></ac:plain-text-body></ac:structured-macro><h2>Second &amp; final</h2>';
export const page = {
  id: '20001', status: 'current', title: 'Fixture page', spaceId: '30001',
  version: { number: 7, message: 'fixture', minorEdit: false },
  body: { storage: { representation: 'storage', value: storage }, atlas_doc_format: { representation: 'atlas_doc_format', value: '{"type":"doc","future":"KEEP_ADF"}' } },
  _links: { webui: '/spaces/TEST/pages/20001', base: DUMMY.ATLASSIAN_BASE_URL },
  future: { preserve: 'UNKNOWN_PAGE_SENTINEL' },
};
