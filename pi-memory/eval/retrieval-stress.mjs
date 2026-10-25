import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../src/store.ts';
import { selectMemories, renderMemories, estimateTokens } from '../src/retrieve.ts';
import { taskPrompt } from './protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const text = await readFile(join(here, 'stress-cases.json'), 'utf8');
const fixtureHash = createHash('sha256').update(text).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'pi-memory-static-stress-'));
const rows = [];
for (const testCase of JSON.parse(text).cases) {
  const store = new MemoryStore(join(root, testCase.id), testCase.id);
  await store.initialize();
  const keys = {};
  for (const memory of testCase.memories) {
    const { key, origin, ...input } = memory;
    const item = await store.save({ ...input, source: { session: `synthetic:${testCase.id}`, entries: [key], origin: origin ?? 'user_confirmation' } });
    keys[item.id] = key;
  }
  for (const strategy of ['baseline', 'improved']) {
    const ranked = store.search(taskPrompt(testCase), { strategy, limit: 24, automatic: strategy !== 'baseline' });
    const selected = selectMemories(ranked, { budgetTokens: 1200, maxItems: 8 });
    const selectedKeys = selected.map(item => keys[item.id]);
    rows.push({ caseId: testCase.id, strategy, selectedKeys, draftCount: selectedKeys.filter(key => key.startsWith('draft-')).length, injectedTokenUpperBound: estimateTokens(renderMemories(selected, 1200)) });
  }
  store.close();
}
const result = { fixtureHash, created: new Date().toISOString(), rows };
const output = process.argv[2] ?? join(here, 'results', 'retrieval-stress.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
