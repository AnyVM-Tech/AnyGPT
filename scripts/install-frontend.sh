#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_ROOT="$ROOT/apps/ui"
LIBRECHAT_DIR="$UI_ROOT/librechat"
LIBRECHAT_REPOSITORY="${ANYGPT_LIBRECHAT_REPOSITORY:-https://github.com/danny-avila/LibreChat.git}"
DEFAULT_LIBRECHAT_REF="eaef87fa2684025627e25d649a56f4f2a63417a7"
LIBRECHAT_REF="${ANYGPT_LIBRECHAT_REF:-$DEFAULT_LIBRECHAT_REF}"
INSTALL_LOCK_DIR="$(git -C "$ROOT" rev-parse --absolute-git-dir)/anygpt-local"
INSTALL_LOCK_FILE="$INSTALL_LOCK_DIR/frontend-install.lock"
INSTALL_STAMP_FILE="$INSTALL_LOCK_DIR/frontend-install.success"
STACK_LOCK_FILE="$INSTALL_LOCK_DIR/frontend-stack.lock"

for required_command in flock git sha256sum; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Frontend installation requires '$required_command' to be available in WSL." >&2
    exit 1
  fi
done

mkdir -p "$INSTALL_LOCK_DIR"
exec 9>"$INSTALL_LOCK_FILE"
if ! flock -n 9; then
  echo "Another frontend dependency installation is already running for $ROOT." >&2
  exit 1
fi
if [[ -e "$STACK_LOCK_FILE" ]] && ! flock -n "$STACK_LOCK_FILE" true 2>/dev/null; then
  echo "The frontend stack is running. Stop it before reinstalling frontend dependencies." >&2
  exit 1
fi

if [[ ! -d "$LIBRECHAT_DIR/.git" ]]; then
  if [[ -e "$LIBRECHAT_DIR" ]]; then
    echo "Cannot bootstrap LibreChat: $LIBRECHAT_DIR exists but is not a Git checkout." >&2
    exit 1
  fi

  echo "Bootstrapping LibreChat ($LIBRECHAT_REF) into $LIBRECHAT_DIR..."
  git init --quiet "$LIBRECHAT_DIR"
  git -C "$LIBRECHAT_DIR" remote add origin "$LIBRECHAT_REPOSITORY"
fi

existing_repository="$(git -C "$LIBRECHAT_DIR" remote get-url origin)"
if [[ "$existing_repository" != "$LIBRECHAT_REPOSITORY" ]]; then
  echo "LibreChat origin mismatch: expected $LIBRECHAT_REPOSITORY, found $existing_repository." >&2
  echo "Set ANYGPT_LIBRECHAT_REPOSITORY to the existing origin or reconcile the ignored checkout manually." >&2
  exit 1
fi

if [[ "$LIBRECHAT_REF" =~ ^[0-9a-fA-F]{40}$ ]] &&
  git -C "$LIBRECHAT_DIR" cat-file -e "${LIBRECHAT_REF}^{commit}" 2>/dev/null; then
  target_commit="$(git -C "$LIBRECHAT_DIR" rev-parse "${LIBRECHAT_REF}^{commit}")"
else
  git -C "$LIBRECHAT_DIR" fetch --depth 1 origin "$LIBRECHAT_REF"
  target_commit="$(git -C "$LIBRECHAT_DIR" rev-parse FETCH_HEAD)"
fi

current_commit="$(git -C "$LIBRECHAT_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ "$current_commit" != "$target_commit" ]]; then
  if ! git -C "$LIBRECHAT_DIR" diff --quiet ||
    ! git -C "$LIBRECHAT_DIR" diff --cached --quiet; then
    echo "LibreChat has tracked changes and is not at the requested ref $LIBRECHAT_REF." >&2
    echo "Commit or stash those nested-checkout changes before rerunning the installer." >&2
    exit 1
  fi

  git -C "$LIBRECHAT_DIR" checkout --detach "$target_commit"
fi

cd "$LIBRECHAT_DIR"

echo "Using LibreChat commit $target_commit"
required_node="$(tr -d '[:space:]' < .nvmrc)"
required_node="${required_node#v}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
export NVM_DIR

if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  set +u
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  set -u
  nvm install "$required_node"
  nvm use "$required_node"
elif ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != "v${required_node}" ]]; then
  echo "LibreChat requires Node v${required_node}. Install nvm or activate that exact Node version, then rerun." >&2
  exit 1
fi

required_npm="$(node -p "String(require('./package.json').packageManager || '').replace(/^npm@/, '')")"
if [[ -z "$required_npm" ]]; then
  echo "LibreChat package.json does not declare an npm packageManager version." >&2
  exit 1
fi

if [[ "$(npm --version)" == "$required_npm" ]]; then
  rm -f "$INSTALL_STAMP_FILE"
  npm ci
else
  echo "Using manifest-pinned npm $required_npm for this install..."
  rm -f "$INSTALL_STAMP_FILE"
  npx --yes "npm@${required_npm}" ci
fi

bash "$UI_ROOT/scripts/sync-config.sh"

cd "$ROOT"
bash "$ROOT/bun.sh" install --frozen-lockfile --filter ./apps/homepage

librechat_lock_sha256="$(sha256sum "$LIBRECHAT_DIR/package-lock.json" | awk '{print $1}')"
bun_lock_sha256="$(sha256sum "$ROOT/bun.lock" | awk '{print $1}')"
stamp_tmp="$INSTALL_STAMP_FILE.$$"
printf 'installer_version=1\nlibrechat_commit=%s\nlibrechat_lock_sha256=%s\nbun_lock_sha256=%s\n' \
  "$target_commit" \
  "$librechat_lock_sha256" \
  "$bun_lock_sha256" > "$stamp_tmp"
mv -f "$stamp_tmp" "$INSTALL_STAMP_FILE"
