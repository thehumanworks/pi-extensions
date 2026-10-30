# Pi extensions

An npm-workspace monorepo with independently versioned Pi extensions and standalone Pi-powered SDKs. The root is private and is never published. Extensions are separate npm packages; `bot/` is a private nested workspace containing the standalone runtime, an independent AI SDK adapter, and a maintained Next.js application. There is no aggregate extension that loads everything.

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
| `@nothumanwork/bot` | [runtime](bot/packages/runtime/README.md) — standalone bot SDK, CLI and daemon |
| `@nothumanwork/bot-ai-sdk` | [AI SDK adapter](bot/packages/ai-sdk/README.md) — independent `useChat` integration |
| `@nothumanwork/bot-ui` | [web application](bot/apps/web/README.md) — maintained Next.js UI (private application) |
| `@nothumanwork/pi-advisor` | [pi-advisor](pi-advisor/README.md) |
| `@nothumanwork/pi-agent` | [pi-agent](pi-agent/README.md) — home-rooted specialists, native sessions and scheduled loops |
| `@nothumanwork/pi-atlassian` | [pi-atlassian](pi-atlassian/README.md) |
| `@nothumanwork/pi-background-compaction` | [pi-background-compaction](pi-background-compaction/README.md) |
| `@nothumanwork/pi-bot` | [pi-bot](pi-bot/README.md) |
| `@nothumanwork/pi-canary` | [pi-canary](pi-canary/README.md) |
| `@nothumanwork/pi-create-document` | [pi-create-document](pi-create-document/README.md) — create, convert and read PDF, Word, PowerPoint, Excel, CSV and PNG files with no system tools |
| `@nothumanwork/pi-fast` | [pi-fast](pi-fast/README.md) |
| `@nothumanwork/pi-loggly` | [pi-loggly](pi-loggly/README.md) — Loggly log tools, health dashboard and status line |
| `@nothumanwork/pi-loop` | [pi-loop](pi-loop/README.md) |
| `@nothumanwork/pi-memory` | [pi-memory](pi-memory/README.md) |
| `@nothumanwork/pi-orchestration` | [pi-orchestration](pi-orchestration/README.md) |
| `@nothumanwork/pi-remote` | [pi-remote](pi-remote/README.md) |
| `@nothumanwork/pi-tps` | [pi-tps](pi-tps/README.md) |
| `@nothumanwork/pi-usage` | [pi-usage](pi-usage/README.md) — account usage limits and reset times |
| `@nothumanwork/pi-voice` | [pi-voice](pi-voice/README.md) |
| `@nothumanwork/pi-worktree` | [pi-worktree](pi-worktree/README.md) — run Pi in a git worktree |
| `@nothumanwork/pi-xai` | [pi-xai](pi-xai/README.md) |

Pi 1.4.0 supports Git repository installs but does not offer a Git subdirectory selector. Use npm package names for separate remote installs. Before publishing, you can install a workspace directly from this checkout:

```sh
npm ci --ignore-scripts
npm run build
pi install ./pi-voice
```

Local installs reference the checkout rather than copying it. If you previously installed the same extension from another source, remove that old declaration to avoid loading it twice. Canary and advisor now live under `pi-canary/` and `pi-advisor/`, so update any explicit paths to their former root-level files.

## Develop

Requires Node.js 22.19+ and npm; Bun is also required for the advisor, canary, fast, and remote tests. Run dependency installation from the repository root. `.npmrc` suppresses automatic peer installation because Pi provides the host SDK at runtime; explicit development dependencies provide the SDK for tests. All workspaces test against Pi 1.4.0. Pi Loop intentionally retains its separate, pinned worker runtime. The standalone `@nothumanwork/bot` SDK owns pinned Pi runtime dependencies; `pi-bot` uses that SDK rather than implementing another bot runtime.

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

# Preview using the short directory name (no upload or login check)
npm run publish:package -- pi-voice --dry-run

# Explicit, manual release of just this package
npm run publish:package -- pi-voice
```

The helper in `scripts/publish.mjs` accepts a registered public package short name (`bot`, `bot-ai-sdk`, or `pi-*`), resolves nested workspace paths, skips private coordinators/applications, verifies its `@nothumanwork` name and public access, then runs `npm whoami` before publishing to `https://registry.npmjs.org/`. If login cannot be verified, it stops and asks you to run `npm login`; it does not log in automatically. npm still enforces scope permissions, version uniqueness, and 2FA. Terminal input is passed through for npm prompts. `--dry-run` skips the helper's authentication check and upload but still runs npm lifecycle scripts and may contact the registry. npm can reject a dry run if that version is already published; use `npm pack --workspace @nothumanwork/pi-voice --dry-run` for a packaging-only preview. The helper does not bump versions or run the test suite for you.

You can also run `node /path/to/pi-extensions/scripts/publish.mjs pi-voice` from any directory.

For later releases, bump only the changed package, commit its manifest and the root lockfile, and publish it:

```sh
npm version patch --workspace @nothumanwork/pi-voice --no-git-tag-version
npm run publish:package -- pi-voice
```

Publish `bot` before `pi-bot` when releasing their initial SDK split; the extension depends on `@nothumanwork/bot`. The SDK is installed with npm (`npm install @nothumanwork/bot` or `npm install -g @nothumanwork/bot`), not `pi install`.

Versions are independent; npm will reject re-publishing an existing name/version. Avoid `npm publish --workspaces` unless you intend to release every package. Authentication and native-system prerequisites remain documented in the individual packages.

### Publish all newer packages

```sh
# Query npm and preview candidates, without builds or uploads
npm run publish:updated -- --dry-run

# Publish just the newer (or not-yet-published) packages
npm run publish:updated
```

`scripts/publish-updated.mjs` checks every workspace against npm's complete published version list, using semantic version ordering. It compares with the **highest published version**, including prereleases, not just the `latest` tag. Equal or lower versions are skipped; build metadata alone does not count as a higher version. A structured npm `E404` is treated as an unpublished package and selected for its first release.

All registry lookups finish before publishing starts. Authentication, network, or malformed-response errors abort the scan rather than being treated as missing packages. Selected packages are published sequentially through the single-package helper, with its login checks and npm lifecycle scripts. A publish failure stops the run; earlier successful uploads cannot be rolled back. Re-running skips versions already published. A concurrent release can still make npm reject a version selected during the scan.

This command does not bump versions or run tests. Run the validation steps above before releasing. npm's default tag rules still apply; this helper does not choose prerelease tags automatically. Unlike the single-package helper's dry run, the batch dry run only lists candidates and never invokes `npm publish`.

## Add a new extension

The project agent skill at `.agents/skills/add-pi-extension/SKILL.md` defines the package manifest and TypeScript templates, workspace registration, dependency rules, validation, and release workflow. Pi discovers it in this trusted repository; use `/reload` if needed, then invoke `/skill:add-pi-extension` with your extension request.

## Repository migration notes

The existing `pi-*` directories are ordinary source directories now, not submodule/gitlink entries. Their previous local Git metadata and tracked-file inventories were preserved under `.git/nested-repositories/` on the migration machine. Those backups are local only and are not published or pushed. Existing staged deletions (including `pi-goal`, `pi-remote`, and `tps.ts`) were left alone. Machine-local `mise.local.toml` files remain local and ignored.
