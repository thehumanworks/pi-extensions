import { readFile } from 'node:fs/promises';

// A zero provider exit only means the agent finished, not that its checks passed.
const input = process.argv[2];
if (!input) throw new Error('Expected Dagu agent stdout path');
const text = await readFile(input, 'utf8');
const match = /\{[\s\S]*\}\s*$/.exec(text);
let result;
try { result = JSON.parse(match?.[0] ?? ''); }
catch { throw new Error('Agent smoke did not return the required JSON verdict'); }
const keys = ['discovery', 'jiraAuth', 'jiraJourney', 'confluenceList', 'confluenceJourney'];
if (keys.some(key => result[key] !== true) || !Array.isArray(result.skips) || result.skips.length) {
  console.error('Pi live smoke assertions failed or were skipped (tenant values withheld)');
  process.exitCode = 1;
} else {
  console.log('Pi live smoke: all five read-only checks PASS; no skips');
}
