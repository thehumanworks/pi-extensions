import assert from 'node:assert/strict';
import test from 'node:test';
import { DefaultChatTransport, readUIMessageStream } from 'ai';
import { connectBotBackend, createBotChatAdapter, type BotUIMessage } from '../src/index.js';
import { assistant, baseRun, eventually, session, user } from './fixtures.js';

test('AI SDK 7 DefaultChatTransport consumes remote NDJSON -> adapter SSE and complete replay without another submit', async () => {
  const canonical = [user(1, 'hello'), assistant(2, 'deterministic answer')];
  const record = baseRun({ status: 'completed', output: 'deterministic answer' });
  let submits = 0; let observers = 0; let cancellations = 0;
  const backendFetch: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer server-only-secret');
    const path = new URL(String(input)).pathname;
    if (path === '/v1/runs' && init?.method === 'POST') {
      submits++; assert.deepEqual(JSON.parse(String(init.body)), { message: 'hello', requestId: JSON.parse(String(init.body)).requestId });
      return Response.json(record, { status: 202 });
    }
    if (path === '/v1/runs/run-1') return Response.json(record);
    if (path.endsWith('/cancel')) { cancellations++; return Response.json({ ok: true }); }
    if (path === '/v1/sessions') return Response.json([session]);
    if (path === '/v1/sessions/session-1/stream') {
      observers++;
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          const line = JSON.stringify({ type: 'snapshot', sessionId: 'session-1', data: { entries: canonical } }) + '\n';
          // Deliberately split the transport's NDJSON event independently of UI chunk boundaries.
          const bytes = new TextEncoder().encode(line); c.enqueue(bytes.slice(0, 17)); c.enqueue(bytes.slice(17));
        },
        cancel() { observers--; },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    throw new Error('Unexpected route');
  };
  const adapter = createBotChatAdapter({ backend: connectBotBackend('http://daemon.test', { token: 'server-only-secret', fetch: backendFetch }) });
  const browserFetch: typeof fetch = async (input, init) => {
    const request = new Request(String(input), init);
    if (request.method === 'POST') return adapter.chat(request);
    const url = new URL(request.url);
    return adapter.resume(request, url.searchParams.get('sessionId')!, url.searchParams.get('runId')!);
  };
  const transport = new DefaultChatTransport<BotUIMessage>({
    api: 'http://ui.test/api/chat', fetch: browserFetch, resumeStreamIsReplay: true,
    prepareReconnectToStreamRequest: () => ({ api: 'http://ui.test/api/chat?sessionId=session-1&runId=run-1' }),
  });
  const source = await transport.sendMessages({ chatId: 'chat-1', trigger: 'submit-message', messageId: undefined, abortSignal: undefined,
    messages: [{ id: 'ui-user-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] });
  let first: BotUIMessage | undefined;
  for await (const value of readUIMessageStream<BotUIMessage>({ stream: source, terminateOnError: true })) first = structuredClone(value);
  assert.equal(first!.parts.filter(p => p.type === 'text').map(p => p.text).join(''), 'deterministic answer');
  const history = await adapter.history('session-1'); assert.equal(history.messages.at(-1)!.id, first!.id);
  const replay = await transport.reconnectToStream({ chatId: 'chat-1' }); assert.ok(replay);
  let second: BotUIMessage | undefined;
  for await (const value of readUIMessageStream<BotUIMessage>({ stream: replay, terminateOnError: true })) second = structuredClone(value);
  assert.equal(second!.id, first!.id); assert.deepEqual(second!.parts, first!.parts);
  assert.equal(submits, 1); assert.equal(cancellations, 0); await eventually(() => observers === 0);
});
