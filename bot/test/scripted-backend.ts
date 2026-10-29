import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openBot, type BotHandle } from '@nothumanwork/bot';
import { serve } from '@nothumanwork/bot/server';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

/** A real SQLite-backed runtime and HTTP server, with deterministic model output. */
export async function startScriptedBackend() {
  const directory = await mkdtemp(join(tmpdir(), 'bot-web-e2e-'));
  const source = join(directory, 'source');
  const workspace = join(directory, 'workspace');
  const agentDir = join(directory, 'agent');
  await Promise.all([mkdir(join(source, 'tools'), { recursive: true }), mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(source, 'BOT.md'), `---
format: 2
name: Workspace test bot
description: Deterministic browser integration fixture
model: faux/faux-1
tools: [echo]
skills: []
maintenance: false
---
A local test bot. Never call a real model.
`);
  await writeFile(join(source, 'tools/echo.ts'), `export default {
    name: 'echo', description: 'Echo a value for integration verification',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    replay: 'safe',
    async execute(args) {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { content: [{ type: 'text', text: 'Echo result: ' + args.text }] };
    }
  };`);
  const faux = fauxProvider({ tokensPerSecond: 160 });
  const models = createModels(); models.setProvider(faux.provider);
  // Every model call is computed from its committed conversation, not global call order.
  faux.setResponses(Array.from({ length: 100 }, () => context => {
    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') return fauxAssistantMessage('The echo tool completed successfully. **Adapter verified.**');
    const user = [...context.messages].reverse().find(message => message.role === 'user');
    const text = user && typeof user.content === 'string' ? user.content : user && Array.isArray(user.content)
      ? user.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
    if (/slow|long/i.test(text)) return fauxAssistantMessage('Long-running response. ' + 'durable streaming progress '.repeat(1000));
    if (/echo|tool/i.test(text)) return fauxAssistantMessage(fauxToolCall('echo', { text: 'adapter works' }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(`Received: ${text}\n\nThis response came through the **local durable runtime**.`);
  }));
  let bot: BotHandle | undefined;
  try {
    bot = await openBot(source, { models, cwd: workspace, agentDir });
    const token = `private-backend-${randomUUID()}`;
    const server = await serve(source, { bot, host: '::1', port: 0, authToken: token });
    return {
      url: server.url,
      token,
      bot,
      directory,
      async close() {
        try { await server.close(); } finally {
          try { await bot?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
        }
      },
    };
  } catch (error) {
    await bot?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
