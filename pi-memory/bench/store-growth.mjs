#!/usr/bin/env node
/** Run: node --import tsx pi-memory/bench/store-growth.mjs [--sizes 100,1000,10000] [--output path] */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, serializeMemory } from '../src/store.ts';
import { queryTerms, scoreMemory, selectMemories, renderMemories, estimateTokens } from '../src/retrieve.ts';
import { resolveProjectKey } from '../src/project.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const sizes = option('--sizes', '100,1000,10000').split(',').map(Number);
if (sizes.some(n => !Number.isSafeInteger(n) || n < 20 || n > 100000)) throw new Error('Sizes must be integers from 20 to 100000');
const repetitions = Number(option('--repetitions', '7'));
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error('Invalid repetition count');
const output = option('--output', join(here, 'results', 'store-growth.json'));
const layouts = option('--layouts', 'mixed-projects,concentrated').split(',');
if (layouts.some(layout => !['mixed-projects', 'concentrated'].includes(layout))) throw new Error('Invalid corpus layout');
const fixtureText = await readFile(join(here, 'fixtures', 'growth.json'), 'utf8');
const temporalText = await readFile(join(here, 'fixtures', 'temporal.json'), 'utf8');
const heldoutText = await readFile(join(here, 'fixtures', 'relevance-heldout.json'), 'utf8');
const challengesText = await readFile(join(here, 'fixtures', 'relevance-challenges.json'), 'utf8');
const fixtures = JSON.parse(fixtureText), temporal = JSON.parse(temporalText), heldout = JSON.parse(heldoutText), challenges = JSON.parse(challengesText);
const workspace = await mkdtemp(join(tmpdir(), 'pi-memory-growth-'));
const asOf = new Date();
const day = 86400000;
const sha = value => createHash('sha256').update(value).digest('hex');
const id = key => `m_${sha(key).slice(0, 28)}`;
const timestamp = ageDays => new Date(asOf.getTime() - ageDays * day).toISOString();
const round = n => Math.round(n * 1000) / 1000;
function item(key, fields, scope = 'project:bench-primary') {
  const { origin, ...content } = fields;
  const source = { session: 'synthetic:storage-growth', entries: [key], origin: origin ?? 'user_confirmation' };
  return { id: id(key), type: 'project', scope, title: key, body: key, summary: fields.body ?? key,
    keywords: [], triggers: [], paths: [], importance: 6, confidence: 0.95, source, sources: [source],
    supersedes: [], links: [], status: 'active', created: timestamp(0), updated: timestamp(0), last_used: timestamp(0),
    stats: { injected: 0, used: 0, helpful: 0, harmful: 0 }, ...content };
}
async function seed(root, memories) {
  const directories = new Set();
  const directoryFor = memory => join(root, memory.scope === 'global' ? 'global' : `projects/${sha(memory.scope.slice(8)).slice(0, 24)}`, memory.status === 'archived' || memory.status === 'superseded' ? 'archive' : 'items');
  for (const memory of memories) directories.add(directoryFor(memory));
  for (const directory of directories) await mkdir(directory, { recursive: true });
  // Bounded batches avoid exhausting file descriptors on large corpora.
  for (let offset = 0; offset < memories.length; offset += 64) await Promise.all(memories.slice(offset, offset + 64).map(memory => {
    const directory = directoryFor(memory);
    return writeFile(join(directory, `${memory.id}.md`), serializeMemory(memory), { mode: 0o600 });
  }));
}
async function diskSize(root) {
  let totalBytes = 0, canonicalBytes = 0, indexBytes = 0, files = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const size = (await stat(path)).size; totalBytes += size; files++;
        if (entry.name.endsWith('.md')) canonicalBytes += size;
        if (entry.name.startsWith('index.sqlite')) indexBytes += size;
      }
    }
  }
  await walk(root); return { totalBytes, canonicalBytes, indexBytes, files };
}
function latency(samples) { const sorted = [...samples].sort((a, b) => a - b); return { p50Ms: round(sorted[Math.floor((sorted.length - 1) * 0.5)]), p95Ms: round(sorted[Math.ceil((sorted.length - 1) * 0.95)]), maxMs: round(sorted.at(-1)), samples: sorted.length }; }
function bounded(items) { return selectMemories(items, { maxItems: 8, budgetTokens: 1200 }); }
function corpus(size, layout) {
  const memories = fixtures.facts.map(fact => item(fact.key, { ...fact, key: undefined, query: undefined, action: undefined, scope: fact.scope ?? 'project:bench-primary' }));
  const gold = Object.fromEntries(fixtures.facts.map(fact => [fact.key, id(fact.key)]));
  // Exact conflicting facts in unrelated repositories test isolation even when
  // their lexical score exceeds the correct project's matching fact.
  for (let project = 0; project < 8; project++) for (const fact of fixtures.facts.filter(f => f.scope !== 'global')) {
    memories.push(item(`foreign-${project}-${fact.key}`, { ...fact, key: undefined, query: undefined, action: undefined, body: `For foreign repository ${project}, use conflicting-${project}-${fact.key}; do not apply the primary repository command.` }, `project:foreign-${project}`));
  }
  for (let i = memories.length; i < size; i++) {
    const domain = fixtures.noiseDomains[i % fixtures.noiseDomains.length], subject = fixtures.noiseSubjects[Math.floor(i / fixtures.noiseDomains.length) % fixtures.noiseSubjects.length];
    const scope = layout === 'concentrated' || i % 20 === 0 ? 'project:bench-primary' : `project:noise-${i % 50}`;
    memories.push(item(`noise-${i}`, { title: `${domain} ${subject} detail ${i}`, body: `For ${domain} subsystem ${i}, inspect ${subject} diagnostic marker ${i} before changing configuration. This record is specific to component ${i}.`, keywords: [domain, subject, `component${i}`], importance: 3 + i % 5 }, scope));
  }
  return { memories: memories.slice(0, size), gold };
}
/** Bench-only prototype: push scope and active status into SQL before the
 * candidate cap; retain canonical files and the full index unchanged. */
function candidateSearch(db, query, limit) {
  const terms = queryTerms(query); if (!terms.length) return [];
  const match = terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
  const rows = db.prepare(`SELECT items.payload, bm25(items_fts,0,4,2,3,4,1) AS rank FROM items_fts JOIN items ON items.id=items_fts.id WHERE items_fts MATCH ? AND items.scope IN (?,?) AND items.status='active' ORDER BY rank LIMIT ?`).all(match, 'global', 'project:bench-primary', limit);
  return rows.map(row => { const memory = JSON.parse(row.payload); return { ...memory, score: memory.confidence < 0.5 ? 0 : scoreMemory(memory, query, false, -row.rank) }; }).filter(memory => memory.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 24);
}
function metric(query, selected, expected, scopes) {
  const wanted = new Set(expected), ids = selected.map(memory => memory.id), hits = ids.filter(value => wanted.has(value)).length;
  return { query, selected: ids, relevant: expected, hits, recall: wanted.size ? hits / wanted.size : ids.length ? 0 : 1, precision: ids.length ? hits / ids.length : wanted.size ? 0 : 1, foreignLeaks: selected.filter(memory => !scopes.includes(memory.scope)).length, tokenUpperBound: estimateTokens(renderMemories(selected, 1200)) };
}
function relevanceProbe(store, queries) {
  const scored = queries.map(query => ({ ...query, candidates: store.search(query.query, { automatic: true, limit: 24 }) }));
  const gates = [0, 0.1, 0.25, 0.5].map(ratio => {
    const results = scored.map(query => metric(query.query, bounded(query.candidates.filter(memory => memory.score >= (query.candidates[0]?.score ?? 0) * ratio)), query.expected, ['global', store.projectScope]));
    const hits = results.reduce((sum, result) => sum + result.hits, 0), expected = results.reduce((sum, result) => sum + result.relevant.length, 0), returned = results.reduce((sum, result) => sum + result.selected.length, 0);
    return { ratio, microRecall: round(hits / expected), microPrecision: round(returned ? hits / returned : 1), misses: results.filter(result => result.recall < 1).map(result => ({ query: result.query, expected: result.relevant, selected: result.selected })) };
  });
  const gapGates = [4, 8].map(gap => {
    const results = scored.map(query => {
      const cut = query.candidates.findIndex((memory, index) => query.candidates[index + 1] && memory.score / query.candidates[index + 1].score >= gap);
      return metric(query.query, bounded(cut < 0 ? query.candidates : query.candidates.slice(0, cut + 1)), query.expected, ['global', store.projectScope]);
    });
    const hits = results.reduce((sum, result) => sum + result.hits, 0), expected = results.reduce((sum, result) => sum + result.relevant.length, 0), returned = results.reduce((sum, result) => sum + result.selected.length, 0);
    return { gap, microRecall: round(hits / expected), microPrecision: round(returned ? hits / returned : 1), misses: results.filter(result => result.recall < 1).map(result => ({ query: result.query, expected: result.relevant, selected: result.selected })) };
  });
  return { gates, gapGates, examples: scored.map(query => ({ query: query.query, candidates: query.candidates.slice(0, 6).map(memory => ({ id: memory.id, title: memory.title, gold: query.expected.includes(memory.id), score: Number(memory.score.toPrecision(6)), ratioToTop: round(memory.score / query.candidates[0].score) })) })) };
}
async function evaluateSize(size, layout) {
  const root = join(workspace, `${layout}-${size}`); const store = new MemoryStore(root, 'bench-primary');
  await store.initialize(); const { memories, gold } = corpus(size, layout);
  const seedStart = performance.now(); await seed(root, memories); const seedMs = performance.now() - seedStart;
  const initialIndexStart = performance.now(); await store.reindex(); const initialIndexMs = performance.now() - initialIndexStart;
  const rebuildSamples = [];
  for (let i = 0; i < 3; i++) { const start = performance.now(); await store.reindex(); rebuildSamples.push(performance.now() - start); }
  const db = new DatabaseSync(join(root, 'index.sqlite'));
  const queries = fixtures.facts.map(fact => ({ query: fact.query, expected: [gold[fact.key]] }));
  queries.push({ query: fixtures.abstentionQuery, expected: [] });
  const methods = [{ name: 'production', search: query => store.search(query, { automatic: true, limit: 24 }) }, ...(args.includes('--production-only') ? [] : [40, 100, 200].map(cap => ({ name: `prototype-scope-sql-cap-${cap}`, search: query => candidateSearch(db, query, cap) })))];
  const results = [];
  for (const method of methods) {
    for (const query of queries) method.search(query.query);
    const times = [];
    for (let repeat = 0; repeat < repetitions; repeat++) for (const query of queries) { const start = performance.now(); bounded(method.search(query.query)); times.push(performance.now() - start); }
    const perQuery = queries.map(query => metric(query.query, bounded(method.search(query.query)), query.expected, ['global', store.projectScope]));
    const hits = perQuery.reduce((sum, q) => sum + q.hits, 0), relevant = perQuery.reduce((sum, q) => sum + q.relevant.length, 0), returned = perQuery.reduce((sum, q) => sum + q.selected.length, 0);
    results.push({ method: method.name, latency: latency(times), meanRecall: round(perQuery.reduce((sum, q) => sum + q.recall, 0) / perQuery.length), meanPrecision: round(perQuery.reduce((sum, q) => sum + q.precision, 0) / perQuery.length), microRecall: round(hits / relevant), microPrecision: round(returned ? hits / returned : 1), abstentionSuccess: perQuery.filter(q => !q.relevant.length).every(q => !q.selected.length), foreignLeaks: perQuery.reduce((sum, q) => sum + q.foreignLeaks, 0), maxTokenUpperBound: Math.max(...perQuery.map(q => q.tokenUpperBound)), perQuery });
  }
  // Reproduce the storage work actually performed for an injected run: explicit
  // reindex, search/selection, then usage accounting (which rebuilds twice).
  const flowSamples = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const start = performance.now(); await store.reindex();
    const chosen = bounded(store.search(queries[0].query, { automatic: true, limit: 24 }));
    await store.markInjected(chosen.map(memory => memory.id), 'synthetic:storage-growth');
    flowSamples.push(performance.now() - start);
  }
  const scopedCount = memories.filter(memory => memory.scope === 'global' || memory.scope === store.projectScope).length;
  const relevance = relevanceProbe(store, queries);
  db.close(); store.close(); const disk = await diskSize(root);
  const result = { size, layout, scopeCount: new Set(memories.map(memory => memory.scope)).size, visibleActiveItems: scopedCount, seedMs: round(seedMs), initialIndexMs: round(initialIndexMs), reindex: latency(rebuildSamples), injectedRunStorage: latency(flowSamples), disk, results, relevance };
  console.log(JSON.stringify({ size, layout, visibleActiveItems: scopedCount, reindex: result.reindex, injectedRunStorage: result.injectedRunStorage, results: results.map(({ method, latency, microRecall, microPrecision, foreignLeaks }) => ({ method, latency, microRecall, microPrecision, foreignLeaks })) }));
  await rm(root, { recursive: true, force: true }); return result;
}
async function heldoutProbe(size, challenge = false, isolated = false) {
  const root = join(workspace, `${isolated ? 'isolated' : challenge ? 'challenge' : 'heldout'}-${size}`), store = new MemoryStore(root, 'bench-primary'); await store.initialize();
  const facts = (challenge ? [...heldout.facts, ...challenges.facts] : heldout.facts).filter(fact => !isolated || challenges.isolatedFacts.includes(fact.key));
  const memories = [...facts.map(fact => item(`heldout-${fact.key}`, { ...fact, key: undefined, scope: fact.scope ?? 'project:bench-primary' })), ...corpus(size, 'concentrated').memories.slice(fixtures.facts.length)].slice(0, size);
  await seed(root, memories); await store.reindex();
  const queries = (isolated ? challenges.isolatedQueries : challenge ? challenges.queries : heldout.queries).map(query => ({ query: query.query, expected: query.gold.map(key => id(`heldout-${key}`)) }));
  const result = { size, ...relevanceProbe(store, queries) }; store.close(); await rm(root, { recursive: true, force: true }); return result;
}
async function hardCapProbe(size) {
  const { memories, gold } = corpus(size, 'concentrated');
  const goldIds = new Set(Object.values(gold));
  const aged = memories.map(memory => goldIds.has(memory.id) ? { ...memory, retention: 'long', created: timestamp(365), updated: timestamp(365), last_used: timestamp(365) } : memory);
  const queries = fixtures.facts.map(fact => ({ query: fact.query, expected: [gold[fact.key]] }));
  const results = [];
  for (const cap of [null, 100, 1000]) {
    const root = join(workspace, `hard-cap-${cap ?? 'full'}`), store = new MemoryStore(root, 'bench-primary'); await store.initialize();
    const kept = new Set();
    for (const scope of new Set(aged.map(memory => memory.scope))) {
      const ordered = aged.filter(memory => memory.scope === scope).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
      for (const memory of ordered.slice(0, cap ?? ordered.length)) kept.add(memory.id);
    }
    const canonical = aged.map(memory => kept.has(memory.id) ? memory : { ...memory, status: 'archived', archive_reason: 'Synthetic recency active-cap ablation' });
    await seed(root, canonical); await store.reindex();
    const perQuery = queries.map(query => metric(query.query, bounded(store.search(query.query, { automatic: true, limit: 24 })), query.expected, ['global', store.projectScope]));
    const hits = perQuery.reduce((sum, result) => sum + result.hits, 0);
    results.push({ perScopeActiveCap: cap, totalCanonicalItems: canonical.length, totalActiveItems: kept.size, archivedItems: canonical.length - kept.size, goldRecall: round(hits / queries.length), missingGold: queries.filter(query => !kept.has(query.expected[0])).map(query => query.query), perQuery });
    store.close(); await rm(root, { recursive: true, force: true });
  }
  return { size, policy: 'Most recently updated items kept independently per scope; all archived canonical sources remain on disk and indexed.', results };
}
async function identityCheck() {
  const main = join(workspace, 'identity-main'), worktree = join(workspace, 'identity-worktree'), clone = join(workspace, 'identity-clone'), unrelated = join(workspace, 'identity-other');
  const git = (...args) => execFileSync('git', args, { stdio: 'ignore' });
  git('init', main); git('-C', main, '-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  git('-C', main, 'remote', 'add', 'origin', 'git@example.invalid:team/cedar.git');
  git('-C', main, 'worktree', 'add', '-b', 'fixture', worktree);
  git('init', clone); git('-C', clone, 'remote', 'add', 'origin', 'https://example.invalid/team/cedar.git');
  git('init', unrelated); git('-C', unrelated, 'remote', 'add', 'origin', 'https://example.invalid/team/maple.git');
  const keys = [main, worktree, clone, unrelated].map(resolveProjectKey);
  return { sameWorktreeIdentity: keys[0] === keys[1], sameRemoteIdentity: keys[0] === keys[2], unrelatedRemoteIsolated: keys[0] !== keys[3] };
}
async function temporalCheck() {
  const root = join(workspace, 'temporal'); const store = new MemoryStore(root, 'bench-primary'); await store.initialize();
  const memories = temporal.items.map(fact => item(fact.key, { ...fact, key: undefined, ageDays: undefined, expiresInDays: undefined, created: timestamp(fact.ageDays), updated: timestamp(fact.ageDays), last_used: timestamp(fact.ageDays), ...(fact.expiresInDays === undefined ? {} : { expiresAt: new Date(asOf.getTime() + fact.expiresInDays * day).toISOString() }) }));
  const keys = Object.fromEntries(memories.map((memory, index) => [memory.id, temporal.items[index].key]));
  await seed(root, memories); await store.reindex();
  const inspect = () => temporal.queries.map(query => {
    const selected = bounded(store.search(query.query, { automatic: true, limit: 24 }));
    return { ...query, selectedKeys: selected.map(memory => keys[memory.id]), forbiddenSelected: selected.filter(memory => query.forbidden?.includes(keys[memory.id])).length };
  });
  const before = inspect(); const consolidation = await store.consolidate(); const after = inspect();
  const statuses = Object.fromEntries(store.list({ includeArchived: true }).map(memory => [keys[memory.id], memory.status]));
  store.close(); return { note: 'Explicit retention/expiry metadata tests the lifetime contract. Selected evidence and canonical retirement are measured; model execution is not.', before, consolidation, after, statuses };
}
async function sourceHashes() {
  const files = ['store.ts', 'retrieve.ts', 'types.ts', 'project.ts', 'secrets.ts'];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(here, '..', 'src', file)))])));
}
const initialHashes = await sourceHashes();
const snapshotDirectory = `${output.replace(/\.json$/, '')}.sources`;
await mkdir(snapshotDirectory, { recursive: true });
for (const file of Object.keys(initialHashes)) await writeFile(join(snapshotDirectory, file), await readFile(join(here, '..', 'src', file)));
try {
  const identity = await identityCheck(), temporalResult = await temporalCheck(); const rows = [];
  for (const size of sizes) for (const layout of layouts) rows.push(await evaluateSize(size, layout));
  const heldoutResults = [];
  for (const size of sizes.filter(size => size >= 1000 && !args.includes('--skip-relevance'))) heldoutResults.push(await heldoutProbe(size));
  const challengeResults = [];
  for (const size of sizes.filter(size => size >= 1000 && !args.includes('--skip-relevance'))) challengeResults.push(await heldoutProbe(size, true));
  const isolatedChallenges = [];
  for (const size of sizes.filter(size => size >= 1000 && !args.includes('--skip-relevance'))) isolatedChallenges.push(await heldoutProbe(size, true, true));
  const capSize = Number(option('--hard-cap', '0'));
  if (!Number.isSafeInteger(capSize) || capSize < 0 || capSize > 100000) throw new Error('Invalid hard-cap corpus size');
  const hardCaps = capSize ? await hardCapProbe(capSize) : undefined;
  const finalHashes = await sourceHashes();
  const result = { created: new Date().toISOString(), asOf: asOf.toISOString(), node: process.version, machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length }, fixtureHashes: { growth: sha(fixtureText), temporal: sha(temporalText), heldout: sha(heldoutText), challenges: sha(challengesText) }, sourceHashes: initialHashes, sourceSnapshot: snapshotDirectory, sourceStable: JSON.stringify(initialHashes) === JSON.stringify(finalHashes), method: { repetitions, queryCount: fixtures.facts.length + 1, warmup: 'one search per query/method', budgetUpperBound: 1200, candidateCaps: args.includes('--production-only') ? [] : [40, 100, 200], paidModelCalls: 0 }, identity, temporal: temporalResult, rows, heldout: heldoutResults, challenges: challengeResults, isolatedChallenges, hardCaps };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Saved ${output}; sourceStable=${result.sourceStable}`);
  if (!result.sourceStable) process.exitCode = 2;
} finally { await rm(workspace, { recursive: true, force: true }); }
