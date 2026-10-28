{
  lib,
  buildNpmPackage,
  nodejs_24,
  bash,
  coreutils,
  fd,
  ripgrep,
  util-linux,
  which,
}:
let
  manifest = lib.importJSON ../package.json;
  runtimeInputs = [
    nodejs_24
    bash
    coreutils
    fd
    ripgrep
    util-linux
    which
  ];
in
buildNpmPackage {
  pname = "bot";
  inherit (manifest) version;
  nodejs = nodejs_24;

  # Only this workspace is needed; never copy node_modules, dist or bot state.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../bin
      ../src
      ../test
      ../package.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../README.md
      ./package-lock.json
    ];
  };

  postPatch = ''
    cp nix/package-lock.json package-lock.json
  '';

  npmDepsHash = "sha256-6LQfkA7IHwhLR1HQQqir23igVjHa+Rz2WzYAMgsN4eA=";
  # Match the repository's peer-dependency policy.
  npmFlags = [ "--legacy-peer-deps" ];
  # The build phase already compiled dist; do not run prepack a second time.
  npmPackFlags = [ "--ignore-scripts" ];

  nativeCheckInputs = runtimeInputs;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export PI_CODING_AGENT_DIR="$TMPDIR/pi-agent"
    export PI_OFFLINE=1
    npm run check
    node --import tsx --test test/*.test.ts
    runHook postCheck
  '';

  # The wrapper's PATH is inherited by SDK-owned workers and their tools.
  makeWrapperArgs = [
    "--prefix"
    "PATH"
    ":"
    (lib.makeBinPath runtimeInputs)
  ];

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    node ${./smoke-test.mjs} "$out/bin/bot" "${manifest.version}"
    runHook postInstallCheck
  '';

  passthru = { inherit runtimeInputs; };

  meta = {
    inherit (manifest) description;
    homepage = "https://github.com/thehumanworks/pi-extensions/tree/main/bot";
    mainProgram = "bot";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
