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
          workflow = (pkgsFor system).callPackage ./nix/package.nix { };
        in
        {
          inherit workflow;
          default = workflow;
        }
      );

      apps = forAllSystems (
        system:
        let
          workflow = {
            type = "app";
            program = "${self.packages.${system}.workflow}/bin/workflow";
            meta.description = "Durable multi-agent workflows for Pi and the command line";
          };
        in
        {
          inherit workflow;
          default = workflow;
        }
      );

      overlays.default = final: _prev: {
        workflow = final.callPackage ./nix/package.nix { };
      };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = self.packages.${system}.workflow.runtimeInputs ++ [
              pkgs.nixfmt
              pkgs.prefetch-npm-deps
            ];
          };
        }
      );

      checks = forAllSystems (system: {
        # Includes type checking, the offline test suite and installed-CLI smoke tests.
        default = self.packages.${system}.workflow;
      });

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
