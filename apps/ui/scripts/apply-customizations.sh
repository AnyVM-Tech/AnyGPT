#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRECHAT_DIR="$ROOT/librechat"
PATCH_FILE="${ANYGPT_LIBRECHAT_PATCH_FILE:-$ROOT/customizations/librechat.patch}"

if [[ ! -f "$PATCH_FILE" || ! -s "$PATCH_FILE" ]]; then
  exit 0
fi

if [[ ! -d "$LIBRECHAT_DIR/.git" ]]; then
  echo "LibreChat repo not found at $LIBRECHAT_DIR" >&2
  exit 1
fi

# A reverse check is a read-only way to recognize a patch that was already
# applied by an earlier install/dev invocation.
if git -C "$LIBRECHAT_DIR" apply --reverse --check --whitespace=nowarn "$PATCH_FILE" >/dev/null 2>&1; then
  echo "LibreChat customization patch is already applied"
  exit 0
fi

# Never use --3way, --reject, or a forced checkout here. A normal check must
# succeed in full so overlapping local edits are preserved for manual review.
if ! git -C "$LIBRECHAT_DIR" apply --check --whitespace=nowarn "$PATCH_FILE"; then
  echo "LibreChat customization patch does not apply cleanly; no files were changed." >&2
  echo "Review the ignored checkout at $LIBRECHAT_DIR and reconcile its local changes manually." >&2
  exit 1
fi

git -C "$LIBRECHAT_DIR" apply --whitespace=nowarn "$PATCH_FILE"
echo "Applied LibreChat customization patch from $PATCH_FILE"
