#!/bin/sh
set -eu

cd /home/chenyiboyun/apps/supermemory-add-search-wrapper

if [ -s official-service.pid ] && kill -0 "$(cat official-service.pid)" 2>/dev/null; then
  exit 0
fi

set -a
. ./runtime.env
. ./official.runtime.env
set +a
mkdir -p logs
nohup python3 official_adapter.py >> logs/official-adapter.log 2>&1 < /dev/null &
echo $! > official-service.pid
