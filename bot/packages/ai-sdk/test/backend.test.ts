import assert from 'node:assert/strict';
import test from 'node:test';
import { BotAdapterError, LIMITS, connectBotBackend, type BotEvent } from '../src/index.js';
import { baseRun, eventually, session } from './fixtures.js';

const ndjson = (lines: unknown[]) => new Response(lines.map(value => JSON.stringify(value)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
const fetcher = (callback: (url: string, init: RequestInit) => Response | Promise<Response>) => (async (url, init) => callback(String(url), init ?? {})) as typeof fetch;

test('HTTP client calls only existing v1 endpoints, URL encodes IDs and keeps bearer token server-side', async () => {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const backend = connectBotBackend('http://[::1]:8787/', { token: 'SECRET', fetch: fetcher((url, init) => {
    const path = new URL(url).pathname; assert.equal(new Headers(init.headers).get('authorization'), 'Bearer SECRET'); assert.equal(init.redirect, 'error');
    calls.push({ path, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/v1/info') return Response.json({ name: 'test', description: '', revision: 'r', tools: [], skills: [], sourceDir: '/secret' });
    if (path === '/v1/sessions') return Response.json([session]);
    if (path.endsWith('/cancel')) return Response.json({ ok: true });
    return Response.json(baseRun());
  }) });
  assert.equal((await backend.info()).name, 'test'); assert.equal((await backend.listSessions()).length, 1);
  await backend.submit('hello', { requestId: 'req-1', session: 'session-1' }); await backend.getRun('run-1'); await backend.cancel('run-1');
  assert.deepEqual(calls.map(c => c.path), ['/v1/info', '/v1/sessions', '/v1/runs', '/v1/runs/run-1', '/v1/runs/run-1/cancel']);
  assert.deepEqual(calls[2].body, { message: 'hello', session: 'session-1', requestId: 'req-1' });
  assert.equal(calls[2].method, 'POST');
});

test('watch handles split UTF-8, CRLF, blank lines and final unterminated event, and EOF remains observable', async () => {
  const bytes = new TextEncoder().encode('\r\n{"type":"snapshot","sessionId":"session-1","data":{"entries":[],"label":"✓"}}\r\n{"type":"run_end"}');
  const seen: BotEvent[] = []; const errors: Error[] = [];
  const backend = connectBotBackend('http://bot.test', { fetch: fetcher(() => new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } })) });
  const stop = await backend.watch('session-1', e => seen.push(e), { onError: e => errors.push(e) });
  await eventually(() => errors.length === 1); assert.deepEqual(seen.map(e => e.type), ['snapshot', 'run_end']); assert.equal((seen[0].data as any).label, '✓');
  assert.match(errors[0].message, /disconnected/); await stop(); await stop();
});

test('unsubscribe stops an idle read, is idempotent, does not call cancel, and does not report intentional abort', async () => {
  let cancelled = 0; let requests = 0; const errors: Error[] = [];
  const backend = connectBotBackend('http://bot.test', { fetch: fetcher(() => {
    requests++; return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"snapshot","data":{"entries":[]}}\n')); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'application/x-ndjson' } });
  }) });
  const stop = await backend.watch('session-1', () => {}, { onError: e => errors.push(e) }); await stop(); await stop();
  assert.equal(cancelled, 1); assert.equal(requests, 1); assert.equal(errors.length, 0);
});

test('malformed, cross-session, invalid UTF-8 and oversized NDJSON fail safely with no raw contents', async () => {
  const payloads: Array<string | Uint8Array> = ['{"type":', '{"type":4}\n', '{"type":"snapshot","sessionId":"other"}\n', new Uint8Array([0xff]), 'x'.repeat(LIMITS.eventBytes + 1)];
  for (const payload of payloads) {
    const errors: Error[] = []; const backend = connectBotBackend('http://bot.test', { fetch: fetcher(() => new Response(typeof payload === 'string' ? payload : new Uint8Array(payload), { headers: { 'content-type': 'application/x-ndjson' } })) });
    const stop = await backend.watch('session-1', () => {}, { onError: e => errors.push(e) }); await eventually(() => errors.length === 1); await stop();
    assert.ok(errors[0] instanceof BotAdapterError); assert.ok(!errors[0].message.includes('other'));
  }
});

test('run streaming negotiates NDJSON, returns acceptance early, forwards settle and reports premature EOF', async () => {
  for (const settled of [true, false]) {
    const accepted = baseRun(); const final = baseRun({ status: 'completed', output: 'answer' }); const seen: BotEvent[] = [];
    const lines = [{ type: 'run_accepted', runId: accepted.runId, sessionId: accepted.sessionId, data: accepted }, ...(settled ? [{ type: 'run_settled', runId: accepted.runId, sessionId: accepted.sessionId, data: final }] : [])];
    const backend = connectBotBackend('http://bot.test', { fetch: fetcher((_url, init) => { assert.equal(new Headers(init.headers).get('accept'), 'application/x-ndjson'); return ndjson(lines); }) });
    assert.equal((await backend.submit('hello', { onEvent: e => seen.push(e) })).runId, accepted.runId);
    await eventually(() => seen.length === 2); assert.equal(seen[1].type, settled ? 'run_settled' : 'adapter_stream_error');
  }
});

test('HTTP, network and configuration errors do not leak URL, bearer token, response body or exception secrets', async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 500]) {
    const backend = connectBotBackend('http://private-backend.test', { token: 'SECRET', fetch: fetcher(() => Response.json({ error: { code: 'SECRET', message: 'SECRET http://private-backend.test' } }, { status })) });
    await assert.rejects(backend.info(), (error: BotAdapterError) => { assert.ok(!error.message.includes('SECRET')); assert.ok(!error.message.includes('private-backend')); return error.status === (status === 500 ? 503 : status); });
  }
  const backend = connectBotBackend('http://private-backend.test', { fetch: fetcher(() => { throw new Error('SECRET http://private-backend.test'); }) });
  await assert.rejects(backend.info(), (error: Error) => !error.message.includes('SECRET') && !error.message.includes('private-backend'));
  for (const url of ['file:///etc/passwd', 'http://user:SECRET@host', 'http://host/?token=SECRET', 'not a URL']) assert.throws(() => connectBotBackend(url), (error: Error) => !error.message.includes('SECRET'));
  assert.throws(() => connectBotBackend('http://host', { token: 'SECRET\r\nheader' }), /Invalid bot authentication/);
});

test('cancel requires a positive daemon acknowledgement rather than treating any HTTP 200 as durable success', async () => {
  const backend = connectBotBackend('http://bot.test', { fetch: fetcher(() => Response.json({ ok: false, error: 'SECRET' })) });
  await assert.rejects(backend.cancel('run-1'), (error: BotAdapterError) => error.status === 502 && !error.message.includes('SECRET'));
});

test('ordinary HTTP timeout cancels an idle body even with an injected fetch stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let opened = false; let cancelled = 0;
  const backend = connectBotBackend('http://bot.test', { fetch: fetcher(() => {
    opened = true; return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }));
  }) });
  const pending = assert.rejects(backend.info(), (error: BotAdapterError) => error.status === 503 && error.message.includes('timed out'));
  await eventually(() => opened); t.mock.timers.tick(LIMITS.requestTimeoutMs); await pending; assert.equal(cancelled, 1);
});

test('ordinary JSON responses and resource IDs are validated and bounded', async () => {
  for (const value of ['{', 'x'.repeat(LIMITS.responseBytes + 1), JSON.stringify({ runId: 'run-1', sessionId: '../bad', output: '', status: 'queued' })]) {
    const backend = connectBotBackend('http://bot.test', { fetch: fetcher(() => new Response(value)) }); await assert.rejects(backend.getRun('run-1'), BotAdapterError);
  }
  let calls = 0; const backend = connectBotBackend('http://bot.test', { fetch: fetcher(() => { calls++; return Response.json(baseRun()); }) });
  for (const invalid of ['', '..', '../secret', 'bad\\id', 'a\0b', 'new', 'last', 'x'.repeat(257)]) {
    await assert.rejects(backend.getRun(invalid)); await assert.rejects(backend.cancel(invalid)); await assert.rejects(backend.watch(invalid, () => {}));
  }
  await assert.rejects(backend.submit(' ')); await assert.rejects(backend.submit('hello', { requestId: '\n' })); assert.equal(calls, 0);
});
