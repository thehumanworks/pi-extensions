#!/usr/bin/env node
// Compares candidate generators for recall, each followed by the real classifier gate.
// Usage: AI_GATEWAY_API_KEY=... node --import tsx eval/retrieval-live.mjs <classifier> <chat model> <cache.json> [out.json]
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pi = await import(pathToFileURL(resolve(root, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const { MemoryStore } = await import(`${root}/src/store.ts`);
const { extract, findClassifier } = await import(`${root}/src/extract.ts`);
const [selection, chatSelection, cachePath, outPath] = process.argv.slice(2);
const EMBEDDING = 'openai/text-embedding-3-small', CANDIDATES = 24, SEEDS = 8, CONCURRENCY = 4;

const registry = new pi.ModelRegistry(await pi.ModelRuntime.create({ authPath: join(pi.getAgentDir(), 'auth.json'), modelsPath: join(pi.getAgentDir(), 'models.json') }));
let classifyTokens = 0, classifyCost = 0, classifyFailures = 0;
const classifyErrors = new Map();
const modelRegistry = new Proxy(registry, { get(target, key) {
  // extract() returns every candidate when a call fails, which would count as recall here: retry, and report what still fails.
  if (key === 'classify') return async (...args) => {
    for (let attempt = 1; ; attempt++) {
      const result = await target.classify(...args);
      classifyTokens += result.usage?.input ?? 0; classifyCost += result.usage?.cost?.total ?? 0;
      if (result.stopReason === 'stop') return result;
      const reason = `${result.stopReason}: ${String(result.errorMessage).slice(0, 80)}`;
      classifyErrors.set(reason, (classifyErrors.get(reason) ?? 0) + 1);
      if (attempt === 4) { classifyFailures++; return result; }
      await new Promise(done => setTimeout(done, 1000 * attempt));
    }
  };
  const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
} });
const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-retrieval-'));
const ctx = { cwd, modelRegistry };
const classifier = await findClassifier(selection, ctx);
if (!classifier) throw new Error(`classifier unavailable: ${selection}`);

const corpus = JSON.parse(await readFile(join(root, 'eval/retrieval-cases.json'), 'utf8'));
const memories = corpus.memories.map(memory => ({ ...memory, title: memory.body.slice(0, 70) }));
for (const file of ['cases.json', 'stress-cases.json']) for (const testCase of JSON.parse(await readFile(join(root, 'eval', file), 'utf8')).cases)
  for (const memory of testCase.memories) if (memory.scope !== 'foreign') memories.push({ key: `${testCase.id}:${memory.key}`, title: memory.title, body: memory.body });

let cache = { enriched: {}, vectors: {} };
try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const save = () => writeFile(cachePath, JSON.stringify(cache));

/** What reflection would add to a distilled memory, plus the entities a dreamer would link. */
async function enrich() {
  const slash = chatSelection.indexOf('/'), model = registry.find(chatSelection.slice(0, slash), chatSelection.slice(slash + 1));
  const missing = memories.filter(memory => !cache.enriched[memory.key]);
  for (let start = 0; start < missing.length; start += 30) {
    const batch = missing.slice(start, start + 30);
    const response = await registry.streamSimple(model, {
      systemPrompt: 'Index project memories for later search. Return JSON only: {"items":[{"key":"...","keywords":[],"triggers":[],"entities":[]}]}. keywords: up to 6 search terms including synonyms. triggers: up to 3 situations in which this applies. entities: the named things it mentions, such as services, pipelines, tools, teams, files and libraries, in their canonical spelling. Common nouns are not entities.',
      messages: [{ role: 'user', content: JSON.stringify(batch.map(({ key, title, body }) => ({ key, title, body: body.slice(0, 600) }))), timestamp: Date.now() }],
    }, { maxTokens: 5000, sessionId: 'pi-memory-retrieval-eval' }).result();
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('').replace(/^```(?:json)?\s*|\s*```$/g, '');
    for (const item of JSON.parse(text).items) cache.enriched[item.key] = item;
    await save();
  }
}
const latencies = [];
async function embed(texts) {
  const started = Date.now();
  const response = await fetch('https://ai-gateway.vercel.sh/v1/embeddings', { method: 'POST', headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: EMBEDDING, input: texts }) });
  if (!response.ok) throw new Error(`embeddings ${response.status}: ${(await response.text()).slice(0, 300)}`);
  latencies.push(Date.now() - started);
  return (await response.json()).data.map(entry => entry.embedding);
}
const text = memory => `${memory.title}\n${memory.body}`;
async function vectors(items, key) {
  const missing = items.filter(item => !cache.vectors[key(item)]);
  for (let start = 0; start < missing.length; start += 96) {
    const batch = missing.slice(start, start + 96), values = await embed(batch.map(item => item.text));
    batch.forEach((item, index) => { cache.vectors[key(item)] = values[index]; });
    await save();
  }
}
await enrich();
await vectors(memories.map(memory => ({ id: memory.key, text: text(memory) })), item => item.id);
await vectors(corpus.queries.map(query => ({ id: `?${query.prompt}`, text: query.prompt })), item => item.id);
const queryLatency = await Promise.all([1, 2, 3, 4, 5].map(async index => { const started = Date.now(); await embed([`latency probe ${index}`]); return Date.now() - started; }));

async function build(name, distilled) {
  const store = new MemoryStore(join(cwd, name), name); await store.initialize();
  const byId = new Map(), byKey = new Map();
  for (const memory of memories) {
    const extra = distilled ? { keywords: cache.enriched[memory.key]?.keywords ?? [], triggers: cache.enriched[memory.key]?.triggers ?? [] } : {};
    const saved = await store.save({ title: memory.title, body: memory.body, ...extra, source: { session: 'eval', entries: [memory.key], origin: 'user_statement' } });
    byId.set(saved.id, memory.key); if (!byKey.has(memory.key)) byKey.set(memory.key, saved);
  }
  return { store, byId, byKey };
}
const rawShape = await build('raw', false), distilled = await build('distilled', true);
const cosine = (a, b) => { let dot = 0, left = 0, right = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2; } return dot / Math.sqrt(left * right); };
const keys = [...distilled.byKey.keys()];
/** text-embedding-3 vectors may be shortened by truncation, so every size can be measured from the full vector. */
const nearest = (prompt, size = 1536) => { const query = cache.vectors[`?${prompt}`].slice(0, size); return keys.map(key => [key, cosine(query, cache.vectors[key].slice(0, size))]).sort((a, b) => b[1] - a[1]).map(([key]) => key); };
const lexical = ({ store, byId }, prompt) => store.search(prompt, { limit: 100, strategy: 'improved', automatic: true }).map(item => byId.get(item.id));
function fuse(lists) {
  const scores = new Map();
  for (const list of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + rank)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}
const entityOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const holders = new Map();
for (const key of keys) for (const name of cache.enriched[key]?.entities ?? []) { const entity = entityOf(name); if (entity) holders.set(entity, [...(holders.get(entity) ?? []), key]); }
/** One hop from the best seeds through shared entities, rarest first: a common entity says little. */
function expand(seeds) {
  const found = new Map();
  for (const seed of seeds.slice(0, SEEDS)) for (const name of cache.enriched[seed]?.entities ?? []) {
    const group = holders.get(entityOf(name)) ?? [];
    if (group.length > 1 && group.length <= 8) for (const key of group) if (!seeds.slice(0, SEEDS).includes(key) && (found.get(key)?.weight ?? 0) < 1 / group.length) found.set(key, { weight: 1 / group.length, through: seed, entity: name });
  }
  return found;
}
const strategies = {
  'fts raw': prompt => ({ list: lexical(rawShape, prompt) }),
  'fts distilled': prompt => ({ list: lexical(distilled, prompt) }),
  'embed': prompt => ({ list: nearest(prompt) }),
  'hybrid': prompt => ({ list: fuse([lexical(distilled, prompt), nearest(prompt)]) }),
  'hybrid>graph': prompt => ({ list: fuse([lexical(distilled, prompt), nearest(prompt)]), expandKept: true }),
  'classify all': () => ({ list: keys, everything: true }),
  'hybrid+graph': prompt => {
    const list = fuse([lexical(distilled, prompt), nearest(prompt)]), found = expand(list);
    const linked = [...found].sort((a, b) => b[1].weight - a[1].weight).slice(0, CANDIDATES / 2);
    return { list: [...list.filter(key => !found.has(key)).slice(0, CANDIDATES - linked.length), ...linked.map(([key]) => key)], links: new Map(linked) };
  },
};
const gate = async (list, prompt, links) => {
  const items = list.map(key => { const memory = distilled.byKey.get(key), link = links?.get(key); return link ? { ...memory, summary: `Connected to "${distilled.byKey.get(link.through).title}" through ${link.entity}.` } : memory; });
  return items.length ? (await extract(items, prompt, classifier, [], AbortSignal.timeout(30000), ctx)).map(item => distilled.byId.get(item.id)) : [];
};
const rows = [];
const jobs = corpus.queries.flatMap(query => Object.entries(strategies).map(([strategy, run]) => async () => {
  const { list, links, expandKept, everything } = run(query.prompt), top = everything ? list : list.slice(0, CANDIDATES);
  const started = Date.now();
  let final = [];
  if (everything) for (let start = 0; start < top.length; start += CANDIDATES) final.push(...await gate(top.slice(start, start + CANDIDATES), query.prompt));
  else final = (await gate(top, query.prompt, links)).slice(0, 8);
  // The graph step after the gate: a neighbour only counts through a memory that was just confirmed to apply.
  const hops = expandKept ? new Map([...expand(final)].filter(([key]) => !final.includes(key))) : new Map();
  if (hops.size) final = [...final, ...await gate([...hops.keys()], `${query.prompt}\n\nKnown to apply: ${final.map(key => distilled.byKey.get(key).body).join(' ')}`, hops)].slice(0, 8);
  rows.push({ class: query.class, strategy, prompt: query.prompt, relevant: query.relevant, ms: Date.now() - started, candidates: top.length + hops.size, atCandidates: query.relevant.filter(key => top.includes(key) || hops.has(key)), atSeeds: query.relevant.filter(key => list.slice(0, 8).includes(key)), final });
}));
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (jobs.length) await jobs.shift()(); }));

const mean = values => values.length ? values.reduce((total, value) => total + value, 0) / values.length : NaN;
const percent = value => Number.isNaN(value) ? '   -' : `${(100 * value).toFixed(0).padStart(3)}%`;
console.log(`${memories.length} memories, ${corpus.queries.length} prompts, ${holders.size} entities, ${[...holders.values()].filter(group => group.length > 1).length} shared`);
console.log('class       strategy        cand.recall  final.recall  precision  injected');
for (const name of [...new Set(corpus.queries.map(query => query.class)), 'second hop', 'all']) for (const strategy of Object.keys(strategies)) {
  const group = rows.filter(row => row.strategy === strategy && (name === 'all' || row.class === name || (name === 'second hop' && row.class === 'multihop'))).map(row => name === 'second hop' ? { ...row, relevant: row.relevant.filter(key => key.endsWith('-b')) } : row), positive = group.filter(row => row.relevant.length);
  const recall = field => mean(positive.flatMap(row => row.relevant.map(key => row[field].includes(key) ? 1 : 0)));
  const finalRecall = mean(positive.flatMap(row => row.relevant.map(key => row.final.includes(key) ? 1 : 0)));
  const retrieved = group.flatMap(row => row.final.map(key => row.relevant.includes(key) ? 1 : 0));
  console.log(`${name.padEnd(11)} ${strategy.padEnd(15)} ${percent(recall('atCandidates')).padStart(10)}  ${percent(finalRecall).padStart(11)}  ${percent(mean(retrieved)).padStart(9)}  ${mean(group.map(row => row.final.length)).toFixed(2).padStart(8)}`);
}
const positives = corpus.queries.filter(query => query.relevant.length);
for (const size of [256, 512, 1024, 1536]) console.log(`embed ${size} dims: candidate recall ${percent(mean(positives.flatMap(query => { const top = nearest(query.prompt, size).slice(0, CANDIDATES); return query.relevant.map(key => top.includes(key) ? 1 : 0); })))}`);
const sorted = queryLatency.toSorted((a, b) => a - b);
console.log(`embedding query ms: ${sorted.join(' ')}. classifier ms p50 ${rows.map(row => row.ms).toSorted((a, b) => a - b)[rows.length >> 1]}. classifier ${classifyTokens} tokens, $${classifyCost.toFixed(3)}, ${classifyFailures} failed after retries`, Object.fromEntries(classifyErrors));
if (outPath) await writeFile(outPath, JSON.stringify({ rows, entities: Object.fromEntries(holders) }, null, 1));
rawShape.store.close(); distilled.store.close();
