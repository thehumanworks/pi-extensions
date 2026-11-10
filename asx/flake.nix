{
  description = "Durable multi-agent workflows for Pi and the command line";

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
          asx = (pkgsFor system).callPackage ./nix/package.nix { };
        in
        {
          inherit asx;
          default = asx;
        }
      );

      apps = forAllSystems (
        system:
        let
          asx = {
            type = "app";
            program = "${self.packages.${system}.asx}/bin/asx";
            meta.description = "Durable multi-agent workflows for Pi and the command line";
          };
        in
        {
          inherit asx;
          default = asx;
        }
      );

      overlays.default = final: _prev: {
        asx = final.callPackage ./nix/package.nix { };
      };

      homeManagerModules.default = import ./nix/home-manager.nix;

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = self.packages.${system}.asx.runtimeInputs ++ [
              pkgs.nixfmt
              pkgs.prefetch-npm-deps
            ];
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          asx = self.packages.${system}.asx;
          editor = pkgs.callPackage ./nix/neovim.nix { inherit asx; };
        in
        {
          # Includes type checking, the offline test suite and installed-CLI smoke tests.
          default = asx;
          neovim = pkgs.runCommand "asx-neovim-check" { nativeBuildInputs = [ pkgs.neovim-unwrapped ]; } ''
            export HOME="$TMPDIR/home"
            export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
            mkdir -p "$PI_CODING_AGENT_DIR"
            nvim --headless -u NONE -i NONE -l ${./nix/neovim/smoke-test.lua} ${editor}
            touch "$out"
          '';
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
