#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  bash ../../bun.sh run ./dev/testSetupCli.ts restore >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

export NODE_ENV="${NODE_ENV:-test}"
export DATA_SOURCE_PREFERENCE="${DATA_SOURCE_PREFERENCE:-filesystem}"
export DATA_CACHE_TTL_MS="${DATA_CACHE_TTL_MS:-600000}"
export API_PROVIDERS_FILE="${API_PROVIDERS_FILE:-.test-data/providers.json}"
export API_KEYS_FILE="${API_KEYS_FILE:-.test-data/keys.json}"
export API_MODELS_FILE="${API_MODELS_FILE:-.test-data/models.json}"
export API_TIERS_FILE="${API_TIERS_FILE:-.test-data/tiers.json}"
export PORT="${TEST_DEV_PORT:-3100}"
export CLUSTER_WORKERS="${TEST_CLUSTER_WORKERS:-0}"
export PORT_RETRY_COUNT="${TEST_PORT_RETRY_COUNT:-0}"
export REDIS_URL=""
export REDIS_USERNAME=""
export REDIS_PASSWORD=""
export REDIS_TLS="false"
export REDIS_DB="0"
export REDIS_STARTUP_WAIT="${REDIS_STARTUP_WAIT:-0}"
export SKIP_ADMIN_KEY_SYNC="${SKIP_ADMIN_KEY_SYNC:-1}"

bash ../../bun.sh run ./dev/testSetupCli.ts setup
bash ../../bun.sh run ./server.bun.ts
