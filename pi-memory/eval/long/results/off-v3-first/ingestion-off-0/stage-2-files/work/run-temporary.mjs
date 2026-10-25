import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const report = execFileSync(process.execPath, [
  'bin/ingest.mjs',
  'fixtures/events.ndjson',
  'work/temporary.ndjson',
  'work/temporary-checkpoint.json',
  '1',
], { encoding: 'utf8' });
JSON.parse(report);
await writeFile('temporary-report.json', report);
process.stdout.write(report);
