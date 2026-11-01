#!/usr/bin/env bash
# usage: x.sh <cmd...>  — runs W with args, prints the command, output and exit code
W="node /home/nixos/pi-extensions/.pi/worktrees/brain-axeval3/pi-orchestration/bin/workflow.mjs"
echo "\$ W $*"
$W "$@"
echo "[exit $?]"
