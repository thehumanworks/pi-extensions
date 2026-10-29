#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Resolve as a standalone package, not as part of the parent npm workspace.
# Seed with the previous lock to avoid upgrading unrelated transitive packages.
cp package.json "$tmp/package.json"
if [[ -f nix/package-lock.json ]]; then
  cp nix/package-lock.json "$tmp/package-lock.json"
fi
npm install --prefix "$tmp" --package-lock-only --ignore-scripts \
  --legacy-peer-deps --no-audit --no-fund
cp "$tmp/package-lock.json" nix/package-lock.json

printf '\nSet npmDepsHash in nix/package.nix to the following hash:\n'
prefetch-npm-deps nix/package-lock.json
