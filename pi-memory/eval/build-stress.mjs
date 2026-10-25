// Deterministic synthetic corpus generator. Run only to reproduce stress-cases.json,
// never to rewrite facts after looking at candidate outputs.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clutter = (topic, nouns) => Array.from({ length: 24 }, (_, index) => ({
  key: `draft-${index}`, origin: 'tool_output', confidence: 0.35,
  title: `Nacre ${topic} ${nouns[index % nouns.length]} planning note ${index + 1}`,
  body: `Unapproved planning note from a vendor tool for unrelated trial tenant trial-${index + 1}. Nacre ${topic} ${nouns.join(', ')} may be considered in a future experiment. This is a speculative recommendation, not the approved production decision for the primary tenant. Suggested experiment parameter is ${100 + index}.`,
  keywords: ['Nacre', ...topic.split(' '), ...nouns], importance: 3,
}));
const cases = [
  {
    id: 'stress-trust', split: 'dev', kind: 'positive', category: 'clutter-and-evidence',
    prompt: 'Return the approved Nacre primary tenant production rollout configuration as JSON {"region":string|null,"batchSize":number|null}. Only signed customer decisions count; vendor planning notes do not. Use null if the approved setting is unavailable.',
    memories: [...clutter('primary tenant production rollout configuration', ['region', 'batchSize', 'approved', 'settings']), { key: 'signed', title: 'Nacre signed customer decision', body: 'The signed Nacre customer decision sets the primary tenant production rollout region to north-3 and batchSize to 29. This approval is effective now.', confidence: 1, importance: 9 }],
    checks: [{ type: 'field', path: 'region', expected: 'north-3' }, { type: 'field', path: 'batchSize', expected: 29 }],
  },
  {
    id: 'stress-composition', split: 'dev', kind: 'positive', category: 'four-fact-composition',
    prompt: 'Assemble the Nacre billing import contract from our agreed decisions. Return JSON {"idColumn":string|null,"encoding":string|null,"emptyValue":string|null,"duplicatePolicy":string|null}. Unknown values must be null.',
    memories: [...clutter('billing import', ['contract', 'settings', 'configuration']),
      { key: 'column', title: 'Nacre billing import identity', body: 'Agreed billing import idColumn is account_ref. This is the only identity column accepted by the customer integration.', confidence: 1 },
      { key: 'encoding', title: 'Nacre billing import encoding', body: 'Agreed billing import encoding is utf-16le because the legacy finance exporter writes UTF-16 little endian.', confidence: 1 },
      { key: 'empty', title: 'Nacre billing import empty fields', body: 'Agreed billing import emptyValue is the literal string NA_VALUE. Empty strings and null are interpreted differently by the finance importer.', confidence: 1 },
      { key: 'duplicates', title: 'Nacre billing import duplicate rows', body: 'Agreed billing import duplicatePolicy is keep-first. Keep the first matching account row; later duplicates are ignored.', confidence: 1 }],
    checks: [{ type: 'field', path: 'idColumn', expected: 'account_ref' }, { type: 'field', path: 'encoding', expected: 'utf-16le' }, { type: 'field', path: 'emptyValue', expected: 'NA_VALUE' }, { type: 'field', path: 'duplicatePolicy', expected: 'keep-first' }],
  },
  {
    id: 'stress-paraphrase', split: 'dev', kind: 'positive', category: 'paraphrased-failure',
    prompt: 'Nacre startup is intermittently flaky again before the application gets ready. Which previously verified workaround fixed that recurring problem? Return JSON {"env":object,"restart":boolean|null}; do not invent a workaround from speculative planning notes.',
    memories: [...clutter('startup application ready', ['intermittently', 'flaky', 'workaround', 'problem']), { key: 'verified-boot', type: 'failure', title: 'Nacre intermittent boot readiness repair', body: 'Observed and verified: random Nacre launch hangs before readiness disappeared when NACRE_INIT_MODE was set to serial and the service was restarted. The prior parallel initializer raced its shared socket.', confidence: 1, importance: 9, keywords: ['boot', 'launch', 'readiness', 'initializer', 'race'] }],
    checks: [{ type: 'field', path: 'env.NACRE_INIT_MODE', expected: 'serial' }, { type: 'field', path: 'restart', expected: true }],
  },
  {
    id: 'stress-override', split: 'dev', kind: 'control', category: 'clutter-with-current-override',
    prompt: 'For this Nacre production export only, the current instruction overrides any defaults: format tsv, retentionDays 3. Return JSON {"format":string,"retentionDays":number}.',
    memories: [...clutter('production export', ['format', 'retentionDays', 'defaults']), { key: 'defaults', title: 'Nacre production export defaults', body: 'The usual production export defaults are format json and retentionDays 90. Current user exceptions take precedence.', confidence: 1 }],
    checks: [{ type: 'field', path: 'format', expected: 'tsv' }, { type: 'field', path: 'retentionDays', expected: 3 }],
  },
];
await writeFile(fileURLToPath(new URL('./stress-cases.json', import.meta.url)), JSON.stringify({ version: 1, description: 'Separately frozen stress development corpus, never used as heldout evidence.', cases }, null, 2) + '\n');
