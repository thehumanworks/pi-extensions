{
  description = "Local-first bot runtime and native web application";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          bot = (pkgsFor system).callPackage ./packages/runtime/nix/package.nix { };
          bot-web = (pkgsFor system).callPackage ./nix/web/package.nix { };
        in
        {
          inherit bot bot-web;
          default = bot;
        }
      );

      apps = forAllSystems (
        system:
        let
          bot = {
            type = "app";
            program = "${self.packages.${system}.bot}/bin/bot";
            meta.description = "Directory-defined bots powered by Pi";
          };
          web = {
            type = "app";
            program = "${self.packages.${system}.bot-web}/bin/bot-web";
            meta.description = "Native web UI with embedded Next.js assets";
          };
        in
        {
          inherit bot web;
          bot-web = web;
          default = bot;
        }
      );

      overlays.default = final: _prev: {
        bot = final.callPackage ./packages/runtime/nix/package.nix { };
        bot-web = final.callPackage ./nix/web/package.nix { };
      };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = self.packages.${system}.bot.runtimeInputs ++ [
              pkgs.git
              pkgs.bun
              pkgs.ast-grep
              pkgs.nixfmt
              pkgs.prefetch-npm-deps
            ];
          };
        }
      );

      checks = forAllSystems (system: {
        # Includes type checking, the offline test suite and installed-CLI smoke tests.
        default = self.packages.${system}.bot;
        web = self.packages.${system}.bot-web;
      });

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
