import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Check } from 'typebox/value';
import extension from '../index.ts';
import { DUMMY, mockFetch, json, record, string, items, issue } from './helpers.ts';

type Tool = {
  name: string; exposure?: string; namespace?: { name: string }; parameters: TSchema; outputSchema?: TSchema;
  annotations?: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionToolContext) => Promise<unknown>;
};
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

function fakePi() {
  const tools = new Map<string, Tool>();
  const events = new Map<string, Handler[]>();
  const flags = new Map<string, Parameters<ExtensionAPI['registerFlag']>[1]>();
  const flagValues = new Map<string, boolean | string>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const notifications: { message: string; type?: string }[] = [];
  const statuses = new Map<string, string | undefined>();
  let active = ['read', 'bash'];
  const api = {
    registerTool(tool: Tool) {
      assert.ok(!tools.has(tool.name), 'tools must register once, not on every discovery');
      tools.set(tool.name, tool);
      if (!tool.exposure || tool.exposure === 'direct' || tool.exposure === 'model-only') active.push(tool.name);
    },
    on(name: string, handler: Handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler); events.set(name, handlers);
      return () => events.set(name, handlers.filter(value => value !== handler));
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = names.filter(name => tools.has(name) || ['read', 'bash'].includes(name)); },
    getAllTools: () => [...tools.values()],
    registerCommand(name: string, command: Parameters<ExtensionAPI['registerCommand']>[1]) { commands.set(name, command); },
    registerFlag(name: string, flag: Parameters<ExtensionAPI['registerFlag']>[1]) { flags.set(name, flag); },
    getFlag(name: string) { return flagValues.get(name) ?? flags.get(name)?.default; },
  };
  const context = (hasUI = false, confirm: () => Promise<boolean> = async () => false, mode: ExtensionContext['mode'] = hasUI ? 'tui' : 'print') => ({
    hasUI, mode, cwd: process.cwd(),
    ui: { confirm,
      notify(message: string, type?: string) { notifications.push({ message, ...(type ? { type } : {}) }); },
      setStatus(key: string, text: string | undefined) { statuses.set(key, text); },
    },
    sessionManager: { getSessionId: () => 'fake-session', getBranch: () => [] },
    isIdle: () => true,
  }) as unknown as ExtensionToolContext & ExtensionCommandContext;
  const emit = async (name: string, ctx = context()) => {
    for (const handler of events.get(name) ?? []) await handler({ type: name }, ctx);
  };
  const invoke = async (name: string, input: Record<string, unknown>, ctx = context()) => {
    const tool = tools.get(name);
    assert.ok(tool, `must register ${name}`);
    return record(await tool.execute('fixture-call', input, undefined, undefined, ctx));
  };
  const command = async (args = '', ctx = context(true)) => {
    const registered = commands.get('atlassian-writes');
    assert.ok(registered);
    await registered.handler(args, ctx);
  };
  return { api: api as unknown as ExtensionAPI, tools, events, flags, flagValues, commands, notifications, statuses, command, context, emit, invoke, active: () => [...active] };
}

// The adapter necessarily reads process.env. Replace every Atlassian key before
// constructing it, then restore in finally; service tests use loadConfig(dummy).
async function isolated<T>(env: Record<string, string>, fetch: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.entries(process.env).filter(([key]) => key.startsWith('ATLASSIAN_')));
  const originalFetch = globalThis.fetch;
  for (const key of saved.keys()) delete process.env[key];
  Object.assign(process.env, env);
  globalThis.fetch = fetch;
  try { return await fn(); }
  finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (key.startsWith('ATLASSIAN_')) delete process.env[key];
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  }
}

function checkResult(tool: Tool, result: Record<string, unknown>) {
  assert.ok(tool.outputSchema, 'data tools must declare outputSchema');
  assert.ok(result.structuredContent !== undefined, 'data tools must return structuredContent');
  assert.ok(Check(tool.outputSchema, result.structuredContent), 'structured output must match the registered schema');
  assert.ok(Array.isArray(result.content));
  let textLength = 0;
  for (const block of items(result.content)) {
    if (block.type === 'text') textLength += string(block.text).length;
  }
  assert.ok(textLength > 0);
  assert.ok(textLength <= 20000, 'model-facing adapter text must be bounded');
  assert.ok(!JSON.stringify(result).includes(DUMMY.ATLASSIAN_API_TOKEN));
  return record(result.structuredContent);
}

test('Pi factory is offline without credentials and registers one direct tool plus codemode namespace', async () => {
  const mock = mockFetch(() => assert.fail('factory/discovery must not fetch'));
  await isolated({}, mock.fetch, async () => {
    const pi = fakePi();
    extension(pi.api);
    try {
      assert.deepEqual([...pi.tools.keys()].sort(), ['apply', 'discover', 'get', 'list', 'plan', 'read', 'request', 'schema', 'search'].map(name => `atlassian_${name}`).sort());
      const direct = [...pi.tools.values()].filter(tool => !tool.exposure || tool.exposure === 'direct' || tool.exposure === 'model-only');
      assert.deepEqual(direct.map(tool => tool.name), ['atlassian_discover']);
      for (const tool of pi.tools.values()) {
        assert.equal(tool.namespace?.name, 'atlassian');
        assert.ok(tool.outputSchema);
        assert.ok(tool.annotations, 'each tool must provide accurate safety hints');
        assert.equal(tool.annotations.readOnlyHint, tool.name !== 'atlassian_apply');
        assert.equal(tool.annotations.destructiveHint, tool.name === 'atlassian_apply');
        assert.equal(tool.annotations.idempotentHint, !['atlassian_apply', 'atlassian_plan'].includes(tool.name));
        assert.equal(tool.annotations.openWorldHint, ['search', 'list', 'get', 'request', 'apply'].some(action => tool.name === `atlassian_${action}`));
        if (tool.name !== 'atlassian_discover') assert.equal(tool.exposure, 'codemode');
      }
      const getSchema = pi.tools.get('atlassian_get')!.parameters;
      assert.ok(Check(getSchema, { product: 'confluence', kind: 'page', id: '20001', bodyFormat: 'storage' }));
      assert.ok(!Check(getSchema, { product: 'confluence', kind: 'page', id: '20001', url: 'https://evil.example' }));
      const listSchema = pi.tools.get('atlassian_list')!.parameters;
      assert.ok(Check(listSchema, { product: 'jira', kind: 'editableFields', id: 'TEST-1', limit: 25 }));
      assert.ok(Check(listSchema, { product: 'jira', kind: 'createFields', id: 'TEST', issueTypeId: '10001' }));
      assert.ok(Check(listSchema, { product: 'confluence', kind: 'editableFields', id: '20001' }));
      assert.ok(Check(listSchema, { product: 'confluence', kind: 'properties', id: '20001' }));
      const requestSchema = pi.tools.get('atlassian_request')!.parameters;
      assert.ok(!Check(requestSchema, { product: 'jira', operationId: 'catalog-id', headers: { authorization: 'attacker' } }));
      assert.ok(pi.events.has('session_shutdown'), 'must close on shutdown/reload');
      const tool = pi.tools.get('atlassian_discover')!;
      const result = await pi.invoke(tool.name, { kind: 'status' });
      checkResult(tool, result);
      assert.equal(result.isError, undefined);
      assert.equal(mock.calls.length, 0);
    } finally {
      await pi.emit('session_shutdown');
      await pi.emit('session_shutdown');
    }
  });
});

test('discover activates only selected already-registered tools without replacing host tools', async () => {
  const mock = mockFetch(() => assert.fail('tool discovery must be local'));
  await isolated(DUMMY, mock.fetch, async () => {
    const pi = fakePi();
    extension(pi.api);
    try {
      const before = [...pi.tools.keys()];
      const result = await pi.invoke('atlassian_discover', { kind: 'tools', query: 'get read' });
      const structured = checkResult(pi.tools.get('atlassian_discover')!, result);
      assert.ok(Object.keys(structured).length > 0);
      assert.deepEqual([...pi.tools.keys()], before);
      assert.ok(pi.active().includes('read') && pi.active().includes('bash'));
      assert.ok(pi.active().includes('atlassian_get') || pi.active().includes('atlassian_read'), 'discover must offer activation without codemode');
      assert.ok(!pi.active().includes('atlassian_apply'), 'read-tool discovery must not activate mutation');
    } finally { await pi.emit('session_shutdown'); }
  });
});

test('Pi tools expose matching structured results, bounded source recovery, and isolate session handles', async () => {
  const largeIssue = { ...issue, fields: { ...issue.fields, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIVATE_BODY_MARKER'.repeat(5000) }] }] } } };
  const mock = mockFetch(() => json(largeIssue));
  await isolated(DUMMY, mock.fetch, async () => {
    const pi = fakePi();
    extension(pi.api);
    try {
      await pi.emit('session_start');
      const result = await pi.invoke('atlassian_get', { product: 'jira', kind: 'issue', id: 'TEST-1' });
      const structured = checkResult(pi.tools.get('atlassian_get')!, result);
      assert.equal(mock.calls.length, 1);
      assert.ok(!JSON.stringify(result.content).includes('PRIVATE_BODY_MARKER'));
      const handle = string(structured.handle);
      const read = await pi.invoke('atlassian_read', { handle, mode: 'raw', offset: 0, length: 128 });
      const source = checkResult(pi.tools.get('atlassian_read')!, read);
      assert.equal(string(source.text), JSON.stringify(largeIssue).slice(0, 128));
      assert.equal(mock.calls.length, 1);
      await pi.emit('session_tree');
      let failed = false;
      try {
        const stale = await pi.invoke('atlassian_read', { handle });
        failed = stale.isError === true;
      } catch { failed = true; }
      assert.ok(failed, 'tree navigation must invalidate source handles on the existing runtime');
    } finally { await pi.emit('session_shutdown'); }
  });
});

test('write opt-in authorizes adapter writes in TUI, RPC, print and JSON without invoking UI approval', async () => {
  const mock = mockFetch(() => new Response(null, { status: 204 }));
  await isolated({ ...DUMMY, ATLASSIAN_ALLOW_WRITES: '1' }, mock.fetch, async () => {
    const pi = fakePi();
    extension(pi.api);
    try {
      // Discover current generated operation IDs rather than pinning historic names.
      let op: Record<string, unknown> | undefined;
      let offset = 0;
      for (let count = 0; count < 100; count++) {
        const result = await pi.invoke('atlassian_discover', { kind: 'operations', product: 'jira', query: '/rest/api/3/issue', offset, limit: 100 });
        const data = record(result.structuredContent);
        op = items(data.items).find(item => string(item.method).toUpperCase() === 'PUT' && item.path === '/rest/api/3/issue/{issueIdOrKey}');
        if (op || data.eof === true) break;
        assert.equal(typeof data.nextOffset, 'number'); offset = Number(data.nextOffset);
      }
      assert.ok(op, 'issue update must be discoverable');
      const makePlan = async () => {
        const result = await pi.invoke('atlassian_plan', { product: 'jira', operationId: op!.operationId, path: { issueIdOrKey: 'TEST-1' }, body: { fields: { summary: 'safe mock' } }, reason: 'test adapter approval' });
        return checkResult(pi.tools.get('atlassian_plan')!, result);
      };
      for (const mode of ['tui', 'rpc', 'print', 'json'] as const) {
        const plan = await makePlan();
        assert.equal(plan.approvalRequired, false);
        const ctx = pi.context(mode === 'tui' || mode === 'rpc', async () => assert.fail('apply must not call ctx.ui.confirm'), mode);
        const result = await pi.invoke('atlassian_apply', { planId: plan.planId, confirm: plan.planId }, ctx);
        const data = checkResult(pi.tools.get('atlassian_apply')!, result);
        assert.equal(data.applied, true);
        await assert.rejects(pi.invoke('atlassian_apply', { planId: plan.planId, confirm: plan.planId }, ctx), /consumed|unknown/i);
      }
      assert.equal(mock.calls.length, 4);
    } finally { await pi.emit('session_shutdown'); }
  });
});

test('adapter default OFF rejects apply in TUI and headless modes; startup CLI opt-in permits apply', async () => {
  const mock = mockFetch(() => new Response(null, { status: 204 }));
  await isolated(DUMMY, mock.fetch, async () => {
    for (const cliEnabled of [false, true]) {
      const pi = fakePi(); extension(pi.api);
      if (cliEnabled) pi.flagValues.set('atlassian-allow-writes', true);
      try {
        const plan = record((await pi.invoke('atlassian_plan', { product: 'jira', operationId: 'editIssue', path: { issueIdOrKey: 'TEST-1' }, body: { fields: { duedate: '2030-01-01' } }, reason: 'test write authorization' })).structuredContent);
        for (const hasUI of [false, true]) {
          const ctx = pi.context(hasUI, async () => assert.fail('no approval dialog'));
          if (!cliEnabled) await assert.rejects(pi.invoke('atlassian_apply', { planId: plan.planId, confirm: plan.planId }, ctx), /writes disabled/i);
        }
        if (cliEnabled) {
          await pi.invoke('atlassian_apply', { planId: plan.planId, confirm: plan.planId });
          assert.equal(mock.calls.length, 1);
        } else assert.equal(mock.calls.length, 0);
      } finally { await pi.emit('session_shutdown'); }
    }
  });
});

test('Pi list exposes contextual editable fields in structured results and tool discovery journeys', async () => {
  const field = { key: 'customfield_10015', name: 'Start date', required: false, operations: ['set'], schema: { type: 'date', custom: 'fixture:datepicker' } };
  const mock = mockFetch(() => json({ fields: { customfield_10015: field } }));
  await isolated(DUMMY, mock.fetch, async () => {
    const pi = fakePi(); extension(pi.api);
    try {
      const journeys = record((await pi.invoke('atlassian_discover', {})).structuredContent);
      assert.match(JSON.stringify(journeys), /editableFields.*custom/);
      await pi.invoke('atlassian_discover', { kind: 'tools', query: 'list read' });
      assert.ok(pi.active().includes('atlassian_list'));
      const result = await pi.invoke('atlassian_list', { product: 'jira', kind: 'editableFields', id: 'TEST-1' });
      const data = checkResult(pi.tools.get('atlassian_list')!, result);
      assert.equal(items(data.items)[0]!.name, 'Start date');
      assert.deepEqual(items(data.items)[0]!.schema, field.schema);
      assert.equal(items(data.items)[0]!.fieldId, field.key);
    } finally { await pi.emit('session_shutdown'); }
  });
});

for (const [envValue, cliValue, expected] of [
  [undefined, undefined, false], ['1', undefined, true], ['0', undefined, false],
  [undefined, true, true], ['1', false, true], ['0', true, true],
] as const) {
  test(`runtime write precedence env=${envValue} CLI=${cliValue}`, async () => {
    const mock = mockFetch(() => assert.fail('controls/status must not fetch'));
    await isolated(envValue === undefined ? {} : { ATLASSIAN_ALLOW_WRITES: envValue }, mock.fetch, async () => {
      const pi = fakePi();
      extension(pi.api);
      assert.equal(pi.flags.get('atlassian-allow-writes')?.type, 'boolean');
      assert.equal(pi.flags.get('atlassian-allow-writes')?.default, undefined);
      // Match Pi: parsed values become available only AFTER the factory.
      if (cliValue !== undefined) pi.flagValues.set('atlassian-allow-writes', cliValue);
      const before = process.env.ATLASSIAN_ALLOW_WRITES;
      try {
        await pi.emit('session_start', pi.context(true));
        const status = async () => record((await pi.invoke('atlassian_discover', { kind: 'status' })).structuredContent).writesEnabled;
        assert.equal(await status(), expected);
        assert.equal(pi.statuses.get('atlassian-writes'), `Atlassian writes: ${expected ? 'ON' : 'OFF'}`);
        await pi.command('on');
        assert.match(pi.notifications.at(-1)!.message, /Usage/);
        assert.equal(await status(), expected);
        await assert.rejects(pi.command('', pi.context(false)), /TUI-only/);
        await pi.command('', pi.context(true, async () => true, 'rpc'));
        await assert.rejects(pi.command('', pi.context(false, async () => true, 'tui')), /TUI-only/);
        assert.equal(await status(), expected);
        await pi.command();
        assert.equal(await status(), !expected);
        assert.match(pi.notifications.at(-1)!.message, !expected ? /no additional approval dialog/ : /cannot be rolled back/);
        await pi.emit('session_tree', pi.context(true));
        assert.equal(await status(), !expected, 'tree navigation preserves the existing runtime override');
        assert.equal(pi.statuses.get('atlassian-writes'), `Atlassian writes: ${!expected ? 'ON' : 'OFF'}`);
        assert.equal(process.env.ATLASSIAN_ALLOW_WRITES, before);
        await pi.emit('session_shutdown');
        // Pi replaces the factory/runtime on new/resume/fork/session replacement.
        // A fresh runtime also models reload/restart, not startup on the old fake.
        const fresh = fakePi();
        extension(fresh.api);
        // Match Pi: reapply parsed CLI values only AFTER the fresh factory.
        if (cliValue !== undefined) fresh.flagValues.set('atlassian-allow-writes', cliValue);
        try {
          await fresh.emit('session_start', fresh.context(true));
          assert.equal(record((await fresh.invoke('atlassian_discover', { kind: 'status' })).structuredContent).writesEnabled, expected,
            'replacement and reload/restart restore the env/CLI baseline, not the old toggle');
          assert.equal(fresh.statuses.get('atlassian-writes'), `Atlassian writes: ${expected ? 'ON' : 'OFF'}`);
          assert.equal(process.env.ATLASSIAN_ALLOW_WRITES, before);
        } finally { await fresh.emit('session_shutdown'); }
        assert.equal(mock.calls.length, 0);
      } finally { await pi.emit('session_shutdown'); }
    });
  });
}

test('slash controls preserve exact source/cursor and revoke a queued apply without UI approval', async () => {
  const raw = '{\r\n "values": [{"id":"1","future":"😀"},{"id":"2"}], "total":2\r\n}';
  let release!: (response: Response) => void;
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const blockedRead = new Promise<Response>(resolve => { release = resolve; });
  const mock = mockFetch((request, index) => {
    if (request.method !== 'GET') return new Response(null, { status: 204 });
    if (index === 1) { entered(); return blockedRead; }
    return new Response(raw);
  });
  await isolated({ ...DUMMY, ATLASSIAN_MAX_CONCURRENCY: '1' }, mock.fetch, async () => {
    const pi = fakePi(); extension(pi.api);
    try {
      const input = { product: 'jira', kind: 'projects', limit: 1 };
      const first = record((await pi.invoke('atlassian_list', input)).structuredContent);
      await pi.command(); // Enable without recreating the existing service.
      const ops = record((await pi.invoke('atlassian_discover', { kind: 'operations', product: 'jira', query: 'PUT /rest/api/3/issue/{issueIdOrKey}' })).structuredContent);
      const op = items(ops.items).find(value => value.method === 'PUT' && value.path === '/rest/api/3/issue/{issueIdOrKey}');
      assert.ok(op);
      const makePlan = async () => record((await pi.invoke('atlassian_plan', { product: 'jira', operationId: op.operationId, path: { issueIdOrKey: 'TEST-1' }, body: { fields: { summary: 'mock' } }, reason: 'control test' })).structuredContent);
      const proposal = await makePlan(); assert.equal(proposal.writesEnabled, true);
      const read = pi.invoke('atlassian_list', input);
      await entry;
      const pending = pi.invoke('atlassian_apply', { planId: proposal.planId, confirm: proposal.planId }, pi.context(true, async () => assert.fail('no approval dialog')));
      const rejected = assert.rejects(pending, /revoked|cancel|abort/i);
      await new Promise(resolve => setTimeout(resolve, 10));
      await pi.command(); await pi.command(); // OFF then ON cannot revive the queued write.
      release(new Response(raw)); await read; await rejected;
      const source = record((await pi.invoke('atlassian_read', { handle: first.handle })).structuredContent);
      assert.equal(source.text, raw);
      const next = record((await pi.invoke('atlassian_list', { ...input, cursor: first.nextCursor })).structuredContent);
      assert.equal(items(next.items)[0]!.id, '2'); assert.equal(next.handle, first.handle);
      assert.equal(mock.calls.length, 2);
      await assert.rejects(pi.invoke('atlassian_apply', { planId: proposal.planId, confirm: proposal.planId }), /unknown|consumed|expired/i);
      const fresh = await makePlan();
      await pi.invoke('atlassian_apply', { planId: fresh.planId, confirm: fresh.planId });
      assert.equal(mock.calls.length, 3);
      assert.equal(process.env.ATLASSIAN_ALLOW_WRITES, undefined);
    } finally { await pi.emit('session_shutdown'); }
  });
});

test('discovery can explicitly activate registered codemode without eagerly activating namespace schemas', async () => {
  const mock = mockFetch(() => assert.fail('loadout activation is offline'));
  await isolated(DUMMY, mock.fetch, async () => {
    const pi = fakePi();
    extension(pi.api);
    const prototype = pi.tools.get('atlassian_discover')!;
    // Stand-in for the already-registered host builtin; never invoke this clone.
    pi.tools.set('codemode', { ...prototype, name: 'codemode' });
    try {
      assert.ok(!pi.active().includes('codemode'));
      const result = await pi.invoke('atlassian_discover', { kind: 'tools', query: 'codemode' });
      const data = checkResult(prototype, result);
      assert.deepEqual(data.activated, ['codemode']);
      assert.ok(pi.active().includes('codemode'));
      assert.ok(pi.active().includes('read') && pi.active().includes('bash'));
      assert.ok(!pi.active().includes('atlassian_get'));
      assert.ok(!pi.active().includes('atlassian_apply'));
      assert.equal(mock.calls.length, 0);
    } finally { await pi.emit('session_shutdown'); }
  });
});
