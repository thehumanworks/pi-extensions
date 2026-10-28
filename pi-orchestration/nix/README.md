# Nix

The flake lives in **`pi-orchestration/`**, not the monorepo root. Enable Nix's
`nix-command` and `flakes` experimental features. The initial supported systems
are `x86_64-linux` and `aarch64-linux`; Darwin is not currently advertised because
the worker and process-lifecycle checks target Linux.

## Run or install

From a checkout:

```sh
cd pi-orchestration
nix run . -- --help
nix build .                         # result/bin/workflow
nix profile add .#workflow           # install for the current user
```

Without a checkout:

```sh
nix run 'github:thehumanworks/pi-extensions?dir=pi-orchestration' -- --help
nix profile add 'github:thehumanworks/pi-extensions?dir=pi-orchestration#workflow'
```

The package compiles TypeScript from source with pinned, standalone npm
dependencies. Its wrapper supplies Node 24, Bash, coreutils, Git and `which`,
including for detached workers. It prefixes rather than replaces the inherited
`PATH`; install other tools your workflows need separately. No global Node,
`npm install -g`, or `pi` executable is required to run the packaged CLI. This
installs `workflow`, not Pi itself, and does not register the extension in Pi;
see the [main README](../README.md#install-and-first-run) for Pi installation.

Installation does **not** start a worker, enable a service or arrange startup
at login/boot. Workers still start lazily when a command needs one. It does
**not** set `PI_WORKFLOW_ALLOW_UNATTENDED`, change `workflow.approval`, or bypass
launch approval. Headless launches remain an explicit user opt-in after
reviewing the workflow. Workflow code and agent tools are trusted host code,
not sandboxed by installing through Nix.

## State and credentials

Keep project files, workflow definitions, run databases, sockets, logs and
worktrees in writable directories **outside the Nix store**. The default run
home is `~/.pi/agent/workflow-runs`, respecting `PI_CODING_AGENT_DIR`. Override
it with `PI_WORKFLOW_HOME` or `--home`, for example:

```sh
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export PI_WORKFLOW_HOME="$HOME/.local/state/pi-workflow"
mkdir -p "$PI_CODING_AGENT_DIR" "$PI_WORKFLOW_HOME"
# Run from a writable project checkout, not result/ or /nix/store/:
workflow init review --cwd "$HOME/projects/example"
workflow guide
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

Add this input to your existing flake and accept `workflow` in its `outputs`
arguments:

```nix
inputs.workflow.url = "github:thehumanworks/pi-extensions?dir=pi-orchestration";
```

Use `workflow.packages.${system}.default` (or `.workflow`) wherever a package
is expected. An optional
`inputs.workflow.inputs.nixpkgs.follows = "nixpkgs";` shares your Nixpkgs pin;
omitting it uses this package's pin. An overridden pin must provide Node 24 and
the Nixpkgs Node build helpers used by `nix/package.nix`.

### NixOS

Add this module to your existing `nixosSystem.modules` list:

```nix
({ pkgs, ... }: {
  environment.systemPackages = [
    workflow.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
})
```

The example captures the flake input from the enclosing scope. For a separate
module file, pass `specialArgs = { inherit workflow; };` to `nixosSystem` and
accept `workflow` in the module's arguments.

### Home Manager

The same input can be installed in a Home Manager configuration:

```nix
({ pkgs, ... }: {
  home.packages = [
    workflow.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
})
```

For a separate Home Manager module, pass
`extraSpecialArgs = { inherit workflow; };` and accept `workflow` in its
arguments. With Home Manager's NixOS module, use
`home-manager.extraSpecialArgs = { inherit workflow; };` instead.

These examples only install the CLI. No dedicated NixOS/Home Manager module is
needed; no daemon, startup hook, port, credential or approval policy is enabled.

### Overlay

To use `pkgs.workflow`, apply `workflow.overlays.default` to your package set:

```nix
nixpkgs.overlays = [ workflow.overlays.default ];
# NixOS:
environment.systemPackages = [ pkgs.workflow ];
# Home Manager, with the overlay applied to its pkgs:
# home.packages = [ pkgs.workflow ];
```

The overlay builds against the receiving package set rather than the flake's
own Nixpkgs pin.

## Development and checks

From the **repository root**:

```sh
nix develop ./pi-orchestration
npm ci --ignore-scripts
npm run check --workspace @nothumanwork/pi-orchestration
npm test --workspace @nothumanwork/pi-orchestration
```

Or enter with `nix develop` from `pi-orchestration/`. This temporary shell
provides Node/npm, runtime tools, `nixfmt` and `prefetch-npm-deps`; no global npm
tool installation is necessary. It does not install dependencies, start a
worker, or run scripts automatically. Ordinary monorepo development continues
to use the root workspace lockfile.

From **`pi-orchestration/`**:

```sh
nix flake check                         # build, type check, offline tests, installed smoke test
nix flake check --all-systems --no-build # evaluate both supported systems
nix fmt -- flake.nix nix/package.nix
```

The build runs `npm run check` and
`node --experimental-strip-types --test test/*.test.ts` with writable, isolated
`HOME` and `PI_CODING_AGENT_DIR`, offline and without provider credentials.
The installed-CLI smoke test invokes `nix/smoke-test.mjs` against
`$out/bin/workflow`, not the build tree, using isolated state and no host PATH.
No check needs a real model request. Dependency downloads happen separately
through the fixed-output npm cache fetcher.

Nix's Git flake source only includes tracked files. For newly added, untracked
flake files, use `nix build path:.`, `nix develop path:.`, or
`nix flake check path:.` until they are tracked.

## Updating pins

- `pi-orchestration/flake.lock` pins Nixpkgs.
- `pi-orchestration/nix/package-lock.json` pins this package's standalone npm
  dependency graph, separate from the root workspace lockfile. No sibling
  extensions or their dependencies are needed by the Nix build.
- `npmDepsHash` in `pi-orchestration/nix/package.nix` pins the fetched npm cache.

After changing `package.json` dependencies (including peers) or version, run
from **`pi-orchestration/`**:

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
