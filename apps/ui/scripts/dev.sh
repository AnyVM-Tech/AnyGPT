#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
BUN_SH="$REPO_ROOT/bun.sh"

bash "$ROOT/scripts/sync-config.sh"

cd "$ROOT/librechat"

if [[ ! -d node_modules || ! -x node_modules/.bin/cross-env ]]; then
  echo "Installing LibreChat dependencies..."
  bash "$BUN_SH" install
fi

if [[ ! -f node_modules/@librechat/data-schemas/dist/index.cjs ]] || [[ ! -f packages/data-provider/dist/react-query/index.es.js ]]; then
  echo "Building LibreChat workspace packages..."
  bash "$BUN_SH" run build:packages
fi

if [[ ! -f client/dist/index.html ]]; then
  echo "Building LibreChat client..."
  bash "$BUN_SH" run build:client
fi

# Kill any process already using the LibreChat backend port (3080)
BACKEND_PORT="${PORT:-3080}"
if PID=$(lsof -ti :"$BACKEND_PORT" 2>/dev/null); then
  echo "Killing existing process on port $BACKEND_PORT (PID: $PID)..."
  kill -9 $PID 2>/dev/null || true
  sleep 1
fi

# Ensure Vite binds to all interfaces (not just IPv6 loopback)
export HOST=0.0.0.0
# Allow reverse-proxy hostnames through Vite's host check
export VITE_ALLOWED_HOSTS="${VITE_ALLOWED_HOSTS:-gpt.anyvm.tech}"

bash "$BUN_SH" run backend:dev &
BACKEND_PID=$!

cleanup() {
  if kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID"
  fi
}
trap cleanup EXIT

bash "$BUN_SH" run frontend:dev
