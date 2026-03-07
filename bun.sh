#!/usr/bin/env bash
set -euo pipefail

if command -v bun >/dev/null 2>&1; then
	exec bun "$@"
fi

USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6 2>/dev/null || true)"
if [[ -z "${USER_HOME}" ]]; then
	USER_HOME="/home/$(id -un)"
fi
DEFAULT_BUN="${USER_HOME}/.bun/bin/bun"

if [[ -x "${DEFAULT_BUN}" ]]; then
	exec "${DEFAULT_BUN}" "$@"
fi

echo "Bun is required but was not found in PATH or at ${DEFAULT_BUN}." >&2
echo "Install Bun from https://bun.sh or add its bin directory to your PATH." >&2
exit 1
