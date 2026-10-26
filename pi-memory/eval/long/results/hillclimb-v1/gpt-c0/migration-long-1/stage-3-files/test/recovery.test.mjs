import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

for (const existingEvidence of [false, true]) {
  test(`truncated source recovery, existing evidence: ${existingEvidence}`, async () => {
    const dir = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const input = join(dir, 'input.json');
      const output = join(dir, 'output.json');
      const backup = join(dir, 'backups/source.json');
      const evidence = join(dir, 'recovery/source.bad.json');
      const corrupt = '{"version":';
      const original = JSON.stringify({ version: 1, timeoutSeconds: 3,
        flags: { ready: true }, extra: { keep: true } });
      await mkdir(join(dir, 'backups'));
      await writeFile(backup, original);
      await writeFile(input, corrupt);
      if (existingEvidence) {
        await mkdir(join(dir, 'recovery'));
        await writeFile(evidence, 'older evidence');
        await assert.rejects(migrateFile(input, output), { code: 'EEXIST' });
        assert.equal(await readFile(input, 'utf8'), corrupt);
        assert.equal(await readFile(evidence, 'utf8'), 'older evidence');
      } else {
        const result = await migrateFile(input, output);
        assert.equal(result.version, 3);
        assert.equal(result.timeoutMs, 3000);
        assert.deepEqual(result.features, ['ready']);
        assert.deepEqual(result.extra, { keep: true });
        assert.equal(result.region, 'us-east-1');
        assert.deepEqual(result.retry, { backoffMs: 1000, maxAttempts: 5 });
        assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
        assert.equal(await readFile(evidence, 'utf8'), corrupt);
        await assert.rejects(access(input), { code: 'ENOENT' });
      }
      assert.equal(await readFile(backup, 'utf8'), original);
      await assert.rejects(access(`${output}.lock`), { code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
