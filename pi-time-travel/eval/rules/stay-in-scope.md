---
description: packages/shared is frozen
condition:
  - '^'
scope: tool:edit(packages/shared/**), tool:write(packages/shared/**)
---
`packages/shared` belongs to the platform team and is frozen: do not modify anything under it. Make the change inside the package you are working on instead, for example with a local helper or a wrapper around the shared function.
