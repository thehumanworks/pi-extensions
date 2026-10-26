// Usage: node tools/preserve-evidence.mjs SOURCE EVIDENCE_DIR
// Copies a corrupt source byte-for-byte into an evidence directory without overwriting, and prints its SHA-256.
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

const [source, evidenceDir] = process.argv.slice(2);
if (!source || !evidenceDir) {
  console.error('Usage: node tools/preserve-evidence.mjs SOURCE EVIDENCE_DIR');
  process.exitCode = 1;
} else {
  await mkdir(evidenceDir, { recursive: true });
  const target = join(evidenceDir, `${basename(source, '.json')}.corrupt.json`);
  await copyFile(source, target, constants.COPYFILE_EXCL);
  const bytes = await readFile(target);
  console.log(JSON.stringify({ target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
}
