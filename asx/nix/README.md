# Nix

The flake lives in **`asx/`**, not the monorepo root. Enable Nix's
`nix-command` and `flakes` experimental features. The initial supported systems
are `x86_64-linux` and `aarch64-linux`; Darwin is not currently advertised because
the worker and process-lifecycle checks target Linux.

## Run or install

From a checkout:

```sh
cd asx
nix run . -- --help
nix build .                         # result/bin/asx
nix profile add .#asx               # install for the current user
```

Without a checkout:

```sh
nix run 'github:thehumanworks/pi-extensions?dir=asx' -- --help
nix profile add 'github:thehumanworks/pi-extensions?dir=asx#asx'
```

The package compiles TypeScript from source with pinned, standalone npm
dependencies. Its wrapper supplies Node 24, Bash, coreutils, Git and `which`,
including for detached workers. It prefixes rather than replaces the inherited
`PATH`; install other tools your workflows need separately. No global Node,
`npm install -g`, or `pi` executable is required to run the packaged CLI. This
installs `asx`, not Pi itself, and does not register the extension in Pi;
see the [main README](../README.md#install-and-first-run) for Pi installation.

Installation does **not** start a worker, enable a service or arrange startup
at login/boot. Workers still start lazily when a command needs one. Launches
start immediately, including in headless sessions. Review workflows before
running them: workflow code and agent tools are trusted host code, not
sandboxed by installing through Nix.

## State and credentials

Keep project files, workflow definitions, run databases, sockets, logs and
worktrees in writable directories **outside the Nix store**. The default run
home is `~/.pi/agent/asx`, respecting `PI_CODING_AGENT_DIR`. Override
it with `ASX_HOME` or `--home`, for example:

```sh
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export ASX_HOME="$HOME/.local/state/asx"
mkdir -p "$PI_CODING_AGENT_DIR" "$ASX_HOME"
# Run from a writable project checkout, not result/ or /nix/store/:
asx init review --cwd "$HOME/projects/example"
asx guide
```

Use a reasonably short state path because Unix sockets have a path-length
limit. Runs and tool transcripts can contain sensitive project data; preserve
private permissions and choose your backup policy accordingly.

Credentials and model configuration come from the invoking user's Pi
configuration (`PI_CODING_AGENT_DIR`, normally `~/.pi/agent`) or provider
environment variables. Installation does not create, copy or configure
credentials. Never put API keys, `auth.json`, or other secrets in flake inputs,
derivations, checked-in Nix strings, or the package source: Nix store contents
are generally readable by other local users. Supply credentials at runtime via
private user configuration or your existing secret-management mechanism.
A detached worker inherits the environment of the caller that starts it;
stop/restart it after changing credentials, models, or runtime environment.

## Use from another flake

Add this input to your existing flake and accept `asx` in its `outputs`
arguments:

```nix
inputs.asx.url = "github:thehumanworks/pi-extensions?dir=asx";
```

Use `asx.packages.${system}.default` (or `.asx`) wherever a package
is expected. An optional
`inputs.asx.inputs.nixpkgs.follows = "nixpkgs";` shares your Nixpkgs pin;
omitting it uses this package's pin. An overridden pin must provide Node 24 and
the Nixpkgs Node build helpers used by `nix/package.nix`.

### NixOS

Add this module to your existing `nixosSystem.modules` list:

```nix
({ pkgs, ... }: {
  environment.systemPackages = [
    asx.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
})
```

The example captures the flake input from the enclosing scope. For a separate
module file, pass `specialArgs = { inherit asx; };` to `nixosSystem` and
accept `asx` in the module's arguments.

### Home Manager

Import the module to install the CLI and optionally set up Neovim:

```nix
({ ... }: {
  imports = [ asx.homeManagerModules.default ];
  programs.asx = {
    enable = true;
    neovim.enable = true;
  };
})
```

For a separate Home Manager module, pass
`extraSpecialArgs = { inherit asx; };` and accept `asx` in its
arguments. With Home Manager's NixOS module, use
`home-manager.extraSpecialArgs = { inherit asx; };` instead.

The module builds against Home Manager's `pkgs`. To use the flake's package
instead, set
`programs.asx.package = asx.packages.${pkgs.stdenv.hostPlatform.system}.default;`.
Omit `neovim.enable` for the CLI alone. Installing the package directly in
`home.packages` also still works; editor configuration is opt-in.

#### Neovim workflow editing

The integration requires Neovim **0.11 or newer** and uses its native LSP client
with the standard TypeScript language server. It supplies the server, compiler
and types from Nix; no Mason installation, project `npm install` or generated
`tsconfig.json` is needed.

After `home-manager switch`, open a workflow in `.pi/workflows/` or the user's
`~/.pi/agent/workflows/` (`PI_CODING_AGENT_DIR` is respected). `ctx.` completion,
hover, go-to-definition and TypeScript diagnostics work immediately, including
types inferred from `Type.Object` argument and output schemas. Use Neovim's
normal completion UI or `<C-x><C-o>` and `K` for hover. `:checkhealth vim.lsp`
shows the attached server.

The runtime deliberately resolves `@nothumanwork/asx`, its recipes, `typebox`,
`@earendil-works/pi-durable` and `@earendil-works/pi-ai` from its own installation.
A small TypeScript language-service plugin gives the editor the same aliases
inside workflow files, even when a project has an older local dependency.
Other imports and project compiler settings remain intact. Standalone workflows
also receive Node types; a project's explicit `types` settings are respected.
Files are never written into the project or the Nix store during editing.

If native `ts_ls` is already enabled in `init.lua`, the integration adds the
plugin to that configuration, preserving its callbacks, roots and capabilities.
If native `vtsls` is enabled instead, it adds the plugin there and does not enable
`ts_ls`. Otherwise, it enables `ts_ls` only for workflow directories, leaving
ordinary TypeScript files alone. Configure existing servers through
`vim.lsp.config()` / `vim.lsp.enable()` before plugins load; legacy
`require("lspconfig").setup()` and servers started later by a lazy loader are not
auto-detected. Restart Neovim after updating the Home Manager generation.

The editor checks TypeScript, including incorrect `ctx` calls and schema-derived
argument types. Continue using `asx validate` for asx's determinism and workflow
validation rules before running a workflow.

### Overlay

To use `pkgs.asx`, apply `asx.overlays.default` to your package set:

```nix
nixpkgs.overlays = [ asx.overlays.default ];
# NixOS:
environment.systemPackages = [ pkgs.asx ];
# Home Manager, with the overlay applied to its pkgs:
# home.packages = [ pkgs.asx ];
```

The overlay builds against the receiving package set rather than the flake's
own Nixpkgs pin.

## Development and checks

From the **repository root**:

```sh
nix develop ./asx
npm ci --ignore-scripts
npm run check --workspace @nothumanwork/asx
npm test --workspace @nothumanwork/asx
```

Or enter with `nix develop` from `asx/`. This temporary shell
provides Node/npm, runtime tools, `nixfmt` and `prefetch-npm-deps`; no global npm
tool installation is necessary. It does not install dependencies, start a
worker, or run scripts automatically. Ordinary monorepo development continues
to use the root workspace lockfile.

From **`asx/`**:

```sh
nix flake check                         # build, type check, tests, installed CLI and Neovim smoke tests
nix flake check --all-systems --no-build # evaluate both supported systems
nix fmt -- flake.nix nix/*.nix
```

The build runs `npm run check` and
`node --experimental-strip-types --test test/*.test.ts` with writable, isolated
`HOME` and `PI_CODING_AGENT_DIR`, offline and without provider credentials.
The installed-CLI smoke test invokes `nix/smoke-test.mjs` against
`$out/bin/asx`, not the build tree, using isolated state and no host PATH.
No check needs a real model request. Dependency downloads happen separately
through the fixed-output npm cache fetcher.

The Neovim check opens fresh project and global workflow files with no local
dependencies, asks the real language server for completions and diagnostics,
and verifies Node types, schema inference and ordinary missing-import errors.
It also checks an existing `ts_ls` configuration with custom paths and strict
compiler settings, including a stale local asx mapping, and verifies ordinary
TypeScript files do not receive workflow aliases.

Nix's Git flake source only includes tracked files. For newly added, untracked
flake files, use `nix build path:.`, `nix develop path:.`, or
`nix flake check path:.` until they are tracked.

## Updating pins

- `asx/flake.lock` pins Nixpkgs.
- `asx/nix/package-lock.json` pins this package's standalone npm
  dependency graph, separate from the root workspace lockfile. No sibling
  extensions or their dependencies are needed by the Nix build.
- `npmDepsHash` in `asx/nix/package.nix` pins the fetched npm cache.

After changing `package.json` dependencies (including peers) or version, run
from **`asx/`**:

```sh
nix develop --command bash nix/update-lock.sh
# Copy the printed hash into npmDepsHash in nix/package.nix.
nix flake check
```

The updater copies the manifest and, if present, the previous standalone lock
into a temporary directory. It resolves there using `--package-lock-only`,
`--ignore-scripts` and `--legacy-peer-deps`, retaining compatible existing pins.
It writes only the standalone lock back, never installs into the checkout, and
never changes the root workspace lockfile. It needs network access to resolve
and prefetch dependencies. Remove the standalone lock before running it when
you deliberately want to re-resolve all transitive dependencies.

Update the root workspace lock separately when changing workspace dependencies.
Commit the manifest, standalone lock and new hash together. The ordinary
`test/nix-lock.test.ts` regression test checks manifest fields, including peer
dependencies, and rejects workspace links or dependencies without registry
URLs and integrity hashes.

To update Nixpkgs:

```sh
nix flake update nixpkgs
nix flake check
```
