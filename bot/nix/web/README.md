# Native web Nix package

This build-only workspace packages **bot-web**, separate from both
`packages/runtime/nix` and the parent repository's npm workspace. It includes
only `packages/ai-sdk` and `apps/web`. The final installation is a Bun-compiled
ELF at `$out/bin/bot-web`, with embedded Next production assets and the adapter
HTTP host. There is no Node/Bun/Next executable, `node_modules`, source checkout,
asset tree, daemon, provider SDK or JavaScript launcher installed alongside it.
Normal Nix shared-library references still apply.

## Build and run

From `bot/`:

```sh
nix run "path:$PWD#web"                    # http://[::1]:3001
nix run "path:$PWD#web" -- --help
nix build "path:$PWD#bot-web"              # result/bin/bot-web
./result/bin/bot-web --host ::1 --port 3001
```

`#bot-web` is also an app alias. The default and `#bot` remain the independent
runtime CLI. Start the daemon separately (normally `http://[::1]:8787`).
`BOT_SERVER_URL`, `BOT_SERVER_TOKEN` and optional `BOT_UI_ORIGIN` are server-only
runtime configuration; no provider credentials are needed by this build or UI.
See [the UI guide](../../apps/web/README.md) for configuration and access control.
Nothing installs or starts a service.

Use `path:` before new source files have been committed: Git flake sources only
include tracked files. The package builds natively on `x86_64-linux` and
`aarch64-linux`; validation here uses x86-64. It does not download a foreign Bun
runtime or cross-compile. Nix-built ELFs use Nix's normal shared-library closure;
copying only the executable to a non-Nix system is not a portable deployment.
Build with upstream Bun on that platform for a non-Nix deployment.

## Isolated build

`postPatch` substitutes this directory's private manifest and lock at the
filtered source root. The build runs:

```sh
npm run build --workspace @nothumanwork/bot-ai-sdk
npm run build:native --workspace @nothumanwork/bot-ui
```

The second command statically exports the existing Next frontend and compiles
its Bun host with embedded files into `apps/web/dist/bot-web`. It uses the local
Nix-provided Bun executable, not a target runtime downloaded during compilation.
The native build leaves the normal Next server production build untouched.

The source fileset includes UI/adapter sources, native host, public assets,
build scripts, tests and configs. It excludes runtime sources, old outputs,
state, dotenv files, `.next`, `.build`, `dist` and `node_modules`. If a build input
is added outside these directories, extend the fileset. Next telemetry is off;
npm runs offline during the sandbox build. Fonts, browsers and foreign runtimes
must not be downloaded there. All npm downloads belong to the fixed-output
dependency derivation.

**`dontStrip = true` is essential:** GNU `strip` removes Bun's appended compiled
application payload, silently leaving plain Bun. Nix ELF RPATH fixup preserves
that payload; the installed-binary smoke runs after fixup to catch regressions.
Do not substitute a shell wrapper around `next start` or a JS runtime.

## Lock maintenance

After changing `apps/web/package.json`, `packages/ai-sdk/package.json` or this
private build manifest, run from `bot/`:

```sh
nix develop "path:$PWD" --command bash nix/web/update-lock.sh
# Copy the printed npmDepsHash into nix/web/package.nix.
nix build "path:$PWD#bot-web"
nix flake check "path:$PWD"
```

The updater stages only the three manifests with the **same relative workspace
layout**, seeds the previous isolated lock when present, and runs
`npm install --package-lock-only --ignore-scripts --legacy-peer-deps` in a
separate temporary directory. A first run gets a local workspace-link seed.
It never copies the parent/runtime lock, installs `node_modules`, runs lifecycle
scripts or changes parent manifests. It validates workspace links, excludes the
runtime package, prefetches the cache, then replaces this isolated lock and
prints the new hash. Review the manifest, lock and hash together. Resolve/prefetch
requires network; the subsequent sandbox build does not. Parent development
lockfiles must be updated separately when dependencies change. Because the
repository uses legacy peer handling, required peers such as Zod must be
explicit UI dependencies, not accidentally supplied by another workspace.

Pure helper checks (no dependency resolution, install or network):

```sh
node --test nix/web/prepare-lock.test.mjs
bash -n nix/web/update-lock.sh
node --check nix/web/smoke-test.mjs
```

## Checks

The package runs adapter/UI typechecks and tests, plus `bun test native/test`.
They use injected/offline backends, never real provider credentials. Its install
check uses Node **as a test harness only** to verify: an actual ELF, help/version,
a fresh working directory with empty `PATH` and no inherited tokens, embedded
HTML and a Next asset, HEAD, safe API 404, and graceful SIGTERM. Tests bind IPv6
loopback; no daemon or provider is started by the smoke harness.

For the full browser acceptance suite against the Nix artifact, after installing
workspace development dependencies and providing system Chromium:

```sh
binary="$(nix build "path:$PWD#bot-web" --no-link --print-out-paths)/bin/bot-web"
BOT_TEST_WEB_BINARY="$binary" npm run test:native
```

This suite starts a temporary scripted durable daemon, not a live model. It
covers tools, streaming, persisted history, continuation, disconnect/resume,
queued-run reload, explicit cancellation, mobile layout and safe errors. The
same suite also targets the normal Next host. `CHROMIUM_PATH` overrides the
browser executable; the tests never download a browser or install system tools.
