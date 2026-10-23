// Safe one-request diagnostic: print no credential, identifier, host or tenant values.
import { loadConfig } from '../../src/config.ts';
import { createService } from '../../src/service.ts';
for (const key of ['ATLASSIAN_BASE_URL', 'ATLASSIAN_API_USERNAME', 'ATLASSIAN_API_TOKEN']) {
  const value = process.env[key] ?? '';
  console.log(JSON.stringify({ key, present: Boolean(value), encrypted: value.startsWith('encrypted:') }));
}
const service = createService({ config: { ...loadConfig(), allowWrites: false } });
try {
  const catalog = await service.call('discover', { product: 'jira', kind: 'operations', query: 'myself', limit: 100 });
  const operation = catalog.items.find(item => item.method === 'GET' && item.path === '/rest/api/3/myself');
  await service.call('request', { product: 'jira', operationId: operation.operationId });
  console.log('Authenticated-read PASS');
} catch (error) {
  const message = String(error?.message);
  console.log('Authenticated-read FAIL category: ' + (message.match(/HTTP [0-9]{3}/)?.[0] ?? (message.includes('TLS') ? 'TLS' : 'local_or_network')));
  process.exitCode = 1;
} finally { await service.close(); }
