#!/usr/bin/env bash

UI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBRECHAT_DIR="$UI_ROOT/librechat"

if [[ ! -f "$LIBRECHAT_DIR/.nvmrc" ]]; then
  echo "LibreChat Node version file is missing at $LIBRECHAT_DIR/.nvmrc." >&2
  return 1
fi

required_node="$(tr -d '[:space:]' < "$LIBRECHAT_DIR/.nvmrc")"
required_node="${required_node#v}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
export NVM_DIR

if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  set +u
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  set -u
  nvm use "$required_node" >/dev/null
elif ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != "v${required_node}" ]]; then
  echo "LibreChat requires Node v${required_node}. Run 'bun run frontend:install' first." >&2
  return 1
fi

for required_command in node npm npx lsof; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "LibreChat requires '$required_command' to be available in WSL." >&2
    return 1
  fi
done
