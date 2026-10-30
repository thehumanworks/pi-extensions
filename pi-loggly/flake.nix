{
  inputs = {
    utils.url = "github:numtide/flake-utils";
  };
  outputs =
    {
      self,
      nixpkgs,
      utils,
    }:
    utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShell = pkgs.mkShell {
          buildInputs = with pkgs; [
            bash
            nodejs_22
            pnpm
            dotenvx
            gh
            git
          ];

          GH_HOST = "leadforensics.ghe.com";

          shellHook = ''
            pnpm --version
            set -a; source <(dotenvx decrypt --stdout); set +a;
            export PS1="[Advanced Filters] $PS1"
          '';
        };
      }
    );
}
