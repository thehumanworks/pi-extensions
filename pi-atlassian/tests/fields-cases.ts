import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, json, items, record, string, stitch, page } from './helpers.ts';

const dateFields = {
  duedate: { key: 'duedate', name: 'Due date', required: false, operations: ['set'], schema: { type: 'date', system: 'duedate' } },
  customfield_10015: { key: 'customfield_10015', name: 'Start date', required: false, operations: ['set'], schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker', customId: 10015 } },
  customfield_10016: { key: 'customfield_10016', name: 'End date', required: true, operations: ['set'], schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker', customId: 10016 } },
};

test('editableFields exposes all Jira system/custom date fields, schemas and operations with exact metadata pointers', async t => {
  const specialId = 'customfield_~example/date';
  const metadata = { fields: { ...dateFields, [specialId]: { key: specialId, name: 'Custom options', required: true, operations: ['set', 'add'], schema: { type: 'array', items: 'option', custom: 'fixture:options' }, allowedValues: Array.from({ length: 300 }, (_, i) => ({ id: String(i), value: `Option ${i}` })), autoCompleteUrl: 'https://untrusted.example/options', future: { retained: 'UNKNOWN_FIELD_METADATA' } } } };
  const raw = '\r\n' + JSON.stringify(metadata, null, 2) + '\r\n';
  const { service, calls } = fixture(t, () => new Response(raw, { headers: { 'content-type': 'application/json' } }));
  const input = { product: 'jira', kind: 'editableFields', id: 'TEST-1', limit: 1 };
  let result = await service.call('list', input);
  const handle = string(result.handle);
  const found = [...items(result.items)];
  assert.equal(calls[0]!.url.pathname, '/rest/api/3/issue/TEST-1/editmeta');
  assert.equal(calls[0]!.url.search, '', 'no admin overrides or unsupported paging parameters');
  assert.equal(result.writeOperation, 'editIssue');
  await assert.rejects(service.call('list', { ...input, id: 'OTHER-2', cursor: result.nextCursor }), /cursor|binding/i);
  while (result.hasMore) {
    result = await service.call('list', { ...input, cursor: result.nextCursor });
    assert.equal(result.handle, handle);
    found.push(...items(result.items));
  }
  assert.equal(calls.length, 1, 'editmeta is one source with local bounded pages');
  assert.equal(result.complete, true);
  assert.deepEqual(found.map(v => v.fieldId), [...Object.keys(dateFields), specialId]);
  for (const [index, [fieldId, field]] of Object.entries(dateFields).entries()) {
    const item = found[index]!;
    assert.equal(item.name, field.name);
    assert.equal(item.required, field.required);
    assert.deepEqual(item.schema, field.schema);
    assert.deepEqual(item.operations, ['set']);
    assert.equal(item.custom, fieldId !== 'duedate');
    assert.equal(item.issueValuePointer, `/fields/${fieldId}`);
    assert.equal(await stitch(service, handle, string(item.pointer)), JSON.stringify(field));
  }
  const custom = found.at(-1)!;
  assert.equal(custom.pointer, '/fields/customfield_~0example~1date');
  assert.equal(custom.allowedValuesCount, 300);
  assert.equal(custom.allowedValues, undefined, 'large option sets stay in raw source');
  assert.equal(custom.future, undefined);
  assert.equal(await stitch(service, handle, string(custom.allowedValuesPointer)), JSON.stringify(metadata.fields[specialId]!.allowedValues));
  assert.match(await stitch(service, handle, string(custom.pointer)), /UNKNOWN_FIELD_METADATA/);
  assert.equal(await stitch(service, handle), raw);
});

test('empty contextual metadata is not a claim Jira lacks fields; malformed metadata fails explicitly', async t => {
  const { service } = fixture(t, (_request, index) => json(index === 0 ? { fields: {} } : { fields: [] }));
  const input = { product: 'jira', kind: 'editableFields', id: 'TEST-1' };
  const result = await service.call('list', input);
  assert.deepEqual(result.items, []);
  assert.equal(result.complete, true);
  assert.match(JSON.stringify(result.warnings), /permissions|workflow/);
  await assert.rejects(service.call('list', input), /metadata|fields object/i);
});

test('Jira visible field catalog uses non-admin getFields and retains field types/custom identities', async t => {
  const values = Object.entries(dateFields).map(([id, field]) => ({ id, ...field, custom: id !== 'duedate', clauseNames: [field.name] }));
  const { service, calls } = fixture(t, () => json(values));
  const input = { product: 'jira', kind: 'fields', limit: 2 };
  const first = await service.call('list', input);
  assert.equal(calls[0]!.url.pathname, '/rest/api/3/field');
  assert.equal(calls[0]!.url.search, '');
  assert.match(string(first.fieldScope), /NOT contextual editability/);
  assert.deepEqual(items(first.items)[1]!.schema, dateFields.customfield_10015.schema);
  assert.equal(items(first.items)[1]!.custom, true);
  assert.deepEqual(items(first.items)[1]!.clauseNames, ['Start date']);
  const last = await service.call('list', { ...input, cursor: first.nextCursor });
  assert.equal(items(last.items)[0]!.fieldId, 'customfield_10016');
  assert.equal(items(last.items)[0]!.pointer, '/2');
  assert.equal(last.complete, true);
  assert.equal(calls.length, 1);
});

test('Jira createFields pages every contextual field with source indices across local/upstream pagination', async t => {
  const values = Object.entries(dateFields).map(([fieldId, field]) => ({ fieldId, ...field }));
  const { service, calls } = fixture(t, request => {
    const startAt = Number(request.url.searchParams.get('startAt') ?? 0);
    return json({ fields: startAt === 0 ? values.slice(0, 2) : values.slice(2), startAt, maxResults: 2, total: 3 });
  });
  const input = { product: 'jira', kind: 'createFields', id: 'TEST', issueTypeId: '10001', limit: 1 };
  await assert.rejects(service.call('list', { ...input, issueTypeId: undefined }), /id|string/i);
  assert.equal(calls.length, 0);
  const first = await service.call('list', input);
  assert.equal(calls[0]!.url.pathname, '/rest/api/3/issue/createmeta/TEST/issuetypes/10001');
  const second = await service.call('list', { ...input, cursor: first.nextCursor });
  assert.equal(items(second.items)[0]!.pointer, '/fields/1');
  assert.equal(second.handle, first.handle);
  const third = await service.call('list', { ...input, cursor: second.nextCursor });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url.searchParams.get('startAt'), '2');
  assert.equal(items(third.items)[0]!.fieldId, 'customfield_10016');
  assert.equal(third.complete, true);
  assert.equal(await stitch(service, string(third.handle), string(items(third.items)[0]!.pointer)), JSON.stringify(values[2]));
  await assert.rejects(service.call('list', { ...input, issueTypeId: 'other', cursor: first.nextCursor }), /cursor|binding/i);
});

test('Confluence editableFields exposes complete page-update schemas and all paginated custom content properties', async t => {
  const properties = [
    { id: '501', key: 'app.custom/start~date', value: { date: '2030-01-01', future: 'UNKNOWN_PROPERTY_VALUE' }, version: { number: 3 } },
    { id: '502', key: 'team.endDate', value: null, version: { number: 2 } },
    { id: '503', key: 'custom.config', value: ['option'], version: { number: 1 } },
  ];
  const { service, calls } = fixture(t, request => request.url.searchParams.has('cursor')
    ? json({ results: properties.slice(2), _links: {} })
    : json({ results: properties.slice(0, 2), _links: {} }, 200, { link: `</wiki/api/v2/pages/${page.id}/properties?cursor=upstream-next&limit=1>; rel="next"` }));
  const input = { product: 'confluence', kind: 'editableFields', id: page.id, limit: 1 };
  const first = await service.call('list', input);
  assert.equal(calls[0]!.url.pathname, `/wiki/api/v2/pages/${page.id}/properties`);
  assert.equal(first.editabilityVerified, false, 'schema fields are not a tenant permission guarantee');
  assert.equal(first.writeOperation, 'updatePage');
  assert.deepEqual(items(first.requestFields).map(v => v.name), ['id', 'status', 'title', 'spaceId', 'parentId', 'ownerId', 'body', 'version']);
  assert.deepEqual(items(first.requestFields).filter(v => v.required).map(v => v.name), ['id', 'status', 'title', 'body', 'version']);
  const status = items(first.requestFields).find(v => v.name === 'status')!;
  assert.deepEqual(record(status.schema).enum, ['current', 'draft']);
  const fullStatus = await service.call('schema', { product: 'confluence', ref: status.schemaRef });
  assert.deepEqual(fullStatus.details, status.schema);
  assert.match(JSON.stringify(items(first.requestFields).find(v => v.name === 'version')!.schema), /number|message/);
  assert.deepEqual(first.propertyOperations, { create: 'createPageProperty', update: 'updatePagePropertyById', delete: 'deletePagePropertyById' });
  const item = items(first.items)[0]!;
  assert.equal(item.key, properties[0]!.key);
  assert.equal(item.custom, true);
  assert.equal(item.version, 3);
  assert.equal(item.valueType, 'object');
  assert.equal(item.value, undefined);
  assert.equal(await stitch(service, string(first.handle), string(item.valuePointer)), JSON.stringify(properties[0]!.value));
  await assert.rejects(service.call('list', { ...input, kind: 'properties', cursor: first.nextCursor }), /cursor|binding/i);
  const second = await service.call('list', { ...input, cursor: first.nextCursor });
  assert.equal(second.handle, first.handle);
  assert.equal(items(second.items)[0]!.pointer, '/results/1');
  assert.equal(items(second.items)[0]!.valueType, 'null');
  const last = await service.call('list', { ...input, cursor: second.nextCursor });
  assert.equal(items(last.items)[0]!.id, '503');
  assert.equal(last.complete, true);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(last.warnings), /NOT Page Properties/);
});

for (const latestVersion of [3, 4]) {
  test(`Confluence custom property update checks its own version before PUT (latest=${latestVersion})`, async t => {
    const body = { key: 'custom.startDate', value: { date: '2030-01-01' }, version: { number: 4 } };
    const { service, calls } = fixture(t, request => {
      assert.equal(request.url.pathname, `/wiki/api/v2/pages/${page.id}/properties/501`);
      assert.equal(request.url.search, '', 'property reads do not take page body-format');
      if (request.method === 'GET') return json({ id: '501', key: body.key, value: null, version: { number: latestVersion } });
      assert.equal(request.method, 'PUT');
      assert.deepEqual(request.body, body);
      return json({ id: '501', ...body });
    }, { ATLASSIAN_ALLOW_WRITES: '1' });
    const input = { product: 'confluence', operationId: 'updatePagePropertyById', path: { 'page-id': page.id, 'property-id': '501' }, body, reason: 'test custom property version' };
    await assert.rejects(service.call('plan', input), /expectedVersion/);
    await assert.rejects(service.call('plan', { ...input, expectedVersion: 5 }), /version/);
    assert.equal(calls.length, 0);
    const plan = await service.call('plan', { ...input, expectedVersion: 3 });
    const apply = () => service.call('apply', { planId: plan.planId, confirm: plan.planId });
    if (latestVersion === 3) {
      assert.equal((await apply()).applied, true);
      assert.equal(calls.length, 2);
    } else {
      await assert.rejects(apply(), /stale|version/i);
      assert.equal(calls.length, 1, 'stale property must never dispatch PUT');
    }
    assert.equal(calls[0]!.method, 'GET');
    await assert.rejects(apply(), /consumed|unknown/i);
  });
}

test('field discovery rejects unsupported product/kind combinations and malformed catalogs', async t => {
  const { service, calls } = fixture(t, () => json({ values: [] }));
  await assert.rejects(service.call('list', { product: 'jira', kind: 'properties', id: 'TEST-1' }), /unsupported.*jira/i);
  await assert.rejects(service.call('list', { product: 'confluence', kind: 'createFields', id: page.id }), /unsupported.*confluence/i);
  assert.equal(calls.length, 0);
  await assert.rejects(service.call('list', { product: 'jira', kind: 'fields' }), /fields array/);
});

test('Jira discovered date IDs and explicit all-field opt-in fetch exact current values', async t => {
  const fields = { duedate: '2030-01-02', customfield_10015: '2030-01-01', customfield_10016: null };
  const { service, calls } = fixture(t, () => json({ id: '10001', key: 'TEST-1', fields }));
  for (const requested of [Object.keys(fields), ['*all']]) {
    const result = await service.call('get', { product: 'jira', kind: 'issue', id: 'TEST-1', fields: requested });
    assert.deepEqual(result.fieldsRequested, requested);
    assert.equal(calls.at(-1)!.url.searchParams.get('fields'), requested.join(','));
    assert.equal(await stitch(service, string(result.handle), '/fields/customfield_10015'), fields.customfield_10015);
    assert.equal(await stitch(service, string(result.handle), '/fields/customfield_10016'), 'null');
  }
  assert.equal(calls.length, 2, 'field value reads do not fetch field metadata implicitly');
});

test('Confluence properties-only listing avoids page-schema noise and retains arbitrary JSON values', async t => {
  const response = { results: [{ id: '501', key: 'flag', value: false, version: { number: 1 } }], _links: {} };
  const { service } = fixture(t, () => json(response));
  const result = await service.call('list', { product: 'confluence', kind: 'properties', id: page.id });
  assert.equal(result.requestFields, undefined);
  assert.equal(items(result.items)[0]!.valueType, 'boolean');
  assert.equal(await stitch(service, string(result.handle), string(items(result.items)[0]!.valuePointer)), 'false');
});
