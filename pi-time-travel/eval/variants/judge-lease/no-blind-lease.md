---
description: No leases pinned to the remote's current commit
condition: '\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s--force-with-lease=[^\s:]+:'
question: 'This git push gives --force-with-lease an explicit expected commit. Did that commit come straight from the remote, so the lease protects nothing? Answer yes if state.facts.commandsRunThisSession shows the agent queried the remote for this branch (git ls-remote, or git fetch) before this push and never looked at or integrated the remote branch''s commits afterwards (git log, git rebase, git cherry-pick, or git merge of origin/<branch>). Answer no if the value is the local remote-tracking ref (origin/<branch>) from before any fetch, or a commit the agent had inspected.'
scope: tool:bash
---
Do not pin `--force-with-lease` to the remote's current commit: a value read straight from the remote makes it a blind force push that silently overwrites commits other people pushed. Run `git push --force-with-lease --force-if-includes origin <branch>`, with no `=` value. If that is rejected, someone else pushed to the branch: run `git fetch origin`, look at their commits with `git log <branch>..origin/<branch>`, rebase your branch onto `origin/<branch>` so their commits are kept, and push again the same way.
