{
  lib,
  buildNpmPackage,
  nodejs_24,
  bun,
}:
let
  root = ../..;
  manifest = lib.importJSON ../../apps/web/package.json;
  optional = lib.fileset.maybeMissing;
in
buildNpmPackage {
  pname = "bot-web";
  inherit (manifest) version;
  nodejs = nodejs_24;

  # Deliberately not the parent monorepo: no runtime, provider SDK, old build
  # output, node_modules, dotenv files, daemon state or checkout metadata.
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../../packages/ai-sdk/src
      ../../packages/ai-sdk/test
      ../../packages/ai-sdk/package.json
      ../../packages/ai-sdk/tsconfig.json
      ../../packages/ai-sdk/tsconfig.build.json
      ../../apps/web/app
      ../../apps/web/components
      ../../apps/web/lib
      ../../apps/web/test
      (optional ../../apps/web/native)
      (optional ../../apps/web/scripts)
      (optional ../../apps/web/public)
      ../../apps/web/package.json
      ../../apps/web/next.config.ts
      ../../apps/web/next-env.d.ts
      ../../apps/web/tsconfig.json
      ../../apps/web/tsconfig.native.json
      ./package.json
      (optional ./package-lock.json)
      ./smoke-test.mjs
    ];
  };

  postPatch = ''
    if [ ! -f nix/web/package-lock.json ]; then
      echo 'Missing isolated web lock: run nix/web/update-lock.sh after finalizing workspace dependencies.' >&2
      exit 1
    fi
    cp nix/web/package.json package.json
    cp nix/web/package-lock.json package-lock.json
  '';

  # Isolated UI/adapter dependencies; never reuse the runtime's lock/hash.
  npmDepsHash = "sha256-LO4KbMs35w+2ivfLxYJqZDyN22fqkeiEkEB8mvG2K4I=";
  npmFlags = [ "--legacy-peer-deps" ];
  nativeBuildInputs = [ bun ];

  # buildNpmPackage's npm configure hook populates node_modules from its fixed
  # output cache; Next and Bun must not fetch anything in the sandbox build.
  env = {
    NEXT_TELEMETRY_DISABLED = "1";
    npm_config_offline = "true";
    BUN_INSTALL_CACHE_DIR = ".bun-cache";
  };

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    npm run build
    test -s apps/web/dist/bot-web
    test -x apps/web/dist/bot-web
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run check --workspace @nothumanwork/bot-ai-sdk
    npm run test --workspace @nothumanwork/bot-ai-sdk
    npm run check --workspace @nothumanwork/bot-ui
    npm run test --workspace @nothumanwork/bot-ui
    (cd apps/web && bun test native/test)
    runHook postCheck
  '';

  # Override npm's installation hook: the closure contains the native executable,
  # never a JS entrypoint, node_modules tree, or wrapper launching a JS runtime.
  installPhase = ''
    runHook preInstall
    install -Dm755 apps/web/dist/bot-web "$out/bin/bot-web"
    runHook postInstall
  '';

  # Bun stores the compiled application/assets after the ELF data. GNU strip
  # discards that payload and silently turns the output back into plain Bun.
  dontStrip = true;

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    node nix/web/smoke-test.mjs "$out/bin/bot-web" "${manifest.version}"
    runHook postInstallCheck
  '';

  meta = {
    description = "Native bot web UI with embedded static assets and HTTP adapter";
    homepage = "https://github.com/thehumanworks/pi-extensions/tree/main/bot";
    mainProgram = "bot-web";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
