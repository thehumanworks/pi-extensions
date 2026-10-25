import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';

export function parseAnswer(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

export function scoreAnswer(testCase, text) {
  let answer;
  try { answer = parseAnswer(text); }
  catch (error) { return { score: 0, passed: 0, total: testCase.checks.length, errors: [`Invalid JSON: ${error.message}`] }; }
  const checks = testCase.checks.map(check => {
    let actual, passed = false, error;
    try {
      if (check.type === 'field') {
        actual = check.path.split('.').reduce((value, key) => value?.[key], answer);
        passed = isDeepStrictEqual(actual, check.expected);
      } else if (check.type === 'code') {
        if (typeof answer.code !== 'string') throw new Error('Missing executable code');
        // No host objects, imports, require, or process are supplied; code has a 100ms ceiling.
        // This is a correctness checker for synthetic outputs, not a security sandbox.
        const encoded = vm.runInNewContext(`${answer.code}\nJSON.stringify(solve(...${JSON.stringify(check.args)}))`, Object.create(null), { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } });
        actual = JSON.parse(encoded);
        passed = isDeepStrictEqual(actual, check.expected);
      } else if (check.type === 'labels') {
        actual = answer.sections?.map(section => section.label);
        passed = isDeepStrictEqual(actual, check.expected);
      } else if (check.type === 'section-fact') {
        actual = answer.sections?.find(section => section.label === check.label)?.text;
        passed = typeof actual === 'string' && new RegExp(check.pattern, 'i').test(actual);
      } else if (check.type === 'absent') {
        actual = text;
        passed = !new RegExp(check.pattern, 'i').test(text);
      } else throw new Error(`Unknown check ${check.type}`);
    } catch (e) { error = e.message; }
    return { ...check, passed, actual, ...(error ? { error } : {}) };
  });
  return { score: checks.filter(check => check.passed).length / checks.length, passed: checks.filter(check => check.passed).length, total: checks.length, checks };
}
