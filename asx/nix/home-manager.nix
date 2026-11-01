{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.asx;
in
{
  options.programs.asx = {
    enable = lib.mkEnableOption "asx durable agent workflows";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The asx package to install and use for workflow types.";
    };
    neovim.enable = lib.mkEnableOption "Neovim completion, hover and diagnostics for asx workflows";
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    programs.neovim = lib.mkIf cfg.neovim.enable {
      enable = lib.mkDefault true;
      extraPackages = [ pkgs.typescript-language-server ];
      plugins = [ (pkgs.callPackage ./neovim.nix { asx = cfg.package; }) ];
    };
    assertions = lib.optional cfg.neovim.enable {
      assertion =
        config.programs.neovim.enable && lib.versionAtLeast config.programs.neovim.package.version "0.11";
      message = "programs.asx.neovim.enable requires programs.neovim.enable and Neovim 0.11 or newer.";
    };
  };
}
