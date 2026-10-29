import assert from 'node:assert/strict';
import test from 'node:test';
import { botSnapshotToUIMessages } from '../src/index.js';
import { Transcript } from '../src/transcript.js';
import { baseRun, user } from './fixtures.js';

// Both executors expose the same public bot contract, not private durable slots.
test('normalized snapshots restore running, completed and failed nested tool activity', () => {
  const messages = botSnapshotToUIMessages({ type: 'snapshot', sessionId: 'session-1', data: {
    entries: [user(1, 'Check the tools')],
    tools: [
      { toolCallId: 'running', toolName: 'read', status: 'running', args: { path: 'notes.md' }, summary: 'Reading header' },
      { toolCallId: 'done', toolName: 'echo', status: 'completed', summary: 'Echo complete' },
      { toolCallId: 'running/child', toolName: 'nested', parentToolCallId: 'running', status: 'failed', summary: 'Permission denied' },
    ],
  } });
  const tools = messages.at(-1)!.parts.filter(part => part.type === 'data-bot-tool').map(part => part.data);
  assert.deepEqual(tools, [
    { toolCallId: 'running', toolName: 'read', state: 'running', input: { path: 'notes.md' }, output: 'Reading header' },
    { toolCallId: 'done', toolName: 'echo', state: 'completed', output: 'Echo complete' },
    { toolCallId: 'running/child', toolName: 'nested', state: 'failed', output: 'Permission denied', parentToolCallId: 'running' },
  ]);
});

test('normalized tool summaries update live output and settle without requiring a transcript entry', () => {
  const transcript = new Transcript('session-1');
  transcript.apply({ type: 'tool_execution_start', data: { toolCallId: 'tool', toolName: 'read', args: { path: 'notes.md' } } });
  transcript.apply({ type: 'tool_execution_update', data: { toolCallId: 'tool', toolName: 'read', summary: 'First line' } });
  transcript.apply({ type: 'tool_execution_update', data: { toolCallId: 'tool', toolName: 'read', summary: 'Second line' } });
  const tool = () => transcript.latest()!.message.parts.find(part => part.type === 'data-bot-tool')!;
  assert.equal(tool().data.output, 'Second line');
  transcript.apply({ type: 'tool_execution_end', data: { toolCallId: 'tool', toolName: 'read', isError: false, summary: 'Read complete' } });
  assert.equal(tool().data.state, 'completed');
  assert.equal(tool().data.output, 'Read complete');
  transcript.apply({ type: 'tool_execution_end', data: { toolCallId: 'tool', toolName: 'read', isError: true, summary: 'Read failed' } });
  assert.equal(tool().data.state, 'failed');
  assert.equal(tool().data.output, 'Read failed');
});

test('a terminal run in a normalized snapshot is idle, while accepted queued work is busy', () => {
  const transcript = new Transcript('session-1');
  for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled'] as const) {
    transcript.apply({ type: 'snapshot', sessionId: 'session-1', runId: 'run-1', data: {
      entries: [], tools: [], run: baseRun({ status }),
    } });
    assert.equal(transcript.busy, status === 'queued' || status === 'running');
  }
});
