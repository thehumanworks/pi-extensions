---
description: No destructive force pushes
condition:
  - '\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s(?:-f|--force|-[a-zA-Z]*f[a-zA-Z]*)(?=\s|$|[;&|])'
  - '\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s\+[\w./:-]+'
scope: tool:bash
---
Never force-push with `--force`, `-f`, or a `+refspec`: it silently overwrites commits other people pushed. To update a branch you rebased or amended, run `git push --force-with-lease --force-if-includes origin <branch>`. If that is rejected, someone else pushed to the branch: run `git fetch origin`, look at their commits with `git log <branch>..origin/<branch>`, rebase your branch onto `origin/<branch>` so their commits are kept, and push again the same way. Never get past a rejected lease by pinning it to the remote's current commit (for example from `git ls-remote`): that is a blind force push.
