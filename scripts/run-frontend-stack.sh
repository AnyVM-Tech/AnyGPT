#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_SH="$ROOT/bun.sh"
MODE="${1:-dev}"

case "$MODE" in
  dev|start)
    ;;
  *)
    echo "Usage: bash ./scripts/run-frontend-stack.sh [dev|start]" >&2
    exit 1
    ;;
esac

UI_PID=""
HOMEPAGE_PID=""

stop_children() {
  local wait_pids=()
  local pid

  for pid in "$UI_PID" "$HOMEPAGE_PID"; do
    [[ -n "$pid" ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    wait_pids+=("$pid")
  done

  if (( ${#wait_pids[@]} > 0 )); then
    wait "${wait_pids[@]}" 2>/dev/null || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_children
  exit "$status"
}

handle_signal() {
  trap - EXIT INT TERM
  stop_children
  exit 130
}

trap cleanup EXIT
trap handle_signal INT TERM

echo "Starting LibreChat ($MODE)..."
(
  cd "$ROOT/apps/ui"
  bash "./scripts/$MODE.sh"
) &
UI_PID=$!

echo "Starting homepage ($MODE)..."
(
  cd "$ROOT/apps/homepage"
  bash "$BUN_SH" run "$MODE"
) &
HOMEPAGE_PID=$!

wait -n "$UI_PID" "$HOMEPAGE_PID"
