#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT/scripts/sync-config.sh"

cd "$ROOT/librechat"

if [[ ! -d node_modules ]]; then
  echo "LibreChat dependencies not installed."
  echo "Run: (cd $ROOT/librechat && npm install)"
  exit 1
fi

npm run backend:dev &
BACKEND_PID=$!

cleanup() {
  if kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID"
  fi
}
trap cleanup EXIT

npm run frontend:dev
