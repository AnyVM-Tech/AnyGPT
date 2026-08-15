#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRECHAT_DIR="$ROOT/librechat"
CUSTOMIZATIONS_DIR="$ROOT/customizations"
PATCH_FILE="$CUSTOMIZATIONS_DIR/librechat.patch"

usage() {
  echo "Usage: $0 <LibreChat-relative path> [path ...]" >&2
  echo "Example: $0 client/src/components/Auth/AuthLayout.tsx client/public/assets/AnyGPT.svg" >&2
}

if [[ ! -d "$LIBRECHAT_DIR/.git" ]]; then
  echo "LibreChat repo not found at $LIBRECHAT_DIR" >&2
  exit 1
fi

if (( $# == 0 )); then
  usage
  exit 2
fi

paths=()
for path in "$@"; do
  case "$path" in
    ""|/*|.|..|../*|*/..|*/../*|.git|.git/*|node_modules|node_modules/*|*/node_modules|*/node_modules/*|.env|.env.*|*/.env|*/.env.*|logs|logs/*|*/logs|*/logs/*)
      echo "Refusing unsafe or generated LibreChat path: $path" >&2
      exit 2
      ;;
  esac
  paths+=("$path")
done

mkdir -p "$CUSTOMIZATIONS_DIR"
temporary_index="$(mktemp)"
temporary_patch="$(mktemp "$CUSTOMIZATIONS_DIR/.librechat.patch.XXXXXX")"
rm -f "$temporary_index"
cleanup() {
  rm -f "$temporary_index" "$temporary_patch"
}
trap cleanup EXIT

# Build an alternate index from HEAD so new/deleted files can be captured
# without staging anything in the ignored LibreChat checkout's real index.
GIT_INDEX_FILE="$temporary_index" git -C "$LIBRECHAT_DIR" read-tree HEAD
GIT_INDEX_FILE="$temporary_index" git --literal-pathspecs -C "$LIBRECHAT_DIR" add -A -- "${paths[@]}"
GIT_INDEX_FILE="$temporary_index" git --literal-pathspecs -C "$LIBRECHAT_DIR" diff \
  --cached --binary --full-index HEAD -- "${paths[@]}" > "$temporary_patch"

if [[ ! -s "$temporary_patch" ]]; then
  echo "No LibreChat changes found in the requested paths; existing patch was left unchanged." >&2
  exit 1
fi

if ! git -C "$LIBRECHAT_DIR" apply --reverse --check --whitespace=nowarn "$temporary_patch"; then
  echo "Generated patch could not be verified against the current LibreChat edits." >&2
  exit 1
fi

mv -f "$temporary_patch" "$PATCH_FILE"
echo "Captured LibreChat customization patch at $PATCH_FILE"
echo "Review it from the outer repo before committing. The nested checkout index was not changed."
