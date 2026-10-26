#!/bin/zsh
# Phase 3: full three-stage matrix, baseline arms and the final candidate, one model per invocation.
set -u
cd /Users/tomas/pi-extensions
MODEL="$1"; TAG="$2"; OUT=/tmp/pi-memory-hc/full-$TAG
RUN=(node --import tsx pi-memory/eval/long/run.mjs --state=pi-memory/eval/long/state-v3 --repeats=2 --concurrency=2 --model=$MODEL)
echo "start $(date)"
"${RUN[@]}" --out=$OUT-c0 --arms=off,long
"${RUN[@]}" --out=$OUT-c2 --arms=long --memory-env='PI_MEMORY_DIGEST_SCOPE=decisions;PI_MEMORY_DIGEST_BUDGET=2400;PI_MEMORY_SESSION_BUDGET=1200'
echo "done $(date)"
