# Nix

The flake lives in **`bot/`**, not the monorepo root. Enable Nix's
`nix-command` and `flakes` experimental features. Supported systems are
`x86_64-linux` and `aarch64-linux`; Darwin is not currently advertised because
the runtime uses Unix `flock` and its process-lifecycle tests target Linux.

## Run or install

From a checkout:

```sh
cd bot
nix run . -- --help
nix build .                         # result/bin/bot
nix profile add .#bot               # install for the current user
```

Without a checkout:

```sh
nix run 'github:thehumanworks/pi-extensions?dir=bot' -- --help
nix profile add 'github:thehumanworks/pi-extensions?dir=bot#bot'
```

The package compiles TypeScript from source with pinned npm dependencies. The
CLI wrapper supplies Node 24, `flock`, Bash, coreutils, `which`, `fd`, and
ripgrep, including for child workers. It preserves access to the caller's
remaining `PATH`; install any extra tools your bots need separately. No global
Node, npm install, or `pi` executable is needed to run the packaged CLI.

Provider credentials still come from the invoking user's Pi configuration
(or environment). Installation does **not** configure credentials or start a
service. Keep bot sources and state in writable directories outside the Nix
store, for example:

```sh
bot init "$HOME/bots/reviewer"
bot run "$HOME/bots/reviewer" --cwd "$PWD" --message "Review this project"
```

## Native web UI

The runtime stays independent of the UI. The same flake also exposes a separate
Bun-compiled native web application with embedded Next production assets:

```sh
# From bot/ (path: includes newly added, unstaged source files):
nix run "path:$PWD#web"                  # http://[::1]:3001
nix build "path:$PWD#bot-web"            # result/bin/bot-web
./result/bin/bot-web --help
```

Start the bot daemon separately on `http://[::1]:8787` (or configure
`BOT_SERVER_URL` on the web process). The UI does not use provider credentials,
start a daemon, or take ownership of its SQLite state. `#bot` and the default app
continue to be this Node-backed runtime CLI; the native UI adds no Next/React/AI
SDK dependency to it. The web binary needs no external JavaScript runtime or
asset directory. Native OS/Nix shared libraries still apply. See the
[web packaging guide](../../../nix/web/README.md) and
[UI operations guide](../../../apps/web/README.md).

## Use from another flake

Add this input to your existing flake:

```nix
inputs.bot.url = "github:thehumanworks/pi-extensions?dir=bot";
```

Then use `bot.packages.${system}.default` (or `.bot`) wherever a package is
expected. For example, a project shell:

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.bot.url = "github:thehumanworks/pi-extensions?dir=bot";

  outputs = { nixpkgs, bot, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = [ bot.packages.${system}.default ];
      };
    };
}
```

An optional `inputs.bot.inputs.nixpkgs.follows = "nixpkgs";` shares the caller's
Nixpkgs pin. Omitting it uses this package's tested pin. An overridden pin must
provide Node 24 and the Nixpkgs Node build helpers used by
`packages/runtime/nix/package.nix`.

### NixOS

Add the input above, accept `bot` in your flake's `outputs` arguments, and add
a module to your existing `nixosSystem.modules` list:

```nix
({ pkgs, ... }: {
  environment.systemPackages = [
    bot.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
})
```

This example captures the flake input in the module's enclosing scope. If you
put it in a separate module file, pass `bot` via `specialArgs = { inherit bot; };`
and accept it in that module's arguments.

### Home Manager

The same input can be installed in a Home Manager configuration:

```nix
({ pkgs, ... }: {
  home.packages = [
    bot.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
})
```

For a separate Home Manager module file, pass the input via
`extraSpecialArgs = { inherit bot; };` and accept `bot` in the module arguments.
With Home Manager's NixOS module, use
`home-manager.extraSpecialArgs = { inherit bot; };` instead.

No dedicated NixOS or Home Manager module is needed to install the CLI. These
examples only add the package; they do not enable a daemon or open any ports.

### Overlay

If you prefer `pkgs.bot`, add `bot.overlays.default` to your Nixpkgs overlays:

```nix
nixpkgs.overlays = [ bot.overlays.default ];
# NixOS:
environment.systemPackages = [ pkgs.bot ];
# Home Manager, with the overlay applied to its pkgs:
# home.packages = [ pkgs.bot ];
```

The overlay builds against the receiving package set rather than the flake's
own Nixpkgs pin.

## Development

From the **repository root**:

```sh
nix develop ./bot
npm ci
npm run check --workspace @nothumanwork/bot
npm run test --workspace @nothumanwork/bot
```

Or enter with `nix develop` from `bot/`. The shell provides Node/npm, runtime
tools, Bun, ast-grep, Git, `nixfmt`, and `prefetch-npm-deps`. It does not install dependencies
or run scripts automatically; the normal development workflow still uses the
root npm workspace lockfile.

From **`bot/`**:

```sh
nix flake check                     # runtime + native web builds, checks and smoke tests
nix flake check --all-systems --no-build  # evaluate both supported systems
nix fmt -- flake.nix packages/runtime/nix/package.nix nix/web/package.nix
```

The installed-CLI smoke test starts with an empty `PATH` and isolated user
configuration. It exercises init/validate/info, a real worker and SQLite
runtime, shell/find/grep tool calls, and session listing without provider calls.

Nix's Git flake source only includes tracked files. After adding new files,
stage them before using `nix build .`, or use `nix build path:.` to test an
unstaged checkout. Likewise, `nix develop path:.` and
`nix flake check path:.` work before the new flake files are staged.

## Updating pins

- `bot/flake.lock` pins Nixpkgs.
- `bot/packages/runtime/nix/package-lock.json` pins the standalone runtime build.
  It is deliberately separate from workspace lockfiles, so the runtime build
  never needs the AI SDK adapter, Next.js application, or sibling extensions.
- `bot/nix/web/package-lock.json` and its own `npmDepsHash` independently pin the
  native UI/adapter build. See that directory's updater; never mix the two locks.
- `npmDepsHash` in `bot/packages/runtime/nix/package.nix` pins the fetched npm cache.

After changing `bot/packages/runtime/package.json` dependencies or version,
run from **`bot/`**:

```sh
nix develop --command bash packages/runtime/nix/update-lock.sh
# Copy the printed hash into packages/runtime/nix/package.nix.
nix flake check
```

The updater resolves in a temporary directory, retaining existing compatible
pins, and never changes workspace lockfiles or installs into the checkout. Remove
`packages/runtime/nix/package-lock.json` before running it to deliberately
re-resolve all transitive dependencies. Update the root workspace lockfile separately when
changing workspace dependencies. Commit the manifest, standalone lock and new
hash together; an ordinary test also checks that the standalone lock matches
the manifest.

To update Nixpkgs:

```sh
nix flake update nixpkgs
nix flake check
```
