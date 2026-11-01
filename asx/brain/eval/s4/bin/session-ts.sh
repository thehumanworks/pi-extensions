#!/usr/bin/env bash
# usage: session-ts.sh <name> <prompt> — like session.sh, with a receive timestamp _t on each event
name=$1; prompt=$2
cd /tmp/axc4/w || exit 1
PI_WORKFLOW_HOME=/tmp/axc4/h timeout 600 pi -p --mode json --no-session --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --offline \
  -e /home/nixos/pi-extensions/.pi/worktrees/brain-axeval3/pi-orchestration/index.ts \
  --model openrouter/anthropic/claude-haiku-4.5 --thinking off -- "$prompt" 2> /tmp/axc4/logs/$name.err | python3 -I /tmp/axc4/bin/stamp.py > /tmp/axc4/logs/$name.ndjson
echo "exit=${PIPESTATUS[0]}"
