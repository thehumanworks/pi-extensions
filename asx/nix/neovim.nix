{
  lib,
  vimUtils,
  typescript-language-server,
  typescript_5,
  asx,
}:
vimUtils.buildVimPlugin {
  pname = "asx-neovim";
  inherit (asx) version;
  src = ./neovim;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/after/plugin" "$out/node_modules/asx-tsserver-plugin"
    cp tsserver.cjs "$out/node_modules/asx-tsserver-plugin/index.cjs"
    printf '%s' ${
      lib.escapeShellArg (
        builtins.toJSON {
          name = "asx-tsserver-plugin";
          main = "index.cjs";
          asxPackage = "${asx}/lib/node_modules/@nothumanwork/asx";
        }
      )
    } > "$out/node_modules/asx-tsserver-plugin/package.json"
    substitute asx.lua "$out/after/plugin/asx.lua" \
      --replace-fail '@pluginLocation@' "$out" \
      --replace-fail '@languageServer@' '${lib.getExe typescript-language-server}' \
      --replace-fail '@tsserver@' '${typescript_5}/lib/node_modules/typescript/lib/tsserver.js'
    runHook postInstall
  '';
}
