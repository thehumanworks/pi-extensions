import type { BotEvent, BotRun, BotToolData, BotUIMessage } from './types.js';
import { LIMITS, bad, bounded, event as validateEvent, id, invalid, record, stableId } from './safety.js';

type Obj = Record<string, any>;
export interface ProjectedMessage { message: BotUIMessage; keys: string[]; lastAssistantText?: string; timestamp?: number }
const content = (message: Obj): Obj[] => {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  if (!Array.isArray(message.content) || message.content.length > LIMITS.parts) invalid();
  return Array.from(message.content, part => ({ ...record(part) }));
};
const entryKey = (entry: Obj): string => {
  if (!(typeof entry.id === 'string' && entry.id.length <= 256) && !(Number.isSafeInteger(entry.id) && entry.id >= 0)) invalid();
  return String(entry.id);
};
const isUser = (entry: Obj) => entry.kind !== 'pi.compaction' && (entry.model ?? []).some((m: Obj) => m.role === 'user');

/** Canonical display projection. Tool data is inert; raw provider/runtime errors are deliberately omitted. */
export class Transcript {
  private entries: Obj[] = [];
  private generation: Obj | undefined;
  private readonly tools = new Map<string, BotToolData>();
  private readonly toolOwners = new Map<string, string>();
  snapshotRunId: string | undefined;
  busy = false;
  constructor(readonly sessionId: string) {}
  private append(value: unknown): void {
    const entry = record(value); const key = entryKey(entry);
    if (entry.model !== undefined && (!Array.isArray(entry.model) || entry.model.length > LIMITS.parts)) invalid();
    const index = this.entries.findIndex(item => entryKey(item) === key);
    if (index === -1) this.entries.push(entry); else this.entries[index] = entry;
    if (this.entries.length > LIMITS.entries) invalid();
  }
  apply(event: BotEvent): void {
    bounded(event, LIMITS.eventBytes); const data = record(event.data);
    if (event.type === 'snapshot') {
      if (!Array.isArray(data.entries) || data.entries.length > LIMITS.entries) invalid();
      this.entries = []; this.tools.clear(); this.toolOwners.clear();
      for (const entry of data.entries) this.append(entry);
      if (data.generation !== undefined && (!data.generation || typeof data.generation !== 'object' || Array.isArray(data.generation))) invalid();
      this.generation = record(data.generation).message;
      if (this.generation !== undefined && (record(this.generation).role !== 'assistant' || !Array.isArray(record(this.generation).content))) invalid();
      if (data.tools !== undefined && !Array.isArray(data.tools)) invalid();
      this.snapshotRunId = event.runId;
      this.busy = ['queued', 'running'].includes(record(data.run).status) || !!data.generation;
      for (const slot of data.tools ?? []) {
        const s = record(slot);
        if (typeof s.toolCallId !== 'string' || typeof s.toolName !== 'string' || !['running', 'completed', 'failed'].includes(s.status)) invalid();
        if (s.summary !== undefined && typeof s.summary !== 'string') invalid();
        this.tools.set(s.toolCallId, { toolCallId: s.toolCallId, toolName: s.toolName, state: s.status,
          ...(s.args === undefined ? {} : { input: s.args }), ...(s.summary === undefined ? {} : { output: s.summary }),
          ...(typeof s.parentToolCallId === 'string' ? { parentToolCallId: s.parentToolCallId } : {}) });
      }
    } else if (event.type === 'message_start') {
      const message = record(data.message);
      if (!['user', 'assistant', 'system', 'toolResult'].includes(message.role)) invalid();
      if (message.role === 'assistant') this.generation = { ...message, content: content(message) };
    } else if (event.type === 'message_update') {
      if (!Array.isArray(data.changes) || data.changes.length > LIMITS.parts) invalid();
      let current = this.generation ? content(this.generation) : [];
      for (const value of data.changes) {
        const change = record(value);
        if (change.type === 'message') { this.generation = record(change.message); if (this.generation.role !== 'assistant') invalid(); current = content(this.generation); continue; }
        const index = change.contentIndex;
        if (!Number.isSafeInteger(index) || index < 0 || index >= LIMITS.parts) invalid();
        if (['text_start', 'thinking_start', 'toolcall_start', 'block'].includes(change.type)) current[index] = { ...record(change.block) };
        else if (change.type === 'text_delta' || change.type === 'thinking_delta') {
          if (typeof change.delta !== 'string') invalid();
          const key = change.type === 'text_delta' ? 'text' : 'thinking';
          if (!current[index]) current[index] = { type: key === 'text' ? 'text' : 'thinking' };
          current[index][key] = (current[index][key] ?? '') + change.delta;
        }
        // toolcall_delta is a structured argument delta; execution_start or final block is authoritative.
      }
      this.generation = { ...(this.generation ?? {}), role: 'assistant', content: current };
    } else if (event.type === 'message_end') {
      this.append(data.entry);
      if ((record(data.entry).model ?? []).some((m: Obj) => m.role === 'assistant')) this.generation = undefined;
    } else if (event.type.startsWith('tool_execution_')) {
      if (typeof data.toolCallId !== 'string' || typeof data.toolName !== 'string') invalid();
      const previous = this.tools.get(data.toolCallId);
      const next: BotToolData = { ...previous, toolCallId: data.toolCallId, toolName: data.toolName,
        state: event.type === 'tool_execution_end' ? 'completed' : 'running',
        ...(data.parentToolCallId === undefined ? {} : { parentToolCallId: data.parentToolCallId }),
        ...(data.args === undefined ? {} : { input: data.args }) };
      if (event.type === 'tool_execution_end') {
        if (data.entry) this.append(data.entry);
        const result = (record(data.entry).model ?? []).find((m: Obj) => m.role === 'toolResult');
        if (result) { next.output = content(result); next.state = result.isError ? 'failed' : 'completed'; }
        else if (typeof data.isError === 'boolean') {
          if (data.summary !== undefined && typeof data.summary !== 'string') invalid();
          next.state = data.isError ? 'failed' : 'completed';
          next.output = data.summary ?? '';
        } else { next.state = 'failed'; next.output = 'Tool did not return a result'; }
      } else if (data.summary !== undefined) {
        if (typeof data.summary !== 'string') invalid();
        next.output = data.summary;
      }
      this.tools.set(data.toolCallId, next);
    } else if (event.type === 'run_start') this.busy = true;
    else if (event.type === 'run_end' || event.type === 'run_settled') this.busy = false;
    bounded({ entries: this.entries, generation: this.generation, tools: [...this.tools] });
  }
  project(): ProjectedMessage[] {
    const result: ProjectedMessage[] = [];
    let turn: ProjectedMessage | undefined; let anchor = 'root'; let ordinal = 0;
    const assistant = () => {
      if (!turn) { turn = { message: { id: stableId(this.sessionId, anchor, 'assistant'), role: 'assistant', parts: [] }, keys: [] }; result.push(turn); }
      return turn;
    };
    const add = (target: ProjectedMessage, part: BotUIMessage['parts'][number], key: string) => {
      if (target.message.parts.length >= LIMITS.parts) invalid();
      const previous = target.keys.indexOf(key);
      if (previous === -1) { target.keys.push(key); target.message.parts.push(part); }
      else target.message.parts[previous] = part;
    };
    const tool = (value: BotToolData, owner = anchor) => {
      this.toolOwners.set(value.toolCallId, owner);
      const target = assistant(); const key = stableId(this.sessionId, value.toolCallId, 'tool');
      add(target, { type: 'data-bot-tool', id: key, data: value }, key);
    };
    const message = (m: Obj, key: string) => {
      if (m.role === 'assistant') {
        const target = assistant(); let blockIndex = 0; const blocks = content(m);
        target.lastAssistantText = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
        target.timestamp = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : undefined;
        for (const block of blocks) {
          const partKey = stableId(this.sessionId, anchor, key, blockIndex++);
          if (block.type === 'text' && typeof block.text === 'string') add(target, { type: 'text', text: block.text }, partKey);
          else if (block.type === 'thinking' && typeof block.thinking === 'string' && !block.redacted) add(target, { type: 'reasoning', text: block.thinking }, partKey);
          else if (block.type === 'toolCall') {
            if (typeof block.id !== 'string' || typeof block.name !== 'string') invalid();
            tool({ toolCallId: block.id, toolName: block.name, state: 'running', input: block.arguments });
          }
        }
      } else if (m.role === 'toolResult') {
        if (typeof m.toolCallId !== 'string') invalid();
        const existing = assistant().message.parts.find(part => part.type === 'data-bot-tool' && part.data.toolCallId === m.toolCallId);
        tool({ ...(existing?.type === 'data-bot-tool' ? existing.data : {}), toolCallId: m.toolCallId, toolName: m.toolName ?? 'tool',
          state: m.isError ? 'failed' : 'completed', output: content(m) });
      }
    };
    for (const entry of this.entries) {
      if (isUser(entry)) {
        anchor = entryKey(entry); ordinal = 0; turn = undefined;
        const user: ProjectedMessage = { message: { id: stableId(this.sessionId, anchor, 'user'), role: 'user', parts: [] }, keys: [] };
        for (const m of entry.model ?? []) if (m.role === 'user') for (const block of content(m)) {
          if (block.type === 'text' && typeof block.text === 'string') add(user, { type: 'text', text: block.text }, stableId(anchor, user.keys.length));
        }
        result.push(user);
      } else if (entry.kind !== 'pi.compaction') {
        for (const m of entry.model ?? []) { message(m, `message-${ordinal}`); if (m.role === 'assistant') ordinal++; }
      }
    }
    if (this.generation) message(record(this.generation), `message-${ordinal}`);
    for (const value of this.tools.values()) {
      const owner = this.toolOwners.get(value.toolCallId);
      if (owner && owner !== anchor) continue;
      const existing = assistant().message.parts.find(part => part.type === 'data-bot-tool' && part.data.toolCallId === value.toolCallId);
      tool({ ...(existing?.type === 'data-bot-tool' ? existing.data : {}), ...value });
    }
    return result;
  }
  latest(): ProjectedMessage | undefined { const last = this.project().at(-1); return last?.message.role === 'assistant' ? last : undefined; }
  forOutput(output: string, run?: BotRun): ProjectedMessage | undefined {
    if (!output) return undefined;
    // BotRun.output is exactly the last assistant message, not a suffix of a later answer.
    const candidates = this.project().filter(item => item.message.role === 'assistant' && item.lastAssistantText === output);
    if (run && candidates.length > 1) {
      const start = Date.parse(run.createdAt); const end = Date.parse(run.updatedAt);
      const timed = candidates.filter(item => item.timestamp !== undefined && item.timestamp >= start && item.timestamp <= end);
      if (timed.length === 1) return timed[0];
    }
    // Never silently correlate an older run with a later, identical answer when the backend supplies no identity/time evidence.
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  get messages(): BotUIMessage[] { return this.project().map(item => item.message); }
  get latestUserId(): string | undefined { return this.project().findLast(item => item.message.role === 'user')?.message.id; }
}

/** Pure, bounded conversion for applications that already have a canonical backend snapshot. */
export function botSnapshotToUIMessages(snapshot: BotEvent): BotUIMessage[] {
  const value = validateEvent(snapshot);
  if (value.type !== 'snapshot') bad('Expected a bot snapshot event');
  const sessionId = id(value.sessionId, 'snapshot session ID');
  const transcript = new Transcript(sessionId); transcript.apply(value);
  return transcript.messages;
}
