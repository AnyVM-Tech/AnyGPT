#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3310}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

is_owned_experimental_pid() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  [[ -r "/proc/$pid/environ" ]] || return 1

  local cmdline cwd environ
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  environ="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)"

  if [[ "$cwd" != "$ROOT_DIR" && "$cmdline" != *"$ROOT_DIR"* ]]; then
    return 1
  fi

  if [[ "$cmdline" != *"server.launcher.bun.ts"* && "$cmdline" != *"dist/experimental/server.js"* && "$cmdline" != *"start:experimental"* ]]; then
    return 1
  fi

  if ! grep -q '^NODE_ENV=experimental$' <<<"$environ" && ! grep -q '^API_DIST_DIR=dist/experimental$' <<<"$environ"; then
    return 1
  fi

  return 0
}

pids="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -z "$pids" ]]; then
  exit 0
fi

owned_pids=()
for pid in $pids; do
  if is_owned_experimental_pid "$pid"; then
    owned_pids+=("$pid")
  fi
done

if [[ ${#owned_pids[@]} -eq 0 ]]; then
  exit 0
fi

echo "[EXPERIMENTAL-CLEANUP] Releasing port ${PORT} from owned experimental process(es): ${owned_pids[*]}"
kill "${owned_pids[@]}" 2>/dev/null || true
sleep 1

remaining_pids=()
for pid in "${owned_pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    remaining_pids+=("$pid")
  fi
done

if [[ ${#remaining_pids[@]} -gt 0 ]]; then
  echo "[EXPERIMENTAL-CLEANUP] Force killing remaining process(es) on port ${PORT}: ${remaining_pids[*]}"
  kill -9 "${remaining_pids[@]}" 2>/dev/null || true
fi
