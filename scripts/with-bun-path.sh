#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6 2>/dev/null || true)"
if [[ -z "${USER_HOME}" ]]; then
	USER_HOME="/home/$(id -un)"
fi
DEFAULT_BUN="${USER_HOME}/.bun/bin/bun"

if command -v bun >/dev/null 2>&1; then
	BUN_BIN="$(command -v bun)"
elif [[ -x "${DEFAULT_BUN}" ]]; then
	BUN_BIN="${DEFAULT_BUN}"
else
	echo "Bun is required but was not found in PATH or at ${DEFAULT_BUN}." >&2
	exit 1
fi

BUN_DIR="$(dirname "${BUN_BIN}")"
case ":${PATH}:" in
	*":${BUN_DIR}:"*) ;;
	*) export PATH="${BUN_DIR}:${PATH}" ;;
esac

cd "${ROOT_DIR}"
exec "$@"
