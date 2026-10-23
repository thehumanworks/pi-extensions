# Pi extensions

An npm-workspace monorepo with independently versioned, independently installable Pi extensions. The root is private and is never published. Each directory is a separate npm package; there is no aggregate extension that loads everything.

## Install an extension

After the packages have been published:

```sh
pi install npm:@nothumanwork/pi-voice
pi install npm:@nothumanwork/pi-advisor
# Optional: pin a published version
pi install npm:@nothumanwork/pi-loop@0.1.0
```

| Package | Source and documentation |
| --- | --- |
| `@nothumanwork/pi-advisor` | [pi-advisor](pi-advisor/README.md) |
| `@nothumanwork/pi-atlassian` | [pi-atlassian](pi-atlassian/README.md) |
| `@nothumanwork/pi-canary` | [pi-canary](pi-canary/README.md) |
| `@nothumanwork/pi-fast` | [pi-fast](pi-fast/README.md) |
| `@nothumanwork/pi-loop` | [pi-loop](pi-loop/README.md) |
| `@nothumanwork/pi-voice` | [pi-voice](pi-voice/README.md) |
| `@nothumanwork/pi-xai` | [pi-xai](pi-xai/README.md) |

Pi 1.4.0 supports Git repository installs but does not offer a Git subdirectory selector. Use npm package names for separate remote installs. Before publishing, you can install a workspace directly from this checkout:

```sh
npm ci --ignore-scripts
npm run build
pi install ./pi-voice
```

Local installs reference the checkout rather than copying it. If you previously installed the same extension from another source, remove that old declaration to avoid loading it twice. Canary and advisor now live under `pi-canary/` and `pi-advisor/`, so update any explicit paths to their former root-level files.

## Develop

Requires Node.js 22.19+ and npm; Bun is also required for the advisor, canary, and fast tests. Run dependency installation from the repository root. `.npmrc` suppresses automatic peer installation because Pi provides the host SDK at runtime; explicit development dependencies provide the SDK for tests. All workspaces test against Pi 1.4.0. Pi Loop intentionally retains its separate, pinned worker runtime.

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
npm run pack:check

# Work on one extension
npm test --workspace @nothumanwork/pi-voice
```

`package-lock.json` is the shared lockfile. Workspace-local npm/Bun/pnpm lockfiles have been removed. Older package-specific setup notes may describe standalone workflows; use the root commands above for this monorepo.

`pack:check` builds compiled resources, then checks each npm tarball's file list, entry points, runtime catalogs, and exclusions without publishing. Pi entry points remain TypeScript. Loop's worker and xAI's standalone SDK/CLI are compiled for Node; Node cannot strip TypeScript inside installed `node_modules` packages.

## Publish one package

The configured npm scope is `@nothumanwork`. **Confirm that your npm account can publish to this scope before the first release.** No package has been published by the migration. Public publishing exposes the packaged source and documentation; review the tarball before releasing.

```sh
npm login
npm whoami
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check

# Inspect the exact package, including its prepack build if applicable
npm pack --workspace @nothumanwork/pi-voice --dry-run

# Explicit, manual release of just this package
npm publish --workspace @nothumanwork/pi-voice --access public
```

For later releases, bump only the changed package, commit its manifest and the root lockfile, and publish it:

```sh
npm version patch --workspace @nothumanwork/pi-voice --no-git-tag-version
npm publish --workspace @nothumanwork/pi-voice --access public
```

Versions are independent; npm will reject re-publishing an existing name/version. Avoid `npm publish --workspaces` unless you intend to release every package. Authentication and native-system prerequisites remain documented in the individual packages.

## Repository migration notes

The existing `pi-*` directories are ordinary source directories now, not submodule/gitlink entries. Their previous local Git metadata and tracked-file inventories were preserved under `.git/nested-repositories/` on the migration machine. Those backups are local only and are not published or pushed. Existing staged deletions (including `pi-goal`, `pi-remote`, and `tps.ts`) were left alone. Machine-local `mise.local.toml` files remain local and ignored.
