---
description: Existing tests are the specification
condition: '\.(?:skip|todo|only)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|\{\s*(?:skip|todo)\s*:\s*true'
scope: tool:write(test/**, tests/**, **/*.test.*, **/*.spec.*)
ignoreNewFiles: true
---
Do not change, skip, weaken, or delete existing tests to make them pass: they are the specification. Fix the code under test instead. If you are certain a test itself is wrong, stop and explain why to the user instead of editing it. New tests go in new test files.
