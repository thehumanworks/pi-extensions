import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixtures } from './fixtures.mjs';

const state = resolve(process.argv[2] ?? 'pi-memory/eval/long/state-v3');
const parseLines = text => text.split('\n').filter(Boolean).map(JSON.parse);
const items = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (/^m_.*\.md$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      if (!match) throw new Error(`Invalid canonical record: ${path}`);
      items.push({ ...JSON.parse(match[1]), body: match[2] });
    }
  }
}
await scan(join(state, 'captured-memory'));
const report = { state, allPassed: true, projects: {}, warnings: [], pending: [] };
const required = {
  ingestion: [/batch size of 4/i, /tenant.*seq/i, /original event objects/i, /arrival order/i, /rejected\.ndjson/, /recovery\/checkpoint\.bad\.json/, /existing output/i, /us-west-9/, /900/],
  migration: [/eu-north-7/, /maxAttempts.?`?\s*5/, /125/, /legacy/, /backups\/source\.json/, /recovery\/source\.bad\.json/, /backup unchanged|without overwriting/i, /batch size 9/],
};
for (const fixture of fixtures) {
  const root = join(state, 'history', fixture.id);
  const scope = JSON.parse(await readFile(join(root, 'scope-audit.json'), 'utf8')).projectScope;
  const records = items.filter(item => item.scope === scope);
  const active = records.filter(item => item.status === 'active');
  const body = active.map(item => item.body).join('\n');
  const history = JSON.parse(await readFile(join(root, 'history-results.json'), 'utf8'));
  const actions = parseLines(await readFile(join(root, 'artifacts/observed-repair.actions.jsonl'), 'utf8'));
  const commands = actions.filter(event => event.event === 'tool_call' && event.tool === 'bash');
  const first = commands[0];
  const firstEnd = actions.find(event => event.event === 'tool_end' && event.id === first?.id);
  const successful = commands.find(event => event.input.command.includes(fixture.id === 'ingestion' ? 'INGEST_ORDER=tenant-first' : 'MIGRATION_LOCK_MODE=copy') && event.input.command.endsWith('tools/probe.mjs'));
  const successfulEnd = actions.find(event => event.event === 'tool_end' && event.id === successful?.id);
  const probe = await readFile(join(root, 'project/tools/probe.mjs'), 'utf8');
  const checks = {
    threeActualSuccessfulSessions: history.length === 3 && history.every(call => call.exitCode === 0),
    observedProbeFailureFirst: first?.input.command.endsWith('tools/probe.mjs') && firstEnd?.result?.structuredContent?.exit_code === 1,
    observedSuccessfulFilesystemAssertions: successfulEnd?.result?.structuredContent?.exit_code === 0 && successfulEnd.result.structuredContent.output.includes('Verified by filesystem assertions'),
    probeUnmodified: probe === fixture.probe,
    capturedFactsPreserved: required[fixture.id].every(pattern => pattern.test(body)),
    supersededEvidenceRetained: records.some(item => item.status === 'superseded'),
    allSourcesActual: active.every(item => item.source?.session && !item.source.session.startsWith('synthetic:')),
    noGlobalPromotion: !items.some(item => item.scope === 'global'),
  };
  for (const name of ['decisions', 'observed-repair', 'correction']) {
    const stderr = await readFile(join(root, 'artifacts', `${name}.stderr.txt`), 'utf8');
    for (const line of stderr.split('\n').filter(line => line.startsWith('pi-memory:'))) report.warnings.push({ project: fixture.id, session: name, text: line });
  }
  report.projects[fixture.id] = { scope, activeRecords: active.length, checks, canonicalHash: createHash('sha256').update(JSON.stringify(records)).digest('hex') };
  if (!Object.values(checks).every(Boolean)) report.allPassed = false;
}
for (const name of await readdir(join(state, 'captured-memory/capture'))) {
  const ledger = JSON.parse(await readFile(join(state, 'captured-memory/capture', name), 'utf8'));
  if (ledger.pending) report.pending.push(name);
}
if (report.pending.length) report.allPassed = false;
await writeFile(join(state, 'audit.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.allPassed) process.exitCode = 1;
