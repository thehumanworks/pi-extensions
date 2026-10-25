import { readFile, readdir, mkdir, cp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) throw new Error('Pass full-matrix result directory and fresh template directory');
const source = resolve(sourceArg), target = resolve(targetArg);
await mkdir(target); // Refuse reuse of a previous template set.
async function hashes(directory, prefix = '') {
  const entries = {};
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(entries, await hashes(directory, path));
    else if (entry.isFile()) entries[path] = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
    else throw new Error(`Unexpected template file type: ${path}`);
  }
  return entries;
}
const manifest = { source, created: new Date().toISOString(), description: 'Two identical copies of short-history stage-2 code. The long-0 path aliases satisfy the unchanged runner convention; they do not indicate long-arm origin.', projects: {}, identicalAcrossArms: true };
for (const project of ['ingestion', 'migration']) {
  const id = `${project}-short-0`, input = join(source, id, 'stage-2-files');
  const result = JSON.parse(await readFile(join(source, id, 'result.json'), 'utf8'));
  if (result.arm !== 'short' || result.project !== project || result.repeat !== 0) throw new Error('Unexpected template origin');
  const original = await hashes(input), copies = {};
  for (const arm of ['long', 'polluted']) {
    const destination = join(target, arm, `${project}-long-0`, 'stage-2-files');
    await cp(input, destination, { recursive: true });
    const copied = await hashes(destination);
    if (!isDeepStrictEqual(original, copied)) throw new Error(`${project}: template differs after copying for ${arm}`);
    copies[arm] = destination;
  }
  manifest.projects[project] = { originId: id, originPath: input, fixtureHash: result.fixtureHash, protocolHash: result.protocolHash, sourceHash: result.sourceHash, files: original, copies };
}
await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ target, identicalAcrossArms: true, projects: Object.keys(manifest.projects) }));
