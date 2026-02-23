#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRECHAT_DIR="$ROOT/librechat"

if [[ ! -d "$LIBRECHAT_DIR/.git" ]]; then
  echo "LibreChat repo not found at $LIBRECHAT_DIR"
  exit 1
fi

cd "$LIBRECHAT_DIR"

BRANCH="${1:-main}"

echo "Fetching upstream..."
git fetch upstream

echo "Updating $BRANCH from upstream/$BRANCH..."
git checkout "$BRANCH"

# Try fast-forward, fallback to merge if needed
if git merge --ff-only "upstream/$BRANCH"; then
  echo "Fast-forwarded to upstream/$BRANCH"
else
  echo "Fast-forward failed; merging upstream/$BRANCH"
  git merge "upstream/$BRANCH"
fi

echo "Pushing to origin/$BRANCH..."
git push origin "$BRANCH"
