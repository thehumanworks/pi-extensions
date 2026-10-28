{
  description = "pi-bot: persistent Pi bots, their HTTP server and the desktop app";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      packages = forAll (pkgs:
        let
          inherit (pkgs) lib stdenv;
          # Libraries GPUI loads at run time on Linux (Vulkan or GL, Wayland or X11, fonts).
          gpuiRuntime = with pkgs; [ vulkan-loader wayland libxkbcommon libGL libx11 libxcb libxcursor libxi libxrandr fontconfig freetype ];
          desktop = pkgs.rustPlatform.buildRustPackage {
            pname = "pi-bot-desktop";
            inherit version;
            src = lib.cleanSource ./desktop;
            cargoLock.lockFile = ./desktop/Cargo.lock;
            nativeBuildInputs = [ pkgs.pkg-config ] ++ lib.optionals stdenv.hostPlatform.isLinux [ pkgs.makeWrapper ];
            buildInputs = lib.optionals stdenv.hostPlatform.isLinux gpuiRuntime
              ++ lib.optionals stdenv.hostPlatform.isDarwin [ pkgs.apple-sdk_15 ];
            # The GPUI test harness needs a display; unit tests run in `nix develop` instead.
            doCheck = false;
            postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
              wrapProgram $out/bin/pi-bot-desktop --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath gpuiRuntime}
            '';
            meta.mainProgram = "pi-bot-desktop";
          };
          # The HTTP server is TypeScript; build this package with its own lockfile
          # (package-lock.json here, regenerated with `npm run lock`) and run it with
          # Node and nixpkgs' Pi.
          server = pkgs.buildNpmPackage {
            pname = "pi-bot-server";
            inherit version;
            src = lib.cleanSourceWith {
              src = ./.;
              filter = path: _: !(lib.hasInfix "/desktop" path || lib.hasInfix "/research" path || lib.hasInfix "/node_modules" path || lib.hasInfix "/dist" path);
            };
            npmDepsHash = "sha256-zOdGe6SfpJYCO726QRxY9kQfZNQ47z3j6Ps+3tu6OAY=";
            nativeBuildInputs = [ pkgs.makeWrapper ];
            npmBuildScript = "build";
            # Pi's packages are peer dependencies that npm prunes away; link the
            # ones the server imports at runtime from the Pi it also spawns.
            postInstall = ''
              pi=$(dirname "$(grep -l '"name": "@earendil-works/pi-coding-agent"' ${pkgs.pi-coding-agent}/lib/node_modules/*/package.json | head -1)")
              modules=$out/lib/node_modules/@nothumanwork/pi-bot/node_modules
              mkdir -p $modules/@earendil-works
              ln -s "$pi" $modules/@earendil-works/pi-coding-agent
              for dep in pi-ai pi-tui; do
                ln -s "$pi/node_modules/@earendil-works/$dep" $modules/@earendil-works/$dep
              done
              ln -s "$pi/node_modules/typebox" $modules/typebox
              wrapProgram $out/bin/pi-bot-server --set-default PI_BOT_PI_COMMAND ${lib.getExe pkgs.pi-coding-agent}
            '';
            meta.mainProgram = "pi-bot-server";
          };
        in
        {
          inherit desktop server;
          default = desktop;
        });

      devShells = forAll (pkgs:
        let
          inherit (pkgs) lib stdenv;
          gpuiRuntime = with pkgs; [ vulkan-loader wayland libxkbcommon libGL libx11 libxcb libxcursor libxi libxrandr fontconfig freetype ];
        in
        {
          default = pkgs.mkShell {
            nativeBuildInputs = with pkgs; [ cargo rustc rustfmt clippy pkg-config nodejs_24 pi-coding-agent ];
            buildInputs = lib.optionals stdenv.hostPlatform.isLinux gpuiRuntime ++ lib.optionals stdenv.hostPlatform.isDarwin [ pkgs.apple-sdk_15 ];
            LD_LIBRARY_PATH = lib.optionalString stdenv.hostPlatform.isLinux (lib.makeLibraryPath gpuiRuntime);
            shellHook = ''
              echo "pi-bot dev shell: npm test (server), cd desktop && cargo test (app)"
            '';
          };
        });
    };
}
