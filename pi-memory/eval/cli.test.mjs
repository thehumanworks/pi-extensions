import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./run.mjs', import.meta.url));
test('--help exits successfully without Pi on PATH or output directories', () => {
  const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', env: { PATH: '' } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Runs paid Pi model requests/);
  assert.doesNotMatch(result.stdout, /Results:/);
});
test('invalid options fail before model calls', () => {
  for (const option of ['--split=wrong', '--arms=off,off', '--model=unapproved/model', '--repeats=0', '--repeats=NaN', '--concurrency=3', '--unknown=1', '--arms']) {
    const result = spawnSync(process.execPath, [entry, option], { encoding: 'utf8', env: { PATH: '' } });
    assert.notEqual(result.status, 0, option);
    assert.doesNotMatch(result.stdout, /Results:/);
  }
});
