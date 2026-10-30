{
  lib,
  buildNpmPackage,
  nodejs_24,
  bash,
  coreutils,
  git,
  which,
}:
let
  manifest = lib.importJSON ../package.json;
  runtimeInputs = [
    nodejs_24
    bash
    coreutils
    git
    which
  ];
in
buildNpmPackage {
  pname = "workflow";
  inherit (manifest) version;
  nodejs = nodejs_24;

  # Build only this workspace, never local node_modules, dist or user state.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../index.ts
      ../bin
      ../src
      ../test
      ../examples
      ../README.md
      ../LICENSE
      ../package.json
      ../tsconfig.json
      ../tsconfig.build.json
      ./package-lock.json
    ];
  };

  postPatch = ''
    cp nix/package-lock.json package-lock.json
  '';

  npmDepsHash = "sha256-Sw0WmE2Wm0C3/OXVmvtO0CkfmK8D8YO6Wz/2+lLd6Ns=";
  # Match the repository's peer-dependency policy.
  npmFlags = [ "--legacy-peer-deps" ];
  # The build phase already compiled dist; do not run prepack a second time.
  npmPackFlags = [ "--ignore-scripts" ];

  nativeCheckInputs = runtimeInputs;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export HOME="$TMPDIR/check-home"
    export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
    export PI_OFFLINE=1
    export npm_config_offline=true
    mkdir -p "$PI_CODING_AGENT_DIR"
    # npm pack in the source-only fixture writes to its cache. Keep the fetched
    # dependency cache immutable and restore it for the later npm prune phase.
    (
      export npm_config_cache="$TMPDIR/check-npm-cache"
      npm run check
      node --experimental-strip-types --test test/*.test.ts
    )
    runHook postCheck
  '';

  # Preserve the caller's tools; workers inherit this PATH, including Node 24.
  makeWrapperArgs = [
    "--prefix"
    "PATH"
    ":"
    (lib.makeBinPath runtimeInputs)
  ];

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    node ${./smoke-test.mjs} "$out/bin/workflow"
    runHook postInstallCheck
  '';

  passthru = { inherit runtimeInputs; };

  meta = {
    inherit (manifest) description;
    homepage = "https://github.com/thehumanworks/pi-extensions/tree/main/pi-orchestration";
    license = lib.licenses.mit;
    mainProgram = "workflow";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
