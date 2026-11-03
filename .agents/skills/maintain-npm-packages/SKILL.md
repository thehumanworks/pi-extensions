---
name: maintain-npm-packages
description: Use whenever a change touches a package in this monorepo — a fix, feature, refactor, or docs change to its published files — to bump its version as part of the work, or when adding, registering, or deprecating a package.
---

# Maintaining npm packages

## Root

- if the package does not yet exist in the root 'package.json' as being part of the workspace, add an entry.

## Package updates

- if a package gets updated and will require publishing to npm - follow semantic versioning, and update the version number so when the user publishes, the version reflects the update.
- the bump is part of the change itself, not a follow-up: make it before reporting the work done or committing, even when the user did not ask for it.
- bump with `npm version <patch|minor|major> --workspace @nothumanwork/<package> --no-git-tag-version`, which updates both the package's `package.json` and the root `package-lock.json`. Commit both with the change.
- bump once per release: if the package already has an unpublished bump (its version is higher than the one on npm, `npm view @nothumanwork/<package> version`), do not bump again unless the change calls for a bigger level.
- say which version you chose and why in your summary, so the user can change the level.

## Deprecations

- if a package is being deprecated and was previously in npm, give the user the exact npm deprecate command for them to run, pointed at the right package and with a short and clear deprecation message.
