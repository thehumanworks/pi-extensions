{
  description = "Directory-defined bots powered by Pi";

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
          bot = (pkgsFor system).callPackage ./nix/package.nix { };
        in
        {
          inherit bot;
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
        in
        {
          inherit bot;
          default = bot;
        }
      );

      overlays.default = final: _prev: {
        bot = final.callPackage ./nix/package.nix { };
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
              pkgs.nixfmt
              pkgs.prefetch-npm-deps
            ];
          };
        }
      );

      checks = forAllSystems (system: {
        # Includes type checking, the offline test suite and installed-CLI smoke tests.
        default = self.packages.${system}.bot;
      });

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
