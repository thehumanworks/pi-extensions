import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnswer } from './score.mjs';

test('execution rejects a phrase-only answer and checks behavior on multiple inputs', () => {
  const task = { checks: [{ type: 'code', args: [[2, 3]], expected: 5 }, { type: 'code', args: [[]], expected: 0 }] };
  assert.equal(scoreAnswer(task, JSON.stringify({ code: 'function solve(values) { return values.reduce((a,b)=>a+b,0) }' })).score, 1);
  assert.equal(scoreAnswer(task, JSON.stringify({ code: 'function solve() { return 5 }' })).score, 0.5);
  assert.equal(scoreAnswer(task, JSON.stringify({ code: '// sum 2 3 5 0' })).score, 0);
});

test('unknown must be explicit null; mentioning expected value elsewhere does not pass', () => {
  const task = { checks: [{ type: 'field', path: 'approved', expected: null }] };
  assert.equal(scoreAnswer(task, '{"approved":null}').score, 1);
  assert.equal(scoreAnswer(task, '{"approved":99,"notes":"null"}').score, 0);
  assert.equal(scoreAnswer(task, '{}').score, 0);
});

test('loops time out and invalid JSON fails closed', () => {
  const task = { checks: [{ type: 'code', args: [], expected: 1 }] };
  assert.equal(scoreAnswer(task, '{"code":"function solve(){while(true){}}"}').score, 0);
  assert.equal(scoreAnswer(task, 'not json').score, 0);
});
