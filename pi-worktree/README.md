# Git worktrees for Pi

A Pi extension that runs the agent inside a git worktree under
`<repo>/.pi/worktrees/<name>`, on a throwaway branch `pi/<name>`. The worktree
directory is added to the repository's local `.git/info/exclude`.

## Install

```sh
pi install npm:@nothumanwork/pi-worktree
```

## Use

| Entry point | Effect |
| --- | --- |
| `pi --worktree` / `pi -w` | Start in a new worktree with a generated name, e.g. `swift-cedar-river` |
| `pi --worktree=<name>` | Start in the named worktree, reusing or restoring it if it exists |
| `/worktree [name]` | Activate a worktree from inside a session |

Names use 1–64 letters, numbers, dots, underscores or hyphens, starting with a
letter or number.

While a worktree is active, `bash`, `read`, `write`, `edit`, `grep`, `find`,
`ls` and user `!cmd` commands run inside it, and the system prompt tells the
agent to create a feature branch and to push only when asked. On exit in an
interactive session, Pi asks whether to keep the worktree, remove it, or remove
it and delete the throwaway branch. Removal never forces; cancelling or the
10-second timeout keeps everything.

With `--ssh` (pi-ssh) active, worktree mode is disabled because both
extensions redirect the same tools.

## Requirements

`git` on `PATH` and a git repository as the working directory.
