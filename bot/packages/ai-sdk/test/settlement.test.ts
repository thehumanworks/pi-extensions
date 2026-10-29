import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotChatAdapter, type BotRun } from '../src/index.js';
import { assistant, body, chunks, eventually, fixture, request, user } from './fixtures.js';

test('in-flight polls cannot regress or override authoritative terminal settlement, including stale failures', async () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const pollFails of [false, true]) {
      const f = fixture();
      f.setRun({ status: 'running' }, true);
      f.setSnapshot({ entries: [user(1, 'hello')], run: {} });
      const stale = structuredClone(f.run);
      let resolve!: (run: BotRun) => void;
      let reject!: (error: Error) => void;
      f.backend.getRun = async () => await new Promise<BotRun>((yes, no) => { resolve = yes; reject = no; });
      const response = await createBotChatAdapter({ backend: f.backend }).chat(request(body()));
      await eventually(() => !!resolve);
      const result = response.text();
      f.setSnapshot({ entries: [user(1, 'hello'), assistant(2, 'terminal answer')] });
      f.setRun({ status, output: 'terminal answer' });
      f.emit('run_settled', f.run);
      if (pollFails) reject(new Error('STALE_PRIVATE_ERROR'));
      else resolve(stale);
      const raw = await result;
      const output = chunks(raw);
      const statuses = output.filter(part => part.type === 'data-bot-run').map(part => part.data.status);
      assert.equal(statuses.at(-1), status, `${status}: stale poll regressed status`);
      assert.equal(output.some(part => part.type === 'finish'), status === 'completed');
      assert.equal(output.some(part => part.type === 'error'), status === 'failed');
      assert.equal(output.some(part => part.type === 'abort'), status === 'cancelled');
      assert.ok(!raw.includes('STALE_PRIVATE_ERROR'));
      await eventually(() => f.observers === 0);
    }
  }
});
