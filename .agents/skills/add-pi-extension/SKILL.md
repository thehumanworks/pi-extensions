---
name: add-pi-extension
description: Add a new independently publishable Pi extension package to this npm-workspace monorepo under @nothumanwork. Use when creating an extension, importing one, or preparing a new workspace package for npm publication.
---

# Add a Pi extension package

This skill belongs to the pi-extensions repository. Resolve the repository root as `../../..` relative to this skill directory. Run the commands below from that root. Read the root `README.md`, `package.json`, `.npmrc`, and `scripts/packages.test.mjs` before making changes, and inspect one comparable existing package. Preserve unrelated work. Do not publish, log in, commit, or push unless the user explicitly requests it.

## Layout and naming

Choose a short directory name `pi-<feature>` (lowercase letters, numbers, and single hyphens). Confirm the name with the user if ambiguous. Its npm name must be exactly `@nothumanwork/pi-<feature>`; the npm scope is distinct from the GitHub owner `thehumanworks`.

Create an ordinary directory, not a nested Git repository or submodule:

```text
pi-example/
  package.json
  index.ts
  README.md
  tsconfig.json
  test/
    example.test.ts
  src/                 # optional implementation modules
```

## Manifest template

Replace `example` and the description. Use this as a starting point, not a reason to add unused dependencies. Match the current repo's host SDK development version (1.4.0 when this template was written).

```json
{
  "name": "@nothumanwork/pi-example",
  "version": "0.1.0",
  "type": "module",
  "description": "Describe the user-facing purpose of this extension",
  "keywords": ["pi-package"],
  "engines": { "node": ">=22.19.0" },
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/thehumanworks/pi-extensions.git",
    "directory": "pi-example"
  },
  "files": ["index.ts", "src", "README.md"],
  "pi": { "extensions": ["./index.ts"] },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "tsx --test test/*.test.ts"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@types/node": "^22.19.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.3"
  }
}
```

- Do not set `private: true` on the extension; keep it on the root.
- Declare every non-host runtime import in `dependencies`. Never rely on hoisting to supply undeclared dependencies.
- Host-supplied packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox`, with the same scope on the Pi packages) belong in `peerDependencies` with `"*"`, plus explicit development dependencies when needed for tests. Do not bundle physical runtime copies.
- Use a `files` allowlist. Include all runtime assets (schemas, catalogs, prompts, etc.), but not credentials, machine-local config, tests, or caches. Add a license only when the user has chosen or already established one.
- Pi can load TypeScript entry points. Standalone Node CLIs, workers, and library exports should point to compiled JavaScript: Node does not strip TypeScript under `node_modules`. Follow `pi-xai/tsconfig.build.json` or `pi-loop/tsconfig.build.json`, add `build` and `prepack` scripts, and include `dist` in `files` when needed. Builds must succeed from a clean install, not rely on stale output.

## TypeScript template

For a source-only extension, start with:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

Use the installed Pi extension API documentation before implementing behavior. Export the extension's default registration function from `index.ts`. Add focused tests for the requested behavior, with network calls mocked unless explicit integration testing is requested. Resolve dependencies by package name, never by a hardcoded `../node_modules/...` path.

## Wire into the workspace

1. Add `pi-example` to the root `workspaces` array, maintaining alphabetical order. Do not create a second lockfile or package-manager workspace config.
2. Add a row to the root README package table and write the package README with its purpose, configuration, prerequisites, and `pi install npm:@nothumanwork/pi-example` command (available after publication).
3. Run `npm install --ignore-scripts` at the root to update the shared `package-lock.json`. Respect the root `.npmrc` peer policy.
4. Root scripts already discover workspaces. `scripts/packages.test.mjs` automatically checks the new package. Add package-specific assertions there for any required runtime assets or compiled entry points.

## Validate before handoff

```sh
npm run check --workspace @nothumanwork/pi-example
npm test --workspace @nothumanwork/pi-example
npm run pack:check
npm run test:scripts
npm run publish:package -- pi-example --dry-run
```

The dry run runs npm packaging lifecycle scripts but does not upload or require login. Review its file list for missing runtime files and accidental sensitive data. For a significant change also run the full root checks and tests. Verify reproducibility with `npm ci --ignore-scripts` when appropriate.

## Release handoff

Report the package name, files changed, checks actually run, and any remaining blockers. Do not claim that configuring a package publishes it. Only on an explicit release request:

```sh
npm login
npm run publish:package -- pi-example
```

The helper validates the workspace and scope, checks login using `npm whoami`, and publishes one public package to the npm registry. Being logged in does not guarantee scope permission; npm still enforces organization access, version uniqueness, and any 2FA requirements. Never read or print npm tokens. Later releases need a new version; use `npm version patch --workspace @nothumanwork/pi-example --no-git-tag-version` only when a version bump is requested, and include the shared lockfile change.
