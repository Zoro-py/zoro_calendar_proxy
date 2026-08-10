#!/usr/bin/env bash
# One script for both first install and every later update.
# Run from this directory (or via the one-liner in README.md).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  read -r -p "Secret (Enter = auto-generate): " S
  [ -z "$S" ] && S="$(openssl rand -hex 32)"
  printf "PROXY_SECRET=%s\nPORT=8787\n" "$S" > .env
  echo "Secret in use: $S"
fi

docker compose up -d --build
