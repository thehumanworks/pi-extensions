#!/usr/bin/env bash
set -euo pipefail

# Run only after the coordinator has finalized both workspace manifests.
# This resolves metadata and fills the Nix download cache, but never installs
# node_modules or runs lifecycle scripts, and never touches any parent lock.
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
for tool in node npm prefetch-npm-deps; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
stage="$scratch/workspace"
node "$root/nix/web/prepare-lock.mjs" "$root" "$stage"
(
  cd -- "$stage"
  # cwd and prefix are both outside the checkout, so npm cannot discover the
  # real parent monorepo. Do not use --workspaces=false: that loses local links.
  npm install --prefix "$stage" --package-lock-only --ignore-scripts \
    --legacy-peer-deps --no-audit --no-fund
)
node --input-type=module - "$stage/package-lock.json" <<'NODE'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const lock = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.name, '@nothumanwork/bot-web-build');
assert.deepEqual(lock.packages[''].workspaces, ['packages/ai-sdk', 'apps/web']);
for (const [name, path] of [['bot-ai-sdk', 'packages/ai-sdk'], ['bot-ui', 'apps/web']]) {
  assert.deepEqual(lock.packages[`node_modules/@nothumanwork/${name}`], { resolved: path, link: true });
}
assert(!Object.keys(lock.packages).some(key => key === 'packages/runtime'
  || key.endsWith('node_modules/@nothumanwork/bot')), 'Runtime must not be in the web lock');
NODE

# Prefetch first: retain the previous isolated lock if resolution/prefetch fails.
printf '\nPrefetching the isolated web dependency cache…\n' >&2
hash=$(prefetch-npm-deps "$stage/package-lock.json")
if [[ "$hash" != sha256-* || "$hash" == *$'\n'* ]]; then
  printf 'Unexpected prefetch-npm-deps output: %s\n' "$hash" >&2
  exit 1
fi
cp -- "$stage/package-lock.json" "$root/nix/web/package-lock.json"
printf '\nUpdated nix/web/package-lock.json only. Set nix/web/package.nix to:\n\n'
printf '  npmDepsHash = "%s";\n\n' "$hash"
printf 'Then build the coordinator-wired package: nix build .#bot-web\n'
