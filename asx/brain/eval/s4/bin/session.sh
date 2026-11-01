#!/usr/bin/env bash
# usage: session.sh <name> <prompt>
name=$1; prompt=$2
cd /tmp/axc4/w || exit 1
PI_WORKFLOW_HOME=/tmp/axc4/h timeout 400 pi -p --mode json --no-session --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --offline \
  -e /home/nixos/pi-extensions/.pi/worktrees/brain-axeval3/pi-orchestration/index.ts \
  --model openrouter/anthropic/claude-haiku-4.5 --thinking off -- "$prompt" > /tmp/axc4/logs/$name.ndjson 2> /tmp/axc4/logs/$name.err
echo "exit=$?"
