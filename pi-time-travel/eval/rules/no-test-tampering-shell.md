---
description: Existing tests are the specification
condition: '\b(?:sed\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*i|perl\s+-[a-zA-Z]*i|rm|mv|truncate|git\s+(?:rm|checkout|restore))\b[^\n;&|]*\s(?:\./)?(?:[\w.-]+/)*(?:tests?/[\w./-]*|[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=\s|$|[;&|)])'
scope: tool:bash
---
Do not change, skip, weaken, or delete existing tests to make them pass: they are the specification. Fix the code under test instead. If you are certain a test itself is wrong, stop and explain why to the user instead of editing it. New tests go in new test files.
