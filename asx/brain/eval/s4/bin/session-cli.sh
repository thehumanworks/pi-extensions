#!/usr/bin/env bash
# usage: session-cli.sh <name> <prompt> — Pi with only bash, no workflow extension, local CLI first on PATH
name=$1; prompt=$2
cd /tmp/axc4/w || exit 1
PATH=/tmp/axc4/pathbin:$PATH PI_WORKFLOW_HOME=${HOMEDIR:-/tmp/axc4/hf} timeout 600 pi -p --mode json --no-session --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --offline \
  --tools bash --model openrouter/anthropic/claude-haiku-4.5 --thinking off -- "$prompt" 2> /tmp/axc4/logs/$name.err | python3 -I /tmp/axc4/bin/stamp.py > /tmp/axc4/logs/$name.ndjson
echo "exit=${PIPESTATUS[0]}"
