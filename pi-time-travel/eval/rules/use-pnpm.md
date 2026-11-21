---
description: The project's package manager is pnpm
condition: '(?:^|[\n;&|(]|\$\(|\b(?:sudo|exec|time|env)\s|\b[A-Z_][A-Z0-9_]*=\S*\s)\s*(?:npm\s+(?![^\n;&|]*\s(?:-g|--global|--location=global)(?=\s|$|[;&|)]))(?:i|in|install|add|ci|un|uninstall|rm|remove|r|update|up|upgrade)(?=\s|$|[;&|)])|yarn(?:\s+(?:add|install|remove|upgrade|up)(?=\s|$|[;&|)])|\s*$|\s*[\n;&|)]))'
scope: tool:bash
---
This project uses pnpm, and only pnpm, to manage dependencies: `pnpm add <pkg>` (`-D` for dev), `pnpm remove <pkg>`, `pnpm install`. Never install, add, remove, or update the project's packages with npm or yarn: a second lockfile breaks the build. If `pnpm` is not on PATH, run it through corepack (`corepack pnpm add <pkg>`) or install it globally (`npm i -g pnpm`) rather than falling back to npm. Running scripts with `npm test` or `pnpm test` is fine.
