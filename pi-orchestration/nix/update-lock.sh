#!/usr/bin/env bash
set -euo pipefail

# Run with the temporary tool environment: nix develop --command bash nix/update-lock.sh
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Resolve as a standalone package, never in the parent npm workspace.
# Seed with the previous lock to retain compatible transitive pins.
cp package.json "$tmp/package.json"
if [[ -f nix/package-lock.json ]]; then
  cp nix/package-lock.json "$tmp/package-lock.json"
fi
(
  cd -- "$tmp"
  npm install --package-lock-only --ignore-scripts --workspaces=false \
    --legacy-peer-deps --no-audit --no-fund --cache "$tmp/npm-cache"
)
cp "$tmp/package-lock.json" nix/package-lock.json

printf '\nSet npmDepsHash in nix/package.nix to the following hash:\n'
prefetch-npm-deps nix/package-lock.json
