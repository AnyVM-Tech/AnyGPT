#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6 2>/dev/null || true)"
if [[ -z "${USER_HOME}" ]]; then
	USER_HOME="/home/$(id -un)"
fi
DEFAULT_BUN="${USER_HOME}/.bun/bin/bun"
BUN_INSTALL_BIN="${BUN_INSTALL:-}/bin/bun"

if command -v bun >/dev/null 2>&1; then
	BUN_BIN="$(command -v bun)"
elif [[ -n "${BUN_INSTALL:-}" && -x "${BUN_INSTALL_BIN}" ]]; then
	BUN_BIN="${BUN_INSTALL_BIN}"
elif [[ -x "${DEFAULT_BUN}" ]]; then
	BUN_BIN="${DEFAULT_BUN}"
else
	echo "Bun is required but was not found in PATH, BUN_INSTALL/bin, or at ${DEFAULT_BUN}." >&2
	echo "Workspace-surface operator note for thread 8739b1d5-0be2-4091-90f2-44fe32d8c6dd:workspace-surface: install Bun from https://bun.sh or add its bin directory to PATH, set BUN_INSTALL correctly, then rerun 'bash ./scripts/with-bun-path.sh bun run workspace:surface:summary' or another bounded workspace smoke/typecheck command for this same thread." >&2
	echo "Workspace-surface defer reason for thread 8739b1d5-0be2-4091-90f2-44fe32d8c6dd:workspace-surface: no fresh same-thread LangSmith run/trace was emitted from this local workflow because Bun is unavailable on the host." >&2
	echo "Validation reminder: pending or cross-thread LangSmith activity is partial observability only for this iteration; after Bun is available, confirm at least one fresh same-thread run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear no-run defer reason." >&2
	exit 1
fi

BUN_DIR="$(dirname "${BUN_BIN}")"
case ":${PATH}:" in
	*":${BUN_DIR}:"*) ;;
	*) export PATH="${BUN_DIR}:${PATH}" ;;
esac

cd "${ROOT_DIR}"

WORKSPACE_SURFACE_ALIASES=(
	workspace-surface-summary
	workspace-surface-status
	workspace-surface-thread-snapshot
	frontend:status:snapshot:thread
	workspace-surface-snapshot
	workspace-surface-install-status
	frontend:install:status
	workspace-surface-preflight
	workspace-surface-smoke
	frontend:install-check
	workspace-surface-typecheck
	workspace-surface-quickcheck
	workspace-surface-summary-typecheck
	workspace-surface-preflight-thread
	workspace-surface-install-status-thread
	workspace-surface-goal-smoke-thread
	workspace-surface-snapshot-thread
	workspace-surface-quickcheck-thread
	workspace-surface-summary-thread
)

DEFAULT_WORKSPACE_SURFACE_COMMAND="workspace:surface:summary"
if grep -q '"frontend:install:status"' "${ROOT_DIR}/package.json" 2>/dev/null; then
	DEFAULT_WORKSPACE_SURFACE_COMMAND="frontend:install:status"
elif grep -q '"frontend:status:snapshot:thread"' "${ROOT_DIR}/package.json" 2>/dev/null; then
	DEFAULT_WORKSPACE_SURFACE_COMMAND="frontend:status:snapshot:thread"
fi

if [[ "$#" -eq 0 ]]; then
	set -- bun run "${DEFAULT_WORKSPACE_SURFACE_COMMAND}"
fi

if [[ "$1" == "--help" || "$1" == "-h" || "$1" == "help" ]]; then
	echo "Usage: bash ./scripts/with-bun-path.sh <command> [args...]" >&2
	echo "Example: bash ./scripts/with-bun-path.sh ./node_modules/.bin/turbo run build" >&2
	echo "Workspace-surface aliases:" >&2
	for alias in "${WORKSPACE_SURFACE_ALIASES[@]}"; do
		echo "  $alias" >&2
	done
	exit 0
fi

if [[ "$1" == "workspace-surface-summary" ]]; then
	set -- bash ./scripts/run-frontend-stack.sh workspace-surface-summary
elif [[ "$1" == "workspace-surface-status" || "$1" == "workspace-surface-thread-snapshot" || "$1" == "frontend:status:snapshot:thread" || "$1" == "workspace-surface-snapshot" ]]; then
	set -- bash ./bun.sh run frontend:status:snapshot:thread
elif [[ "$1" == "workspace-surface-install-status" || "$1" == "frontend:install:status" ]]; then
	set -- bash ./bun.sh run frontend:install:status
elif [[ "$1" == "workspace-surface-preflight" ]]; then
	set -- bash ./scripts/run-frontend-stack.sh workspace-surface-preflight
elif [[ "$1" == "workspace-surface-smoke" || "$1" == "frontend:install-check" ]]; then
	set -- bash ./bun.sh run frontend:install-check
elif [[ "$1" == "workspace-surface-typecheck" ]]; then
	set -- bash ./scripts/run-frontend-stack.sh workspace-surface-typecheck
elif [[ "$1" == "workspace-surface-quickcheck" ]]; then
	set -- bash -lc 'bash ./bun.sh run frontend:install-check && bash ./bun.sh run typecheck'
elif [[ "$1" == "workspace-surface-summary-typecheck" ]]; then
	set -- bash -lc 'bash ./scripts/run-frontend-stack.sh workspace-surface-summary && bash ./bun.sh run typecheck'
elif [[ "$1" == "workspace-surface-preflight-thread" ]]; then
	set -- bash ./scripts/with-bun-path.sh bun run frontend:preflight:workspace-thread
elif [[ "$1" == "workspace-surface-install-status-thread" ]]; then
	set -- bash ./scripts/with-bun-path.sh bun run frontend:install:status
elif [[ "$1" == "workspace-surface-goal-smoke-thread" ]]; then
	set -- bash ./scripts/with-bun-path.sh bun run workspace:surface:goal-smoke
elif [[ "$1" == "workspace-surface-snapshot-thread" ]]; then
	set -- bash -lc 'bash ./scripts/with-bun-path.sh bun run workspace:surface:summary && bash ./scripts/with-bun-path.sh bun run typecheck'
elif [[ "$1" == "workspace-surface-quickcheck-thread" ]]; then
	set -- bash -lc 'bash ./scripts/with-bun-path.sh bun run frontend:install:status && bash ./scripts/with-bun-path.sh bun run frontend:typecheck'
elif [[ "$1" == "workspace-surface-summary-thread" ]]; then
	set -- bash -lc 'bash ./scripts/with-bun-path.sh bun run workspace:surface:summary && bash ./scripts/with-bun-path.sh bun run frontend:typecheck'
fi
