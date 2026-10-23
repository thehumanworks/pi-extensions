import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../docs/catalog/', import.meta.url));
const sources = {
  confluence: 'https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json',
  jira: 'https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json',
};
const hash = x => createHash('sha256').update(x).digest('hex');
const json = x => JSON.stringify(x) + '\n';
const index = [];
const provenance = [];
for (const [product, source] of Object.entries(sources)) {
  const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Public spec download failed: ${response.status}`);
  const raw = await response.text();
  const spec = JSON.parse(raw);
  const dir = path.join(root, product);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'operations'), { recursive: true });
  await mkdir(path.join(dir, 'schemas'), { recursive: true });
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    await writeFile(path.join(dir, 'schemas', hash(name) + '.json'), json(schema));
  }
  // Non-schema local references are retained separately for selective resolution.
  for (const [category, values] of Object.entries(spec.components ?? {})) {
    if (category === 'schemas') continue;
    await mkdir(path.join(dir, category), { recursive: true });
    for (const [name, value] of Object.entries(values)) {
      await writeFile(path.join(dir, category, hash(name) + '.json'), json(value));
    }
  }
  for (const [route, entry] of Object.entries(spec.paths)) {
    for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete', 'options']) {
      const op = entry[method];
      if (!op) continue;
      const operationId = op.operationId ?? `${method}_${route}`;
      const serverPath = product === 'confluence' ? new URL(spec.servers[0].url.replace('{your-domain}', 'example.test')).pathname.replace(/\/$/, '') : '';
      const apiPath = product === 'confluence' && !route.startsWith('/wiki/') ? serverPath + route : route;
      const read = ['get', 'head'].includes(method) || (product === 'jira' && method === 'post' && ['/rest/api/3/search/jql', '/rest/api/3/comment/list'].includes(route));
      const docs = op.externalDocs?.url ?? (product === 'jira' ? 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/' : 'https://developer.atlassian.com/cloud/confluence/rest/v2/intro/');
      const meta = { operationId, product, method: method.toUpperCase(), path: apiPath, summary: (op.summary ?? '').replace(/\s+/g, ' '), write: !read, deprecated: Boolean(op.deprecated), docs };
      index.push(meta);
      await writeFile(path.join(dir, 'operations', hash(operationId) + '.json'), json({ ...op, ...meta, apiPath, parameters: [...(entry.parameters ?? []), ...(op.parameters ?? [])] }));
    }
  }
  provenance.push({ product, source, sha256: hash(raw), retrievedAt: new Date().toISOString(), openapi: spec.openapi, info: spec.info, operations: index.filter(x => x.product === product).length, schemas: Object.keys(spec.components?.schemas ?? {}).length });
}
const cql = { operationId: 'searchContentByCQL', product: 'confluence', method: 'GET', path: '/wiki/rest/api/content/search', summary: 'CQL content search (explicit Confluence V1 exception)', write: false, deprecated: false, docs: 'https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content/#api-wiki-rest-api-content-search-get', parameters: [
  { name: 'cql', in: 'query', required: true, schema: { type: 'string' } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
  { name: 'start', in: 'query', schema: { type: 'integer', minimum: 0 } },
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
  { name: 'expand', in: 'query', schema: { type: 'string' } },
], responses: { '200': { description: 'V1 content search page' } } };
index.push(Object.fromEntries(Object.entries(cql).filter(([k]) => !['parameters', 'responses'].includes(k))));
await writeFile(path.join(root, 'confluence', 'operations', hash(cql.operationId) + '.json'), json(cql));
index.sort((a, b) => (a.product + a.operationId).localeCompare(b.product + b.operationId, 'en'));
await writeFile(path.join(root, 'index.json'), json(index));
await writeFile(path.join(root, 'provenance.json'), JSON.stringify({ generatorVersion: 1, sources: provenance, exceptions: [{ operationId: cql.operationId, source: cql.docs, note: 'Manually reviewed V1 exception; not in V2 spec.' }] }, null, 2) + '\n');
console.log(`Generated ${index.length} offline operations from public specifications.`);
