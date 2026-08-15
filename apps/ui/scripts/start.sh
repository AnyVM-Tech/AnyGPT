#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
BUN_SH="$REPO_ROOT/bun.sh"

bash "$ROOT/scripts/sync-config.sh"

cd "$ROOT/librechat"

# shellcheck source=activate-node.sh
. "$ROOT/scripts/activate-node.sh"

if [[ ! -d node_modules || ! -x node_modules/.bin/cross-env ]]; then
  echo "LibreChat dependencies are missing or incomplete." >&2
  echo "Run 'bun run frontend:install' from $REPO_ROOT, then retry." >&2
  exit 1
fi

if [[ ! -f node_modules/@librechat/data-schemas/dist/index.cjs ]] || [[ ! -f packages/data-provider/dist/react-query/index.js ]]; then
  echo "Building LibreChat workspace packages..."
  bash "$BUN_SH" run build:packages
fi

if [[ ! -f client/dist/index.html ]]; then
  echo "Building LibreChat client..."
  bash "$BUN_SH" run build:client
fi

# Never terminate an unrelated process that already owns the backend port.
BACKEND_PORT="${PORT:-3080}"
if PID=$(lsof -ti :"$BACKEND_PORT" 2>/dev/null); then
  echo "LibreChat backend port $BACKEND_PORT is already in use by PID(s): $PID" >&2
  echo "Stop or reconfigure that process explicitly before starting this stack." >&2
  exit 1
fi

exec bash "$BUN_SH" run backend
