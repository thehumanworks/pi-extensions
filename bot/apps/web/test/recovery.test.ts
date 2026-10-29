import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoveryRun } from '../lib/recovery';

const cached = { sessionId: 'dconv:8', runId: 'drun:14', status: 'running' };
test('accepted queued/active run references survive reload without a snapshot run ID', () => {
  assert.deepEqual(recoveryRun('dconv:8', JSON.stringify(cached), 'http://[::1]:3001/?session=dconv%3A8'), cached);
  assert.deepEqual(recoveryRun('dconv:8', null, 'http://[::1]:3001/?session=dconv%3A8&run=drun%3A14'), { ...cached, status: 'queued' });
});
test('URL references win over stale cache, and another session cannot supply a run', () => {
  assert.deepEqual(recoveryRun('dconv:8', JSON.stringify(cached), 'http://localhost/?session=dconv%3A8&run=drun%3A21'), { ...cached, runId: 'drun:21', status: 'queued' });
  assert.equal(recoveryRun('dconv:15', JSON.stringify(cached), 'http://localhost/?session=dconv%3A8&run=drun%3A14'), undefined);
});
test('corrupt references fail closed and known terminal statuses are retained', () => {
  assert.equal(recoveryRun('dconv:8', '{bad', 'http://localhost/?session=dconv%3A8&run=../oops'), undefined);
  assert.deepEqual(recoveryRun('dconv:8', JSON.stringify({ ...cached, status: 'cancelled' }), 'http://localhost/?session=dconv%3A8&run=drun%3A14'), { ...cached, status: 'cancelled' });
});
