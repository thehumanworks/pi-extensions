#!/usr/bin/env bash
# The brain loop. Every 5 minutes a fresh headless Pi session (a "tick") gets the
# rules below, BRAIN.md and every subagent ledger as its system prompt, takes one
# focused action towards the goal, records it in BRAIN.md, commits and pushes.
#
#   loop.sh [run]                one tick every BRAIN_INTERVAL seconds until brain/STOP exists
#   loop.sh once                 one tick, then exit
#   loop.sh prompt               print the next tick's system prompt and message
#   loop.sh spawn <name> <task>  start a subagent in its own worktree and herdr workspace
#   loop.sh retire <name>        close a finished subagent's workspace and worktree
#   loop.sh status               subagents, tick counter and STOP state
#
# Bash parses this whole file before main runs (see the last line), so editing it
# during a tick is safe. The loop re-executes the file after every tick, so edits
# apply from the next one; a file that fails `bash -n` falls back to the last good copy.

set -uo pipefail

WT=${BRAIN_WT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}
export BRAIN_WT=$WT
PKG=$WT/pi-orchestration
DIR=$PKG/brain
LOGS=$DIR/logs
LEDGER=$PKG/BRAIN.md
SCRIPT=$DIR/loop.sh
REPO=$(dirname "$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)")
BRANCH=brain/orchestration
SESSION=${BRAIN_HERDR_SESSION:-pi-brain}
INTERVAL=${BRAIN_INTERVAL:-300}
SOFT=${BRAIN_SOFT_MINUTES:-4}
HARD=${BRAIN_HARD_MINUTES:-10}
MAX_AGENTS=${BRAIN_MAX_AGENTS:-2}

# Ticks and subagents keep memory recall but never capture: BRAIN.md is their memory.
export PI_WORKFLOW_ALLOW_UNATTENDED=1 PI_MEMORY_CAPTURE=0 PI_MEMORY_DREAM=0

die() { echo "loop.sh: $*" >&2; exit 1; }
hd() { herdr --session "$SESSION" "$@"; }
git_wt() { git -C "$WT" "$@"; }

rules() {
  sed -e "s|@REPO@|$REPO|g" -e "s|@WT@|$WT|g" -e "s|@MAX@|$MAX_AGENTS|g" <<'EOF'
# You are the brain of the pi-orchestration improvement loop

pi-orchestration/brain/loop.sh starts a fresh, headless Pi session of you every 5 minutes. Each session is one tick. You remember nothing between ticks except what is written down: BRAIN.md and the subagent ledgers (both follow these rules in this system prompt) and the git history. Nobody watches live. The user reads the ledger and the commits later.

## Goal

Optimise what an agent sees and experiences when it uses pi-orchestration through either surface: the standalone `workflow` binary, isolated from Pi, and the Pi extension (the `workflow` tool and `/workflow`). Every tick ends with a positive, concrete step towards that goal, recorded in the ledger.

## A tick

1. Orient, in about a minute: read BRAIN.md, every subagent ledger and the facts in the message (git status, subagent states). Uncommitted changes left by a killed tick come first: finish and commit them, or discard them, and say which.
2. Choose ONE focused action with the best expected value. Go deeper on directions marked ✅. Rethink or drop directions marked ❌. When the backlog is thin or every direction is weak, widen it with research or ideation. Kinds of action:
   - a small change with tests, done yourself;
   - research: read the code, use the CLI or the tool the way an agent would, search the web (exa) for prior art;
   - ideation or critique with the advisor (ask_advisor; it cannot see files, so paste what it needs);
   - spawn a subagent for work too big for one tick;
   - review and merge a subagent's finished branch, or answer a blocked one.
3. Act within the deadline in the message: commit and push by then. The session is killed at the hard stop, and uncommitted work is left for the next tick.
4. Record it in BRAIN.md by appending to the end of the Log:
   ### Tick N · HH:MM · <short title>
   - Action: what you did, and why this over the alternatives.
   - Outcome: what happened, with evidence (test counts, commit hashes, file:line).
   - Value: ✅ yielded value | ⚠️ partial | ❌ no value
   - Lesson: what to repeat or avoid.
   Update Decisions, Agents, Backlog, Lessons and Questions for the user whenever they change.
5. Commit everything you changed with the subject `brain: tick N — <summary>`, then `git push origin brain/orchestration`. loop.sh pushes again after the tick and appends an AUTO entry, which counts as ❌, if you left no ledger entry.

## Subagents

- Spawn only with `pi-orchestration/brain/loop.sh spawn <name> "<task>"`. It creates the worktree @REPO@/.pi/worktrees/brain-<name> on branch brain/<name> from brain/orchestration, installs dependencies, writes the task into the subagent's ledger, pushes the branch, opens a workspace in the herdr session pi-brain and starts interactive Pi there with the subagent rules. The subagent outlives your tick. Spawning takes about a minute.
- At most @MAX@ at a time. Write tasks self-contained: goal, relevant files and lines, acceptance criteria including tests, the current test baseline, and what is out of scope.
- Their ledgers appear below every tick. Steer one with `herdr --session pi-brain agent prompt <name> "<message>"` (never --wait). Inspect one with `herdr --session pi-brain agent get <name>` or `herdr --session pi-brain agent read <name> --source recent-unwrapped --lines 80`.
- When a ledger says done: review `git diff brain/orchestration...brain/<name>`, run `npm test` in its worktree's pi-orchestration directory, and merge into brain/orchestration with `git merge --no-ff brain/<name>` only if the tests pass or are no worse than the baseline. Push, then run `pi-orchestration/brain/loop.sh retire <name>`, which refuses while anything is uncommitted or unpushed. Record the verdict.
- A subagent with no ledger progress for 3 ticks: read its pane, steer it once, and if that fails retire it and log ❌.

## Boundaries

- Change only this worktree (@WT@) and subagent worktrees. Read anything, but never modify the main checkout (@REPO@, which holds the user's uncommitted work), ~/.pi, /etc/nixos or other repositories.
- Push only brain/orchestration and brain/<name> branches. Never push to or merge into main, never force-push, never npm publish, never bump package versions. Merging to main happens at the end, with the user.
- Workflow files (.pi/workflows/*.ts) are project source: never add them to .gitignore.
- You may launch workflows without approval; PI_WORKFLOW_ALLOW_UNATTENDED=1 is set. Do not create scheduled loops: this script is the loop. Do not save memories: BRAIN.md is your memory.
- Verify before claiming: run `npm test` in pi-orchestration before committing code changes, and record failures honestly against the baseline in BRAIN.md.
- Put questions for the user in BRAIN.md under Questions for the user, and carry on with the best reversible choice meanwhile.
- Keep BRAIN.md under about 300 lines. When the Log passes 25 entries, move the oldest to pi-orchestration/brain/archive/<YYYY-MM-DD>.md and keep their lessons under Lessons.
- These rules are yours. Change them in the rules() function of pi-orchestration/brain/loop.sh when a lesson shows they should, and record why under Decisions. Changes apply from the next tick; keep `bash -n` passing.
- The user stops the loop by creating pi-orchestration/brain/STOP. Never create or delete it yourself.
EOF
}

subagent_rules() {  # <name> <worktree>
  sed -e "s|@NAME@|$1|g" -e "s|@PATH@|$2|g" <<'EOF'
# You are subagent "@NAME@" of the pi-orchestration brain

The brain is an autonomous loop that improves pi-orchestration (the standalone `workflow` CLI and the Pi extension) for the agents that use it. It gave you one task. It reads your ledger every 5 minutes and may send you messages. No human is watching.

- Worktree: @PATH@, branch brain/@NAME@, based on brain/orchestration. Work only here.
- Ledger: pi-orchestration/ledgers/@NAME@.md. Its task section is your brief. Keep its first line as `Status: working|blocked|done|failed — <one line>`. After every meaningful step, record what you did, the outcome, and what did or did not work; then commit and `git push origin brain/@NAME@`.
- Blocked: set `Status: blocked`, write the question in the ledger, commit, push and wait. The brain answers with a message.
- Done means the task's acceptance criteria are met, `npm test` in pi-orchestration passes (or the ledger explains each failure against the baseline in the task), everything is committed and pushed, and the ledger says `Status: done` with a summary of the change and how you verified it. Then stop and wait.
- Never push to or merge into main or brain/orchestration, never force-push, never npm publish, never bump package versions, and never modify anything outside your worktree (not ~/.pi, /etc/nixos or the main checkout).
- Workflow files (.pi/workflows/*.ts) are project source: never add them to .gitignore.
- The installed Pi workflow tool asks a human to approve launches, and none is watching. If you need a workflow, use the `workflow` CLI from bash; PI_WORKFLOW_ALLOW_UNATTENDED=1 is set.
- Do not save memories: your ledger is your memory.
EOF
}

agents() {  # name<TAB>worktree for every subagent worktree
  git_wt worktree list --porcelain | awk '
    /^worktree / { path = substr($0, 10) }
    /^branch refs\/heads\/brain\// { name = substr($0, 25); if (name != "orchestration") print name "\t" path }'
}

agent_state() {  # herdr's lifecycle state for a live subagent, or "gone"
  hd agent get "$1" 2>/dev/null | jq -er '.result.agent.agent_status' 2>/dev/null || echo gone
}

agent_table() {
  local name path any=
  while IFS=$'\t' read -r name path; do
    any=1
    printf -- '- %s: herdr %s, branch brain/%s, worktree %s, last commit %s\n' "$name" "$(agent_state "$name")" "$name" "$path" \
      "$(git -C "$path" log -1 --format='%h %cr: %s' 2>/dev/null)"
  done < <(agents)
  [[ $any ]] || echo "- none"
}

system_prompt() {  # the rules, then the ledger, then every subagent ledger
  rules
  printf '\n\n# BRAIN.md, your ledger (%s)\n\n' "$LEDGER"
  cat "$LEDGER"
  local name path
  while IFS=$'\t' read -r name path; do
    printf '\n\n# Subagent ledger: %s (%s/pi-orchestration/ledgers/%s.md)\n\n' "$name" "$path" "$name"
    cat "$path/pi-orchestration/ledgers/$name.md" 2>/dev/null || echo "(missing)"
  done < <(agents)
}

tick_message() {  # <tick>
  local started=$(date +%s)
  echo "Tick $1 started $(date -Is -d "@$started"). Commit and push by $(date -Is -d "@$((started + SOFT * 60))"); the session is killed at $(date -Is -d "@$((started + HARD * 60))")."
  echo "Worktree: $WT (branch $BRANCH). Main checkout, never modify: $REPO."
  bash -n "$SCRIPT" 2>/dev/null || echo "WARNING: $SCRIPT fails bash -n, so the loop is running its last good copy. Fix it this tick."
  printf '\ngit status --short:\n%s\n' "$(git_wt status --short | head -40)"
  printf '\nRecent commits:\n%s\n' "$(git_wt log --oneline -8)"
  printf '\nSubagents:\n%s\n' "$(agent_table)"
}

next_tick() {
  local saved recorded
  saved=$(cat "$LOGS/tick" 2>/dev/null || echo 0)
  recorded=$(grep -hoE '^### Tick [0-9]+' "$LEDGER" "$DIR"/archive/*.md 2>/dev/null | awk '{ print $3 }' | sort -n | tail -1)
  echo $(( (saved > ${recorded:-0} ? saved : ${recorded:-0}) + 1 ))
}

ensure_ledger() {  # <tick> <HEAD before the tick> <exit code>: every tick leaves a committed ledger entry
  local n=$1 before=$2 rc=$3
  if git_wt diff --quiet "$before" HEAD -- "$LEDGER" && git_wt diff --quiet HEAD -- "$LEDGER"; then
    {
      printf '\n### Tick %s · %s · AUTO: no ledger entry\n' "$n" "$(date +%H:%M)"
      printf -- '- Action: unknown. The session exited with code %s (124 means it hit the %s-minute limit) without updating BRAIN.md.\n' "$rc" "$HARD"
      printf -- '- Outcome: uncommitted changes: %s\n' "$(git_wt status --short | head -10 | tr '\n' ' ' | sed 's/ *$//' | grep . || echo none)"
      printf -- '- Value: ❌\n'
      printf -- '- Lesson: find out why in pi-orchestration/brain/logs/tick-%s.log before choosing the next action.\n' "$n"
    } >> "$LEDGER"
  fi
  git_wt diff --quiet HEAD -- "$LEDGER" || git_wt commit -q -m "brain: tick $n — ledger (auto)" -- "$LEDGER"
}

tick() {  # <tick>
  local n=$1 before rc model=()
  before=$(git_wt rev-parse HEAD)
  [[ ${BRAIN_MODEL:-} ]] && model=(--model "$BRAIN_MODEL")
  system_prompt > "$LOGS/tick-$n.system.md"
  tick_message "$n" > "$LOGS/tick-$n.prompt.md"
  printf '\n=== tick %s · %s ===\n' "$n" "$(date -Is)"
  ( cd "$WT" && BRAIN_TICK=$n timeout --kill-after=30s "${HARD}m" pi -p "${model[@]}" --recap-disable --name "brain tick $n" \
      --append-system-prompt "$LOGS/tick-$n.system.md" "$(cat "$LOGS/tick-$n.prompt.md")" 9>&- ) 2>&1 | tee "$LOGS/tick-$n.log"
  rc=${PIPESTATUS[0]}
  ensure_ledger "$n" "$before" "$rc"
  git_wt push -q -u origin "$BRANCH" 2>&1 | tee -a "$LOGS/tick-$n.log"
  echo "$n" > "$LOGS/tick"
  echo "=== tick $n exited $rc ==="
}

run() {
  mkdir -p "$LOGS"
  exec 9>"$LOGS/lock"
  flock -n 9 || die "another brain loop holds $LOGS/lock"
  [[ -e $DIR/STOP ]] && { echo "brain/STOP exists; the loop stops."; exit 0; }
  local start left
  start=$(date +%s)
  tick "$(next_tick)"
  [[ ${1:-} == once ]] && exit 0
  left=$(( start + INTERVAL - $(date +%s) ))
  (( left > 0 )) && sleep "$left"
  [[ -e $DIR/STOP ]] && { echo "brain/STOP exists; the loop stops."; exit 0; }
  if bash -n "$SCRIPT" 2>/dev/null; then
    cp "$SCRIPT" "$LOGS/loop.good.sh"
    exec bash "$SCRIPT" run
  fi
  echo "loop.sh: $SCRIPT fails bash -n; running the last good copy" >&2
  exec bash "$LOGS/loop.good.sh" run
}

spawn() {  # <name> <task>
  local name=${1:-} task=${2:-} path branch ledger created workspace pane
  [[ $name =~ ^[a-z][a-z0-9-]{0,23}$ && $name != orchestration ]] || die "spawn <name> <task>: name must match [a-z][a-z0-9-]{0,23}"
  [[ $task ]] || die "spawn <name> <task>: the task is empty"
  (( $(agents | wc -l) < MAX_AGENTS )) || die "already $MAX_AGENTS subagents; retire one first"
  path=$REPO/.pi/worktrees/brain-$name
  branch=brain/$name
  ledger=$path/pi-orchestration/ledgers/$name.md
  mkdir -p "$LOGS/agents"
  git_wt worktree add -q -b "$branch" "$path" "$BRANCH" || die "git worktree add failed"
  mkdir -p "$(dirname "$ledger")"
  printf 'Status: working — just started\n\n# Subagent %s\n\nBranch brain/%s, spawned %s by the brain.\n\n## Task\n\n%s\n\n## Log\n' \
    "$name" "$name" "$(date -Is)" "$task" > "$ledger"
  git -C "$path" add "$ledger" && git -C "$path" commit -q -m "agent $name: task" || die "committing the ledger failed"
  git -C "$path" push -q -u origin "$branch" || echo "loop.sh: push of $branch failed; the subagent will retry" >&2
  (cd "$path" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) || echo "loop.sh: npm ci failed in $path" >&2
  subagent_rules "$name" "$path" > "$LOGS/agents/$name.rules.md"
  created=$(hd workspace create --cwd "$path" --label "$name" --no-focus \
    --env PI_WORKFLOW_ALLOW_UNATTENDED=1 --env PI_MEMORY_CAPTURE=0 --env PI_MEMORY_DREAM=0) || die "herdr workspace create failed"
  workspace=$(jq -r '.result.workspace.workspace_id // .result.workspace.id' <<<"$created")
  pane=$(jq -r '.result.root_pane.pane_id // .result.root_pane.id' <<<"$created")
  jq -n --arg name "$name" --arg path "$path" --arg workspace "$workspace" --arg pane "$pane" \
    '{ name: $name, branch: "brain/\($name)", path: $path, workspace: $workspace, pane: $pane }' > "$LOGS/agents/$name.json"
  hd agent start "$name" --kind pi --pane "$pane" --timeout 60000 -- \
    --recap-disable --append-system-prompt "$LOGS/agents/$name.rules.md" >/dev/null || die "herdr agent start failed (workspace $workspace)"
  hd agent prompt "$name" "Start now. Your brief is the Task section of pi-orchestration/ledgers/$name.md." >/dev/null \
    || die "herdr agent prompt failed"
  echo "spawned $name: branch $branch, worktree $path, herdr workspace $workspace pane $pane"
}

retire() {  # <name>
  local name=${1:-} saved path workspace
  saved=$LOGS/agents/$name.json
  [[ $name && -f $saved ]] || die "retire <name>: no record of subagent '$name'"
  path=$(jq -r .path "$saved")
  workspace=$(jq -r .workspace "$saved")
  [[ -z $(git -C "$path" status --porcelain) ]] || die "$name has uncommitted changes in $path"
  git -C "$path" fetch -q origin "brain/$name" 2>/dev/null
  [[ -z $(git -C "$path" log --oneline "origin/brain/$name..HEAD" 2>/dev/null) ]] || die "$name has unpushed commits"
  hd workspace close "$workspace" >/dev/null || echo "loop.sh: closing herdr workspace $workspace failed" >&2
  git_wt worktree remove "$path" || die "git worktree remove $path failed"
  rm -f "$saved"
  echo "retired $name; branch brain/$name stays on origin"
}

main() {
  case ${1:-run} in
    run) run ;;
    once) run once ;;
    prompt) system_prompt; echo; echo "--- message ---"; tick_message "$(next_tick)" ;;
    spawn) shift; spawn "$@" ;;
    retire) shift; retire "$@" ;;
    status)
      echo "next tick: $(next_tick); STOP: $([[ -e $DIR/STOP ]] && echo present || echo absent)"
      agent_table ;;
    *) die "unknown command $1" ;;
  esac
}

main "$@"; exit
