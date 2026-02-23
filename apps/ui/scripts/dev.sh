#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT/scripts/sync-config.sh"

cd "$ROOT/librechat"

if [[ ! -d node_modules || ! -x node_modules/.bin/cross-env ]]; then
  echo "Installing LibreChat dependencies..."
  npm install
fi

if [[ ! -f node_modules/@librechat/data-schemas/dist/index.cjs ]]; then
  echo "Building LibreChat workspace packages..."
  npm run build:packages
fi

if [[ ! -f client/dist/index.html ]]; then
  echo "Building LibreChat client..."
  npm run build:client
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
