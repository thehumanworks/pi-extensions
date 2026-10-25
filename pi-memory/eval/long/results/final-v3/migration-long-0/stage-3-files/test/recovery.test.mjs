import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateFile } from '../src/migrate.mjs';

for (const valid of [true, false]) {
  test(`recovery ${valid ? 'preserves backup and corrupt evidence' : 'keeps source when backup cannot migrate'}`, async () => {
    const directory = await mkdtemp(join(process.cwd(), '.recovery-'));
    try {
      const input = join(directory, 'input.json');
      const output = join(directory, 'output.json');
      const backup = join(directory, 'backups', 'source.json');
      const evidence = join(directory, 'recovery', 'source.bad.json');
      const corrupt = '{"version":';
      const original = JSON.stringify({ version: valid ? 1 : 99, timeoutSeconds: 3, flags: { ready: true }, extra: { keep: true } });
      await mkdir(join(directory, 'backups'));
      await writeFile(input, corrupt);
      await writeFile(backup, original);
      if (valid) {
        await migrateFile(input, output);
        assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
          version: 3, timeoutMs: 3000, features: ['ready'],
          region: 'eu-north-7', retry: { maxAttempts: 5, backoffMs: 125 },
          legacy: { extra: { keep: true } },
        });
        assert.equal(await readFile(evidence, 'utf8'), corrupt);
        await assert.rejects(readFile(input), { code: 'ENOENT' });
      } else {
        await assert.rejects(migrateFile(input, output), /Unsupported config version/);
        assert.equal(await readFile(input, 'utf8'), corrupt);
      }
      assert.equal(await readFile(backup, 'utf8'), original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
