---
name: maintain-npm-packages
description: Use this skill when updating any of the packages in this monorepo.
---

# Maintaining npm packages

## Root

- if the package does not yet exist in the root 'package.json' as being part of the workspace, add an entry.

## Package updates

- if a package gets updated and will require publishing to npm - follow semantic versioning, and update the version number so when the user publishes, the version reflects the update.

## Deprecations

- if a package is being deprecated and was previously in npm, give the user the exact npm deprecate command for them to run, pointed at the right package and with a short and clear deprecation message.
