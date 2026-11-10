---
description: packages/shared is frozen
condition:
  - '\b(?:sed\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*i|perl\s+-[a-zA-Z]*i|rm|mv|truncate|patch|git\s+(?:rm|checkout|restore|apply))\b[^\n;&|]*\s(?:\./)?packages/shared/[\w./-]*(?=\s|$|[;&|)])'
  - '\bcp\b[^\n;&|]*\s(?:\./)?packages/shared/[\w./-]*\s*(?:$|[\n;&|)])'
  - '(?:>>?|\btee\s+(?:-a\s+)?)\s*(?:\./)?packages/shared/'
scope: tool:bash
---
`packages/shared` belongs to the platform team and is frozen: do not modify anything under it. Make the change inside the package you are working on instead, for example with a local helper or a wrapper around the shared function.
