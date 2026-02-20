#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -d "$ROOT/librechat" ]]; then
  echo "LibreChat repo not found at $ROOT/librechat"
  exit 1
fi

cd "$ROOT/librechat"
npm run backend:stop
echo "If frontend dev server is running, stop it with Ctrl+C in that terminal."
