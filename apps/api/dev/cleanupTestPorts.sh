#!/usr/bin/env bash
set -euo pipefail

ports=("${TEST_DEV_PORT:-3100}" "${MOCK_PROVIDER_PORT:-3101}")

for port in "${ports[@]}"; do
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -z "${pids}" ]]; then
    continue
  fi

  echo "[TEST-CLEANUP] Releasing port ${port} from stale process(es): ${pids}"
  kill ${pids} 2>/dev/null || true
  sleep 1

  remaining="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -n "${remaining}" ]]; then
    echo "[TEST-CLEANUP] Force killing port ${port} process(es): ${remaining}"
    kill -9 ${remaining} 2>/dev/null || true
  fi
done
