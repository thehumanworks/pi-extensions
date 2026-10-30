#!/usr/bin/env bash
# usage: session-h.sh <name> <mode tool|cli> <prompt> — authoring sessions in a fresh cwd per name
name=$1; mode=$2; prompt=$3
mkdir -p /tmp/axc4/$name && cd /tmp/axc4/$name || exit 1
if [ "$mode" = tool ]; then
  PI_WORKFLOW_HOME=/tmp/axc4/h timeout 600 pi -p --mode json --no-session --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --offline \
    -e /home/nixos/pi-extensions/.pi/worktrees/brain-axeval3/pi-orchestration/index.ts \
    --model openrouter/anthropic/claude-haiku-4.5 --thinking off -- "$prompt" 2> /tmp/axc4/logs/$name.err | python3 -I /tmp/axc4/bin/stamp.py > /tmp/axc4/logs/$name.ndjson
else
  PATH=/tmp/axc4/pathbin:$PATH PI_WORKFLOW_HOME=/tmp/axc4/hf timeout 600 pi -p --mode json --no-session --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --offline \
    --model openrouter/anthropic/claude-haiku-4.5 --thinking off -- "$prompt" 2> /tmp/axc4/logs/$name.err | python3 -I /tmp/axc4/bin/stamp.py > /tmp/axc4/logs/$name.ndjson
fi
echo "exit=${PIPESTATUS[0]}"
