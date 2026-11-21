---
description: No destructive force pushes; leases are implicit
condition:
  - '\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s(?:-f|--force|-[a-zA-Z]*f[a-zA-Z]*)(?=\s|$|[;&|])'
  - '\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s\+[\w./:-]+'
  - '\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s--force-with-lease=[^\s:]+:'
scope: tool:bash
---
Never force-push with `--force`, `-f`, or a `+refspec`, and never give `--force-with-lease` an explicit expected commit: a value read from the remote (for example from `git ls-remote`) makes it a blind force push that silently overwrites commits other people pushed. To update a branch you rebased or amended, run `git push --force-with-lease --force-if-includes origin <branch>`, with no `=` value. If that is rejected, someone else pushed to the branch: run `git fetch origin`, look at their commits with `git log <branch>..origin/<branch>`, rebase your branch onto `origin/<branch>` so their commits are kept, and push again the same way.
