#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_DIR="$ROOT_DIR/apps/langgraph-control-plane/.control-plane"
ENV_FILE="$CONTROL_DIR/live-autonomous-runner.env"
LOG_FILE="$CONTROL_DIR/live-autonomous-runner.log"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${CONTROL_PLANE_AUTONOMOUS_GOAL:=Continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements.}"
: "${CONTROL_PLANE_AUTONOMOUS_SCOPES:=repo,api,api-experimental,control-plane,repo-surface}"
: "${CONTROL_PLANE_AUTONOMOUS_INTERVAL_MS:=${CONTROL_PLANE_INTERVAL_MS:-1000}}"
: "${CONTROL_PLANE_AUTONOMOUS_MAX_EDIT_ACTIONS:=6}"
: "${CONTROL_PLANE_AUTONOMOUS_EDIT_ALLOWLIST:=apps/langgraph-control-plane,apps/api,apps/homepage,apps/ui,scripts,README.md,SETUP.md,package.json,turbo.json,pnpm-workspace.yaml,tsconfig.json,bun.sh}"
: "${CONTROL_PLANE_AUTONOMOUS_EDIT_DENYLIST:=}"
: "${CONTROL_PLANE_REPO_ROOT:=$ROOT_DIR}"
: "${CONTROL_PLANE_AUTONOMOUS_STATUS_FILE:=$CONTROL_DIR/live-autonomous-runner-status.json}"
: "${CONTROL_PLANE_AUTONOMOUS_CHECKPOINT_FILE:=$CONTROL_DIR/live-autonomous-runner-checkpoints.json}"
: "${CONTROL_PLANE_AUTONOMOUS_PID_FILE:=$CONTROL_DIR/live-autonomous-runner.pid}"
: "${CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM:=${CONTROL_PLANE_AUTONOMOUS_AGENT_PARALLELISM:-6}}"
: "${CONTROL_PLANE_AUTONOMOUS_MULTI_RUNNER:=${CONTROL_PLANE_MULTI_RUNNER:-true}}"
: "${CONTROL_PLANE_LOG_TAIL_LINES:=80}"
: "${CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL:=${CONTROL_PLANE_AUTONOMOUS_AUTO_RESTART_EXPERIMENTAL:-false}}"
: "${CONTROL_PLANE_AUTO_RESTART_PRODUCTION:=${CONTROL_PLANE_AUTONOMOUS_AUTO_RESTART_PRODUCTION:-false}}"

mkdir -p "$CONTROL_DIR"
exec >> "$LOG_FILE" 2>&1

cd "$ROOT_DIR"

cmd=(
  bash "$ROOT_DIR/bun.sh" run -F anygpt-langgraph-control-plane start --
  --repo-root="$CONTROL_PLANE_REPO_ROOT"
  --goal="$CONTROL_PLANE_AUTONOMOUS_GOAL"
  --scopes="$CONTROL_PLANE_AUTONOMOUS_SCOPES"
  --autonomous
  --interval-ms="$CONTROL_PLANE_AUTONOMOUS_INTERVAL_MS"
  --max-edit-actions="$CONTROL_PLANE_AUTONOMOUS_MAX_EDIT_ACTIONS"
  --edit-allowlist="$CONTROL_PLANE_AUTONOMOUS_EDIT_ALLOWLIST"
  --status-file="$CONTROL_PLANE_AUTONOMOUS_STATUS_FILE"
  --checkpoint-path="$CONTROL_PLANE_AUTONOMOUS_CHECKPOINT_FILE"
  --pid-file="$CONTROL_PLANE_AUTONOMOUS_PID_FILE"
)

if [[ -n "$CONTROL_PLANE_AUTONOMOUS_EDIT_DENYLIST" ]]; then
  cmd+=(--edit-denylist="$CONTROL_PLANE_AUTONOMOUS_EDIT_DENYLIST")
fi

if [[ "${CONTROL_PLANE_AUTONOMOUS_MULTI_RUNNER,,}" =~ ^(1|true|yes|on)$ ]]; then
  cmd+=(--multi-runner)
fi

if [[ -n "${CONTROL_PLANE_AUTONOMOUS_MAX_ITERATIONS:-}" ]]; then
  cmd+=(--max-iterations="$CONTROL_PLANE_AUTONOMOUS_MAX_ITERATIONS")
fi

exec env \
  CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM="$CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM" \
  CONTROL_PLANE_LOG_TAIL_LINES="$CONTROL_PLANE_LOG_TAIL_LINES" \
  CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL="$CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL" \
  CONTROL_PLANE_AUTO_RESTART_PRODUCTION="$CONTROL_PLANE_AUTO_RESTART_PRODUCTION" \
  "${cmd[@]}"
