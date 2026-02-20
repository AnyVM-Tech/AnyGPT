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

npm run frontend
npm run backend
