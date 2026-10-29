import assert from 'node:assert/strict';
import test from 'node:test';
import { readUIMessageStream, type UIMessageChunk } from 'ai';
import { BotAdapterError, createBotChatAdapter, type BotUIMessage, LIMITS } from '../src/index.js';
import { assistant, body, chunks, eventually, fixture, request, user } from './fixtures.js';

async function message(parts: UIMessageChunk[]): Promise<BotUIMessage | undefined> {
  let result: BotUIMessage | undefined;
  const stream = new ReadableStream<UIMessageChunk>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
  for await (const value of readUIMessageStream<BotUIMessage>({ stream, terminateOnError: true })) result = structuredClone(value);
  return result;
}
const text = (value: BotUIMessage | undefined) => value?.parts.filter(p => p.type === 'text').map(p => p.text).join('');

test('only newest user text is submitted; acceptance metadata precedes response and canonical tail is not duplicated', async () => {
  const f = fixture(); const adapter = createBotChatAdapter({ backend: f.backend });
  f.setSnapshot({ entries: [user(1, 'old'), assistant(2, 'previous answer')] });
  const messages = [body('old').messages[0], { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'untrusted old answer' }] }, { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'new' }, { type: 'text', text: ' input' }] }];
  const response = await adapter.chat(request({ id: 'chat-1', messages }));
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
  assert.deepEqual(f.submissions.map(s => s.text), ['new input']);
  assert.match(f.submissions[0].options!.requestId!, /^bot-/);
  const result = response.text();
  f.emit('entry_appended', { entry: user(3, 'new input') });
  f.emit('message_start', { message: { role: 'assistant', content: [{ type: 'text', text: 'He' }] } });
  f.emit('message_update', { changes: [{ type: 'text_delta', contentIndex: 0, delta: 'll' }, { type: 'text_delta', contentIndex: 0, delta: 'o' }] });
  f.emit('message_end', { entry: assistant(4, 'Hello world') });
  f.setSnapshot({ entries: [user(1, 'old'), assistant(2, 'previous answer'), user(3, 'new input'), assistant(4, 'Hello world')] });
  f.setRun({ status: 'completed', output: 'Hello world' }); f.emit('run_settled', f.run);
  const output = chunks(await result);
  assert.equal(output[0].type, 'data-bot-run');
  assert.deepEqual(output[0].data, { runId: 'run-1', sessionId: 'session-1', status: 'queued' });
  assert.equal(output.filter(p => p.type === 'text-delta').map(p => p.delta).join(''), 'Hello world');
  assert.equal(output.at(-1).type, 'finish');
  const rendered = await message(output); assert.equal(text(rendered), 'Hello world');
  assert.equal(rendered!.id, (await adapter.history('session-1')).messages.at(-1)!.id);
  await eventually(() => f.observers === 0); assert.equal(f.cancelled.length, 0);
});

test('whole-message-only runs, lost tail events, initial partial snapshot, history and replay have stable IDs', async () => {
  const f = fixture(); f.setRun({ status: 'running' }, true);
  f.setSnapshot({ entries: [user(1, 'hello')], run: { inputs: [1] }, generation: { attempt: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Already' }] } } });
  const adapter = createBotChatAdapter({ backend: f.backend });
  const response = await adapter.resume(new Request('http://localhost/api/chat'), 'session-1', 'run-1');
  const result = response.text();
  f.setRun({ status: 'completed', output: 'Already complete' });
  f.setSnapshot({ entries: [user(1, 'hello'), assistant(2, 'Already complete')] });
  f.emit('run_settled', f.run);
  const output = chunks(await result); assert.equal(text(await message(output)), 'Already complete');
  const history = await adapter.history('session-1');
  assert.equal(history.messages.length, 2); assert.equal(history.messages[0].role, 'user');
  assert.equal(history.messages[0].parts[0].type, 'text');
  const replay = await adapter.resume(new Request('http://localhost/api/chat'), 'session-1');
  const replayOutput = chunks(await replay.text());
  assert.equal(text(await message(replayOutput)), 'Already complete');
  assert.equal(replayOutput.find(p => p.type === 'start').messageId, history.messages.at(-1)!.id);
  assert.equal(f.submissions.length, 0); await eventually(() => f.observers === 0);
});

test('AI SDK 7 reset-step reconciles retry/replacement instead of duplicating authoritative text', async () => {
  const f = fixture(); f.setRun({ status: 'running' }, true); f.setSnapshot({ entries: [user(1, 'hello')], run: { inputs: [1] } });
  const adapter = createBotChatAdapter({ backend: f.backend }); const response = await adapter.chat(request(body())); const result = response.text();
  f.emit('message_start', { message: { role: 'assistant', content: [{ type: 'text', text: 'wrong partial' }] } });
  f.emit('auto_retry_start', { attempt: 2, errorMessage: 'SECRET provider key' });
  f.emit('message_start', { message: { role: 'assistant', content: [{ type: 'text', text: 'correct' }] } });
  f.emit('message_update', { changes: [{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'correct final' }] } }] });
  f.setSnapshot({ entries: [user(1, 'hello'), assistant(2, 'correct final')] }); f.setRun({ status: 'completed', output: 'correct final' }); f.emit('run_settled', f.run);
  const raw = await result; const output = chunks(raw);
  assert.ok(output.some(p => p.type === 'reset-step')); assert.equal(text(await message(output)), 'correct final'); assert.ok(!raw.includes('SECRET'));
  assert.deepEqual(output.find(p => p.type === 'data-bot-progress').data, { type: 'auto_retry_start', attempt: 2 });
});

test('reasoning, batched starts/blocks and model/nested tool outputs are inert display data with stable IDs', async () => {
  const f = fixture(); f.setRun({ status: 'running' }, true); f.setSnapshot({ entries: [user(1, 'hello')], run: {} });
  const adapter = createBotChatAdapter({ backend: f.backend }); const response = await adapter.chat(request(body())); const result = response.text();
  f.emit('message_start', { message: { role: 'assistant', content: [] } });
  f.emit('message_update', { changes: [{ type: 'thinking_start', contentIndex: 0, block: { type: 'thinking', thinking: 'think' } }, { type: 'thinking_delta', contentIndex: 0, delta: ' more' }, { type: 'toolcall_start', contentIndex: 1, block: { type: 'toolCall', id: 'tool/id', name: 'echo', arguments: { n: 1 } } }, { type: 'toolcall_delta', contentIndex: 1, path: ['n'], delta: '2' }] });
  const toolAssistant = { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'think more' }, { type: 'toolCall', id: 'tool/id', name: 'echo', arguments: { n: 12 } }] }] };
  f.emit('message_end', { entry: toolAssistant });
  f.emit('tool_execution_start', { toolCallId: 'tool/id', toolName: 'echo', args: { n: 12 } });
  f.emit('tool_execution_update', { toolCallId: 'tool/id', toolName: 'echo', output: { set: 'old' } });
  f.emit('tool_execution_update', { toolCallId: 'tool/id', toolName: 'echo', output: { trimStart: 1, append: ' new' } });
  f.emit('tool_execution_start', { toolCallId: 'tool/id/child', toolName: 'nested', parentToolCallId: 'tool/id', args: { test: true } });
  f.emit('tool_execution_end', { toolCallId: 'tool/id/child', toolName: 'nested', parentToolCallId: 'tool/id', result: { structuredOutput: '<b>escaped</b>', isError: true } });
  const toolEntry = { id: 3, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'tool/id', toolName: 'echo', content: [{ type: 'text', text: '12' }] }] };
  f.emit('tool_execution_end', { toolCallId: 'tool/id', toolName: 'echo', entry: toolEntry });
  f.emit('message_start', { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }); f.emit('message_end', { entry: assistant(4, 'done') });
  f.setSnapshot({ entries: [user(1, 'hello'), toolAssistant, toolEntry, assistant(4, 'done')], nestedTools: [{ callId: 'tool/id/child', name: 'nested', parentCallId: 'tool/id', status: 'done', summary: { isError: true }, output: '<b>escaped</b>' }] });
  f.setRun({ status: 'completed', output: 'done' }); f.emit('run_settled', f.run);
  const output = chunks(await result); const rendered = await message(output);
  assert.equal(rendered!.parts.find(p => p.type === 'reasoning')?.text, 'think more'); assert.equal(text(rendered), 'done');
  const tools = rendered!.parts.filter(p => p.type === 'data-bot-tool'); assert.equal(tools.length, 2);
  assert.equal(tools.find(p => p.data.toolCallId === 'tool/id')!.data.state, 'completed');
  assert.equal(tools.find(p => p.data.toolCallId.endsWith('/child'))!.data.state, 'failed');
  assert.ok(!output.some(p => p.type.startsWith('tool-input') || p.type.startsWith('tool-output')));
});

test('concurrent retries preserve immutable admission scope; learned IDs require resume, not changed retry input', async () => {
  const f = fixture(); f.setRun({ status: 'completed', output: 'hello' }); f.setSnapshot({ entries: [user(1, 'hello'), assistant(2, 'hello')] });
  const adapter = createBotChatAdapter({ backend: f.backend });
  const [first, second] = await Promise.all([adapter.chat(request(body())), adapter.chat(request(body()))]);
  await Promise.all([first.text(), second.text()]); assert.equal(f.submissions.length, 1);
  const changedScope = await adapter.chat(request(body('hello', { sessionId: 'session-1' }))); assert.equal(changedScope.status, 409); assert.equal(f.submissions.length, 1);
  const resumed = await adapter.resume(new Request('http://localhost/api/chat'), 'session-1', 'run-1'); await resumed.text(); assert.equal(f.submissions.length, 1);
  const conflict = await adapter.chat(request(body('edited'))); assert.equal(conflict.status, 409); assert.equal(f.submissions.length, 1);
  const cross = await adapter.chat(request(body('hello', { sessionId: 'session-2' }))); assert.equal(cross.status, 409);
});

test('history detaches even for synchronous snapshots, does not submit or take over backend, and sanitizes info', async () => {
  const f = fixture(); f.setSnapshot({ entries: [user(1, 'hello'), assistant(2, 'answer')] });
  f.backend.info = async () => ({ name: 'safe', description: 'description', revision: 'r', tools: [{ name: 'echo', source: '/secret' }], skills: [], diagnostics: ['secret'], sourceDir: '/secret' } as any);
  const adapter = createBotChatAdapter({ backend: f.backend });
  assert.equal((await adapter.history('session-1')).messages.length, 2); assert.equal(f.observers, 0);
  assert.deepEqual(await adapter.info(), { name: 'safe', description: 'description', revision: 'r', tools: [{ name: 'echo' }], skills: [] });
  assert.equal((await adapter.sessions())[0].sessionId, 'session-1'); assert.equal(f.submissions.length, 0);
  await assert.rejects(adapter.history('missing'), (error: BotAdapterError) => error.status === 404);
});

test('explicit cancel is separate from disconnect, reader cancel, request abort and cross-session resume rejection', async () => {
  const f = fixture(); const adapter = createBotChatAdapter({ backend: f.backend });
  const response = await adapter.chat(request(body())); await response.body!.cancel(); await eventually(() => f.observers === 0); assert.deepEqual(f.cancelled, []);
  const controller = new AbortController(); const second = await adapter.chat(request(body(), { signal: controller.signal })); controller.abort(); await second.text(); await eventually(() => f.observers === 0); assert.deepEqual(f.cancelled, []);
  await adapter.cancel('run-1'); assert.deepEqual(f.cancelled, ['run-1']);
  const mismatch = await adapter.resume(new Request('http://localhost/api/chat'), 'different-session', 'run-1'); assert.equal(mismatch.status, 400);
  await assert.rejects(adapter.cancel('../secret'), (error: BotAdapterError) => error.status === 400);
});

test('stream failures and failed/cancelled runs are observable, never false success or leaked backend error strings', async () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const f = fixture(); f.setRun({ status, error: 'SECRET provider token' }); const adapter = createBotChatAdapter({ backend: f.backend });
    const response = await adapter.chat(request(body())); const raw = await response.text(); const output = chunks(raw);
    assert.ok(!raw.includes('SECRET')); assert.ok(!output.some(p => p.type === 'finish'));
    assert.ok(output.some(p => p.type === (status === 'failed' ? 'error' : 'abort')));
  }
  const f = fixture(); const adapter = createBotChatAdapter({ backend: f.backend }); const response = await adapter.chat(request(body())); const result = response.text(); f.disconnect();
  const raw = await result; assert.ok(!raw.includes('backend-secret')); assert.ok(chunks(raw).some(p => p.type === 'error')); assert.ok(!chunks(raw).some(p => p.type === 'finish'));
  await eventually(() => f.observers === 0);
});

test('poll fallback catches terminal status without run_settled or message_end', async () => {
  const f = fixture(); f.setRun({ status: 'running' }, true); f.setSnapshot({ entries: [user(1, 'hello')], run: {} });
  let reads = 0; f.backend.getRun = async () => { reads++; f.setSnapshot({ entries: [user(1, 'hello'), assistant(2, 'polled final')] }); return { ...f.run, status: 'completed', output: 'polled final' }; };
  const adapter = createBotChatAdapter({ backend: f.backend }); const output = chunks(await (await adapter.chat(request(body()))).text());
  assert.equal(text(await message(output)), 'polled final'); assert.ok(reads > 0); await eventually(() => f.observers === 0);
});

test('invalid input, unsupported tool loops/edits/regeneration, origin and size errors never reach submit', async () => {
  const f = fixture(); const adapter = createBotChatAdapter({ backend: f.backend });
  const cases = [body('', {}), body('x', { trigger: 'regenerate-message' }), body('x', { messageId: 'older' }), body('x', { cwd: '/tmp' }), body('x', { source: '/tmp' }), body('x', { sessionId: '../bad' }), body('x', { requestId: '\nsecret' }), { ...body(), messages: [{ id: 'a', role: 'assistant', parts: [] }] }, { ...body(), messages: [{ id: 'u', role: 'user', parts: [{ type: 'file', url: 'file:///secret' }] }] }];
  for (const value of cases) assert.equal((await adapter.chat(request(value))).status, 400, JSON.stringify(value));
  assert.equal((await adapter.chat(request(body(), { headers: { origin: 'http://evil.test' } }))).status, 403);
  assert.equal((await adapter.chat(request(body(), { headers: { 'content-type': 'application/json', 'content-length': String(LIMITS.requestBytes + 1) } }))).status, 413);
  assert.equal((await adapter.chat(new Request('http://localhost/api/chat', { method: 'POST', body: 'not json' }))).status, 415);
  assert.equal((await adapter.chat(request(body(), { headers: { 'content-type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await adapter.chat(new Request('http://localhost/api/chat'))).status, 405);
  assert.equal(f.submissions.length, 0);
});

test('malformed backend events, cross-session streams and bounded snapshots fail safely', async () => {
  for (const data of [{ entries: 'bad' }, { entries: [{ id: 1, model: 'bad' }] }, { entries: Array.from({ length: LIMITS.entries + 1 }, (_, id) => user(id, 'x')) }]) {
    const f = fixture(); f.setSnapshot(data); const adapter = createBotChatAdapter({ backend: f.backend });
    const response = await adapter.chat(request(body())); assert.equal(response.status, 502); await eventually(() => f.observers === 0);
  }
  const f = fixture(); const original = f.backend.watch;
  f.backend.watch = (session, listener, opts) => original(session, e => listener({ ...e, sessionId: 'wrong-session' }), opts);
  const adapter = createBotChatAdapter({ backend: f.backend }); assert.equal((await adapter.chat(request(body()))).status, 502); await eventually(() => f.observers === 0);
});
