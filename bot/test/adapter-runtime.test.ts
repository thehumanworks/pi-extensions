import assert from 'node:assert/strict';
import test from 'node:test';
import { DefaultChatTransport, readUIMessageStream, type UIMessageChunk } from 'ai';
import { connectBotBackend, createBotChatAdapter, type BotChatAdapter, type BotRunData, type BotUIMessage } from '@nothumanwork/bot-ai-sdk';
import { startScriptedBackend } from './scripted-backend.ts';

function transport(adapter: BotChatAdapter, sessionId?: string) {
  return new DefaultChatTransport<BotUIMessage>({
    api: 'http://app.test/api/chat',
    fetch: (url, init) => adapter.chat(new Request(String(url), init)),
    prepareSendMessagesRequest: options => ({ body: { id: options.id, messages: options.messages, sessionId } }),
  });
}
async function send(adapter: BotChatAdapter, text: string, sessionId?: string) {
  return transport(adapter, sessionId).sendMessages({ trigger: 'submit-message', chatId: 'integration-chat', messageId: undefined, abortSignal: undefined,
    messages: [{ id: 'integration-user', role: 'user', parts: [{ type: 'text', text }] }] });
}
async function collect(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  let message: BotUIMessage | undefined;
  for await (const next of readUIMessageStream<BotUIMessage>({
    stream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }),
    terminateOnError: true,
  })) message = next;
  const run = chunks.findLast(chunk => chunk.type === 'data-bot-run') as { data: BotRunData } | undefined;
  return { chunks, message, run: run?.data };
}

test('actual HTTP bot + AI SDK transport: tools, canonical IDs, idempotent retry and public handle injection', { timeout: 20_000 }, async t => {
  const fixture = await startScriptedBackend(); t.after(() => fixture.close());
  const backend = connectBotBackend(fixture.url, { token: fixture.token });
  const adapter = createBotChatAdapter({ backend });
  const output = await collect(await send(adapter, 'Use the echo tool.'));
  assert.equal(output.run?.status, 'completed');
  assert.ok(output.message);
  assert.ok(output.message.parts.some(part => part.type === 'text' && part.text.includes('Adapter verified.')));
  assert.ok(output.message.parts.some(part => part.type === 'data-bot-tool' && part.data.toolName === 'echo' && part.data.state === 'completed'));
  assert.ok(!JSON.stringify(output).includes(fixture.token));
  const sessionId = output.run!.sessionId;
  const history = await adapter.history(sessionId);
  assert.equal(history.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(history.messages.findLast(message => message.role === 'assistant')?.id, output.message.id);
  const retry = await collect(await send(adapter, 'Use the echo tool.'));
  assert.equal(retry.run?.runId, output.run!.runId);
  assert.equal((await fixture.bot.listSessions()).length, 1);
  assert.equal((await adapter.history(sessionId)).messages.filter(message => message.role === 'user').length, 1);
  await assert.rejects(send(adapter, 'A conflicting edit.'), /conflict/i);
  // Durable retries are identical before/after losing the server's correlation cache.
  const cold = createBotChatAdapter({ backend });
  const recovered = await collect(await send(cold, 'Use the echo tool.'));
  assert.equal(recovered.run?.runId, output.run!.runId);
  for (const instance of [adapter, cold]) await assert.rejects(send(instance, 'Use the echo tool.', sessionId), /conflict/i);
  assert.equal((await fixture.bot.listSessions()).length, 1);
  // This assignment is deliberately checked by TypeScript: no private runtime API is needed.
  const injected = createBotChatAdapter({ backend: fixture.bot });
  assert.equal((await injected.info()).name, 'Workspace test bot');
  assert.equal((await injected.history(sessionId)).messages.length, history.messages.length);
});

test('actual HTTP bot: disconnect only detaches, resume never submits, explicit cancellation stops the same run', { timeout: 20_000 }, async t => {
  const fixture = await startScriptedBackend(); t.after(() => fixture.close());
  const adapter = createBotChatAdapter({ backend: connectBotBackend(fixture.url, { token: fixture.token }) });
  const stream = await send(adapter, 'A slow response.');
  const reader = stream.getReader();
  let accepted: BotRunData | undefined;
  let sawText = false;
  while (!accepted || !sawText) {
    const item = await reader.read(); assert.equal(item.done, false);
    if (item.value.type === 'data-bot-run') accepted = item.value.data as BotRunData;
    if (item.value.type === 'text-delta') sawText = true;
  }
  await reader.cancel(); reader.releaseLock();
  assert.ok(accepted);
  assert.notEqual((await fixture.bot.getRun(accepted.runId)).status, 'cancelled');
  const response = await adapter.resume(new Request('http://app.test/api/chat'), accepted.sessionId, accepted.runId);
  assert.equal(response.status, 200);
  const resumed = new DefaultChatTransport<BotUIMessage>({ api: 'http://app.test/api/chat', fetch: async () => response });
  const resumedStream = await resumed.reconnectToStream({ chatId: 'reconnection' });
  assert.ok(resumedStream);
  const result = collect(resumedStream);
  await adapter.cancel(accepted.runId);
  const cancelled = await result;
  assert.equal(cancelled.run?.runId, accepted.runId);
  assert.equal(cancelled.run?.status, 'cancelled');
  assert.ok(cancelled.chunks.some(chunk => chunk.type === 'abort'));
  assert.equal((await fixture.bot.listSessions()).length, 1);
  assert.equal((await fixture.bot.getRun(accepted.runId)).status, 'cancelled');
  assert.equal((await adapter.history(accepted.sessionId)).messages.filter(message => message.role === 'user').length, 1);
});
