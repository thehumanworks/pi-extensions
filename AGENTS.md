# pi-extensions

npm-workspace monorepo of independently versioned Pi extensions (`@nothumanwork/pi-*`). See `README.md` for commands and publishing.

## Version bumps are part of every package change

Any change to what a package publishes (its code, `src/`, `README.md`, or anything else in its `files`) includes a semver bump of that package in the same change, so `scripts/publish-updated.mjs` picks it up. Follow `.agents/skills/maintain-npm-packages/SKILL.md`.

## Skills

Agent skills live in `.agents/skills/`; `.claude/skills` links to them.
