import assert from 'node:assert/strict';
import test from 'node:test';
import { BotAdapterError, LIMITS, botSnapshotToUIMessages, createBotChatAdapter } from '../src/index.js';
import { assistant, body, chunks, eventually, fixture, request, user } from './fixtures.js';

test('pure canonical snapshot conversion omits compaction prompts, includes partial generation, and remains stable', () => {
  const snapshot = { type: 'snapshot', sessionId: 'session-1', data: { entries: [user(1, 'hello'), assistant(2, 'first'), { id: 3, kind: 'pi.compaction', model: [{ role: 'user', content: 'internal compaction prompt' }] }], generation: { message: { role: 'assistant', content: [{ type: 'text', text: 'next' }, { type: 'thinking', thinking: 'hidden', redacted: true }] } } } };
  const messages = botSnapshotToUIMessages(snapshot);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(messages[1].parts.filter(p => p.type === 'text').map(p => p.text), ['first', 'next']);
  assert.ok(!JSON.stringify(messages).includes('hidden')); assert.ok(!JSON.stringify(messages).includes('compaction'));
  assert.deepEqual(messages, botSnapshotToUIMessages(structuredClone(snapshot)));
  assert.throws(() => botSnapshotToUIMessages({ type: 'snapshot', data: { entries: [] } }), BotAdapterError);
  assert.throws(() => botSnapshotToUIMessages({ type: 'message_start', sessionId: 's' }), /snapshot/);
});

test('queued runs do not replay the preceding assistant when run_start precedes their new user entry', async () => {
  const f = fixture(); f.setSnapshot({ entries: [user(1, 'old'), assistant(2, 'do not repeat me')] });
  const adapter = createBotChatAdapter({ backend: f.backend }); const response = await adapter.chat(request(body('new'))); const result = response.text();
  f.emit('run_start', {});
  f.emit('message_end', { entry: user(3, 'new') }); f.emit('message_end', { entry: assistant(4, 'new reply') });
  f.setSnapshot({ entries: [user(1, 'old'), assistant(2, 'do not repeat me'), user(3, 'new'), assistant(4, 'new reply')] });
  f.setRun({ status: 'completed', output: 'new reply' }); f.emit('run_settled', f.run);
  const output = chunks(await result); assert.equal(output.filter(p => p.type === 'start').length, 1);
  assert.equal(output.filter(p => p.type === 'text-delta').map(p => p.delta).join(''), 'new reply');
});

test('repeated terminal request replays its canonical matching turn, not a later run in the same session', async () => {
  const f = fixture(); f.setRun({ status: 'completed', output: 'first reply' });
  f.setSnapshot({ entries: [user(1, 'first'), assistant(2, 'first reply'), user(3, 'later'), assistant(4, 'prefixfirst reply')] });
  const adapter = createBotChatAdapter({ backend: f.backend }); const result = await adapter.chat(request(body('first')));
  const output = chunks(await result.text()); assert.equal(output.filter(p => p.type === 'text-delta').map(p => p.delta).join(''), 'first reply');
  const expectedId = (await adapter.history('session-1')).messages[1].id;
  assert.equal(output.find(p => p.type === 'start').messageId, expectedId);
});

test('terminal replay uses canonical message timestamps to disambiguate identical answers, otherwise reports uncertainty', async () => {
  for (const timestamps of [true, false]) {
    const f = fixture(); f.setRun({ status: 'completed', output: 'same reply' });
    const earlier = assistant(2, 'same reply'); const later = assistant(4, 'same reply');
    f.setSnapshot({ entries: [user(1, 'first'), { ...earlier, model: [{ ...earlier.model[0], ...(timestamps ? { timestamp: Date.parse('2026-01-01T00:00:00.500Z') } : {}) }] }, user(3, 'later'), { ...later, model: [{ ...later.model[0], ...(timestamps ? { timestamp: Date.parse('2026-01-01T00:00:02Z') } : {}) }] }] });
    const adapter = createBotChatAdapter({ backend: f.backend }); const response = await adapter.resume(new Request('http://localhost/api/chat'), 'session-1', 'run-1');
    const output = chunks(await response.text());
    if (timestamps) assert.equal(output.find(p => p.type === 'start').messageId, (await adapter.history('session-1')).messages[1].id);
    else { assert.ok(output.some(p => p.type === 'error')); assert.ok(!output.some(p => p.type === 'finish' || p.type === 'text-delta')); }
  }
});

test('changed explicit request IDs cannot disguise editing or duplicate the same UI user message', async () => {
  const f = fixture(); f.setRun({ status: 'completed', output: 'reply' }); f.setSnapshot({ entries: [user(1, 'hello'), assistant(2, 'reply')] });
  const adapter = createBotChatAdapter({ backend: f.backend }); await (await adapter.chat(request(body('hello', { requestId: 'first' })))).text();
  await (await adapter.chat(request(body('hello', { requestId: 'second' })))).text();
  assert.equal(f.submissions.length, 1);
  const edit = await adapter.chat(request(body('changed', { requestId: 'third' }))); assert.equal(edit.status, 409); assert.equal(f.submissions.length, 1);
});

test('late events from another run do not contaminate a selected active stream', async () => {
  const f = fixture(); f.setRun({ status: 'running' }, true); f.setSnapshot({ entries: [user(1, 'hello')], run: { ...f.run, status: 'running' } });
  const adapter = createBotChatAdapter({ backend: f.backend }); const response = await adapter.chat(request(body())); const result = response.text();
  f.emit('message_start', { message: { role: 'assistant', content: [{ type: 'text', text: 'wrong other run' }] } }, 'run-2');
  f.emit('message_end', { entry: assistant(2, 'right') }); f.setSnapshot({ entries: [user(1, 'hello'), assistant(2, 'right')] }); f.setRun({ status: 'completed', output: 'right' });
  f.emit('run_settled', f.run);
  const raw = await result; assert.ok(!raw.includes('wrong other run')); assert.ok(raw.includes('right'));
});

test('slow readers are bounded and receive an error, not false success or backend cancellation', async () => {
  const f = fixture(); f.setRun({ status: 'running' }, true); f.setSnapshot({ entries: [user(1, 'hello')], run: { ...f.run, status: 'running' } });
  const adapter = createBotChatAdapter({ backend: f.backend }); const response = await adapter.chat(request(body()));
  f.emit('message_start', { message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(LIMITS.bufferBytes + 65536) }] } });
  const output = chunks(await response.text()); assert.ok(output.some(p => p.type === 'error' && p.errorText.includes('buffer')));
  assert.ok(!output.some(p => p.type === 'finish')); await eventually(() => f.observers === 0); assert.equal(f.cancelled.length, 0);
});

test('bounded snapshot acquisition cleans up a handle arriving after timeout, without cancelling admitted work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let release!: (value: () => Promise<void>) => void; let stopped = 0;
  f.backend.watch = async (_session, listener) => {
    listener({ type: 'snapshot', sessionId: 'session-1', data: { entries: [] } });
    return await new Promise<() => Promise<void>>(resolve => { release = resolve; });
  };
  const pending = createBotChatAdapter({ backend: f.backend }).chat(request(body()));
  await eventually(() => !!release); t.mock.timers.tick(LIMITS.snapshotTimeoutMs);
  const response = await pending; assert.equal(response.status, 503); assert.match(await response.text(), /snapshot timed out/);
  release(async () => { stopped++; }); await eventually(() => stopped === 1); assert.equal(f.cancelled.length, 0);
});

test('structural stream error events and uncorrelated run_end are explicitly observable', async () => {
  for (const type of ['adapter_stream_error', 'stream_error', 'error']) {
    const f = fixture(); const adapter = createBotChatAdapter({ backend: f.backend }); const response = await adapter.chat(request(body())); const result = response.text();
    f.emit(type, { message: 'SECRET' }); const raw = await result;
    assert.ok(!raw.includes('SECRET')); assert.ok(chunks(raw).some(p => p.type === 'error')); assert.ok(!chunks(raw).some(p => p.type === 'finish'));
  }
  const f = fixture(); f.setSnapshot({ entries: [user(1, 'hello')], run: { ...f.run, status: 'running' } });
  const response = await createBotChatAdapter({ backend: f.backend }).resume(new Request('http://localhost/api/chat'), 'session-1'); const result = response.text();
  f.emit('run_end', {}, undefined); assert.ok(chunks(await result).some(p => p.type === 'error'));
});

test('oversized streamed body and malformed part indices fail before unbounded state growth', async () => {
  const f = fixture(); const adapter = createBotChatAdapter({ backend: f.backend });
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(LIMITS.requestBytes + 1)); c.close(); } });
  const streamed = new Request('http://localhost/api/chat', { method: 'POST', body: source, headers: { 'content-type': 'application/json' }, duplex: 'half' } as RequestInit);
  assert.equal((await adapter.chat(streamed)).status, 413); assert.equal(f.submissions.length, 0);
  const response = await adapter.chat(request(body())); const result = response.text();
  f.emit('message_update', { changes: [{ type: 'text_start', contentIndex: 2 ** 32, block: { type: 'text', text: 'SECRET' } }] });
  const raw = await result; assert.ok(!raw.includes('SECRET')); assert.ok(chunks(raw).some(p => p.type === 'error'));
});
