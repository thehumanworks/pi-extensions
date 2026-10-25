import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/store.ts';
import { resolveProjectKey } from '../src/project.ts';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
if (process.argv.includes('--help')) { console.log('node --import tsx pi-memory/bench/cache-impact.mjs [--repeats=2] [--out=directory]\nRuns six-turn Pi sessions for off, append-only-memory and a prefix-breaking diagnostic control. Uses openai/gpt-6.1-sol.'); process.exit(0); }
const repeats = Number(option('repeats', '2'));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('repeats must be 1..5');
const out = resolve(option('out', join(pkg, 'bench/results/cache-impact')));
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use an empty result directory');
const temp = await mkdtemp(join(tmpdir(), 'pi-cache-impact-'));
const topics = ['staging verification', 'database migration', 'export schema', 'rollback checkpoint', 'release notes', 'artifact integrity'];
const bodies = ['Run pnpm harbor:verify before staging.', 'Check migration status with harbor db status before applying changes.', 'Harbor CSV exports use UTF-8 and an explicit schema version column.', 'Capture a named checkpoint before any rollback rehearsal.', 'Harbor release notes use Changes, Validation, Follow-up in that order.', 'Verify the SHA256 digest of Harbor release artifacts.'];
// A useful static project API reference supplies a cacheable prefix. It is identical across arms.
const reference = Array.from({ length: 90 }, (_, index) => `Module M${index}: accepts { tenant: string, records: array, revision: integer }; validates tenant ownership before writes, preserves input order, returns { accepted: integer, rejected: integer }; retry only idempotent operations; schema version ${1 + index % 4}; tests cover empty input, duplicate IDs, cancellation and failed persistence.`).join('\n');
const prompts = topics.map((topic, index) => `${index === 0 ? `Reference for this synthetic Harbor project:\n${reference}\n\n` : ''}Continue the Harbor ${topic} review using established context. This measurement requests only acknowledgment, not code changes. Reply exactly ACK.`);
const sourceHashes = {};
for (const file of ['index.ts', ...((await readdir(join(pkg, 'src'))).filter(f => f.endsWith('.ts')).map(f => `src/${f}`))]) sourceHashes[file] = createHash('sha256').update(await readFile(join(pkg, file))).digest('hex');
const results = [];
try {
  for (let repeat = 0; repeat < repeats; repeat++) {
    const arms = repeat % 2 ? ['prefix-breaking-control', 'append-only-memory', 'off'] : ['off', 'append-only-memory', 'prefix-breaking-control'];
    for (const arm of arms) {
      const id = `${arm}-${repeat}`, cwd = join(temp, id), memory = join(cwd, 'memory');
      await mkdir(cwd, { recursive: true });
      const store = new MemoryStore(memory, resolveProjectKey(cwd)); await store.initialize();
      for (const [index, topic] of topics.entries()) await store.save({ title: `Harbor ${topic}`, body: bodies[index], keywords: ['Harbor', ...topic.split(' ')], source: { session: 'synthetic-history', entries: [`u${index}`], origin: 'user_statement' } });
      store.close();
      const metrics = join(out, `${id}.metrics.jsonl`);
      const args = ['-ne', '-e', join(pkg, 'bench/cache-probe.ts'), '-ns', '-np', '-nc', '--no-mcp', '--no-tools', '--no-session', '--model', 'openai/gpt-6.1-sol', '--thinking', 'low', '--mode', 'json'];
      if (arm !== 'off') args.push('-e', join(pkg, 'index.ts'), '--memory-dir', memory, '--memory-mode', 'inject');
      args.push('-p', ...prompts);
      const started = Date.now();
      const execution = await new Promise((done, reject) => {
        const child = spawn('pi', args, { cwd, env: { ...process.env, PI_MEMORY_DISABLED: arm === 'off' ? '1' : '0', PI_MEMORY_CAPTURE: '0', PI_MEMORY_RETRIEVAL_MODEL: 'off', PI_MEMORY_STRATEGY: 'improved', PI_MEMORY_TRACE: join(out, `${id}.recall.jsonl`), PI_CACHE_ARM: arm, PI_CACHE_METRICS: metrics, PI_CACHE_PARTITION: randomUUID() }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
        const timer = setTimeout(() => child.kill('SIGTERM'), 300000);
        child.on('error', reject); child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr, elapsedMs: Date.now() - started }); });
      });
      await writeFile(join(out, `${id}.events.jsonl`), execution.stdout); await writeFile(join(out, `${id}.stderr.txt`), execution.stderr);
      const events = execution.stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const instrumented = (await readFile(metrics, 'utf8')).trim().split('\n').map(JSON.parse);
      const responses = instrumented.filter(e => e.event === 'response'), requests = instrumented.filter(e => e.event === 'request');
      const finals = events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').map(e => e.message);
      const errors = [];
      if (execution.code !== 0 || responses.length !== prompts.length || finals.length !== prompts.length) errors.push('Incomplete run');
      if (finals.some(m => m.stopReason !== 'stop')) errors.push('Model response did not complete');
      const outputDeviations = finals.map((m, index) => ({ turn: index + 1, text: m.content.filter(c => c.type === 'text').map(c => c.text).join('').trim() })).filter(r => r.text !== 'ACK');
      for (const [file, hash] of Object.entries(sourceHashes)) if (createHash('sha256').update(await readFile(join(pkg, file))).digest('hex') !== hash) errors.push(`Source changed: ${file}`);
      const prefixChecks = requests.slice(1).map((request, index) => JSON.stringify(request.payload.input.slice(0, requests[index].payload.input.length)) === JSON.stringify(requests[index].payload.input));
      if (arm !== 'prefix-breaking-control' && prefixChecks.some(pass => !pass)) errors.push('Production transcript prefix changed');
      if (arm === 'prefix-breaking-control' && prefixChecks.some(Boolean)) errors.push('Diagnostic control failed to break prefix');
      const turns = responses.map((response, index) => {
        const usage = response.usage ?? {}, details = usage.input_tokens_details ?? {};
        const totalInput = usage.input_tokens ?? 0, cacheRead = details.cached_tokens ?? 0, cacheWrite = details.cache_write_tokens ?? 0;
        return { turn: index + 1, input: totalInput, uncachedInput: totalInput - cacheRead - cacheWrite, cacheRead, cacheWrite, output: usage.output_tokens ?? 0, latencyMs: response.latencyMs, firstTextMs: instrumented.find(e => e.event === 'first-text' && e.turn === index + 1)?.latencyMs, sdkCostEstimate: finals[index]?.usage.cost };
      });
      const result = { id, arm, repeat, model: 'openai/gpt-6.1-sol', elapsedMs: execution.elapsedMs, errors, outputDeviations, prefixChecks, turns };
      results.push(result); await writeFile(join(out, `${id}.result.json`), JSON.stringify(result, null, 2) + '\n');
      console.log(`${id}: ${turns.reduce((n,t)=>n+t.cacheRead,0)} cached / ${turns.reduce((n,t)=>n+t.input,0)} input; errors=${errors.length}`);
    }
  }
  const summary = {};
  for (const arm of ['off', 'append-only-memory', 'prefix-breaking-control']) {
    const runs = results.filter(r => r.arm === arm), all = runs.flatMap(r => r.turns), warm = runs.flatMap(r => r.turns.slice(1));
    const sum = (rows, field) => rows.reduce((n,r)=>n+r[field],0);
    const cacheRead = sum(all,'cacheRead'), input = sum(all,'input');
    summary[arm] = { runs: runs.length, requests: all.length, errors: runs.reduce((n,r)=>n+r.errors.length,0), input, uncachedInput: sum(all,'uncachedInput'), cacheRead, cacheWrite: sum(all,'cacheWrite'), cachedShare: cacheRead/input, warmCachedShare: sum(warm,'cacheRead')/sum(warm,'input'), meanFirstTextMs: sum(all,'firstTextMs')/all.length, meanResponseMs: sum(all,'latencyMs')/all.length, sdkCostEstimate: all.reduce((n,r)=>n+(r.sdkCostEstimate?.total??0),0) };
  }
  await writeFile(join(out, 'summary.json'), JSON.stringify({ model: 'openai/gpt-6.1-sol', repeats, prompts, sourceHashes, results: summary, interpretation: 'Actual provider usage is authoritative. SDK costs are estimates, not invoices. Prefix-breaking control is diagnostic, not an alternative implementation. ACK tasks measure caching, not complex-task quality.' }, null, 2) + '\n');
  assert.ok(results.every(r => !r.errors.length), 'One or more cache measurement runs failed');
} finally { await rm(temp, { recursive: true, force: true }); }
