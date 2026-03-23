#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_DIR="$ROOT_DIR/apps/langgraph-control-plane/.control-plane"
STATUS_FILE="$CONTROL_DIR/live-autonomous-runner-status.json"
CHECKPOINT_FILE="$CONTROL_DIR/live-autonomous-runner-checkpoints.json"
LOG_FILE="$CONTROL_DIR/live-autonomous-runner.log"
PID_FILE="$CONTROL_DIR/live-autonomous-runner.pid"
ENV_FILE="$CONTROL_DIR/live-autonomous-runner.env"
EXEC_SCRIPT="$ROOT_DIR/scripts/control-plane-autonomous-runner-exec.sh"
USER_SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="anygpt-control-plane-autonomous-runner.service"
UNIT_FILE="$USER_SERVICE_DIR/$UNIT_NAME"

DEFAULT_GOAL='Continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements.'
DEFAULT_SCOPES='repo,api,api-experimental,control-plane,repo-surface'
DEFAULT_INTERVAL_MS='1000'
DEFAULT_MAX_EDIT_ACTIONS='6'
DEFAULT_EDIT_ALLOWLIST='apps/langgraph-control-plane,apps/api,apps/homepage,apps/ui,scripts,README.md,SETUP.md,package.json,turbo.json,pnpm-workspace.yaml,tsconfig.json,bun.sh'
DEFAULT_AGENT_PARALLELISM='6'
DEFAULT_MULTI_RUNNER='true'
DEFAULT_LOG_TAIL_LINES='80'

print_usage() {
  echo "Usage: bash ./scripts/control-plane-autonomous-runner.sh <start|stop|status|restart>" >&2
}

read_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  printf '%s\n' "$pid"
}

is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

service_state() {
  systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true
}

service_main_pid() {
  systemctl --user show --property MainPID --value "$UNIT_NAME" 2>/dev/null || true
}

write_env_var() {
  local key="$1"
  local value="$2"
  printf '%s=%q\n' "$key" "$value"
}

write_env_file() {
  local goal="$1"
  local scopes="$2"
  local interval_ms="$3"
  local max_edit_actions="$4"
  local edit_allowlist="$5"
  local edit_denylist="$6"
  local agent_parallelism="$7"
  local multi_runner="${8}"
  local log_tail_lines="${9}"
  local auto_restart_experimental="${10}"
  local auto_restart_production="${11}"

  mkdir -p "$CONTROL_DIR"
  {
    write_env_var CONTROL_PLANE_AUTONOMOUS_GOAL "$goal"
    write_env_var CONTROL_PLANE_AUTONOMOUS_SCOPES "$scopes"
    write_env_var CONTROL_PLANE_AUTONOMOUS_INTERVAL_MS "$interval_ms"
    write_env_var CONTROL_PLANE_AUTONOMOUS_MAX_EDIT_ACTIONS "$max_edit_actions"
    write_env_var CONTROL_PLANE_AUTONOMOUS_EDIT_ALLOWLIST "$edit_allowlist"
    write_env_var CONTROL_PLANE_AUTONOMOUS_EDIT_DENYLIST "$edit_denylist"
    write_env_var CONTROL_PLANE_REPO_ROOT "$ROOT_DIR"
    write_env_var CONTROL_PLANE_AUTONOMOUS_STATUS_FILE "$STATUS_FILE"
    write_env_var CONTROL_PLANE_AUTONOMOUS_CHECKPOINT_FILE "$CHECKPOINT_FILE"
    write_env_var CONTROL_PLANE_AUTONOMOUS_PID_FILE "$PID_FILE"
    write_env_var CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM "$agent_parallelism"
    write_env_var CONTROL_PLANE_AUTONOMOUS_MULTI_RUNNER "$multi_runner"
    write_env_var CONTROL_PLANE_LOG_TAIL_LINES "$log_tail_lines"
    write_env_var CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL "$auto_restart_experimental"
    write_env_var CONTROL_PLANE_AUTO_RESTART_PRODUCTION "$auto_restart_production"
  } > "$ENV_FILE"
}

write_unit_file() {
  mkdir -p "$USER_SERVICE_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=AnyGPT LangGraph autonomous control-plane runner
After=default.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
ExecStart=$EXEC_SCRIPT
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
}

rotate_runtime_files() {
  if [[ -f "$STATUS_FILE" ]]; then mv "$STATUS_FILE" "$STATUS_FILE.previous"; fi
  if [[ -f "$CHECKPOINT_FILE" ]]; then mv "$CHECKPOINT_FILE" "$CHECKPOINT_FILE.previous"; fi
  if [[ -f "$LOG_FILE" ]]; then mv "$LOG_FILE" "$LOG_FILE.previous"; fi
  rm -f "$PID_FILE"
}

start_runner() {
  local state
  state="$(service_state)"
  if [[ "$state" == "active" || "$state" == "activating" ]]; then
    echo "Runner already active (service_state=$state pid=$(service_main_pid))"
    exit 0
  fi

  local goal="${CONTROL_PLANE_AUTONOMOUS_GOAL:-$DEFAULT_GOAL}"
  local scopes="${CONTROL_PLANE_AUTONOMOUS_SCOPES:-$DEFAULT_SCOPES}"
  local interval_ms="${CONTROL_PLANE_AUTONOMOUS_INTERVAL_MS:-${CONTROL_PLANE_INTERVAL_MS:-$DEFAULT_INTERVAL_MS}}"
  local max_edit_actions="${CONTROL_PLANE_AUTONOMOUS_MAX_EDIT_ACTIONS:-$DEFAULT_MAX_EDIT_ACTIONS}"
  local edit_allowlist="${CONTROL_PLANE_AUTONOMOUS_EDIT_ALLOWLIST:-$DEFAULT_EDIT_ALLOWLIST}"
  local edit_denylist="${CONTROL_PLANE_AUTONOMOUS_EDIT_DENYLIST:-}"
  local agent_parallelism="${CONTROL_PLANE_AUTONOMOUS_AGENT_PARALLELISM:-${CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM:-$DEFAULT_AGENT_PARALLELISM}}"
  local multi_runner="${CONTROL_PLANE_AUTONOMOUS_MULTI_RUNNER:-${CONTROL_PLANE_MULTI_RUNNER:-$DEFAULT_MULTI_RUNNER}}"
  local log_tail_lines="${CONTROL_PLANE_AUTONOMOUS_LOG_TAIL_LINES:-$DEFAULT_LOG_TAIL_LINES}"
  local auto_restart_experimental="${CONTROL_PLANE_AUTONOMOUS_AUTO_RESTART_EXPERIMENTAL:-${CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL:-false}}"
  local auto_restart_production="${CONTROL_PLANE_AUTONOMOUS_AUTO_RESTART_PRODUCTION:-${CONTROL_PLANE_AUTO_RESTART_PRODUCTION:-false}}"

  rotate_runtime_files
  write_env_file "$goal" "$scopes" "$interval_ms" "$max_edit_actions" "$edit_allowlist" "$edit_denylist" "$agent_parallelism" "$multi_runner" "$log_tail_lines" "$auto_restart_experimental" "$auto_restart_production"
  chmod +x "$EXEC_SCRIPT"
  write_unit_file

  systemctl --user daemon-reload
  systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
  systemctl --user start "$UNIT_NAME"

  for _ in $(seq 1 20); do
    state="$(service_state)"
    if [[ "$state" == "active" || "$state" == "activating" ]]; then
      echo "Runner started (service_state=$state pid=$(service_main_pid))"
      return 0
    fi
    sleep 0.5
  done

  echo "Runner failed to start; check $LOG_FILE and systemctl --user status $UNIT_NAME" >&2
  return 1
}

stop_runner() {
  local state
  state="$(service_state)"
  if [[ "$state" == "active" || "$state" == "activating" || "$state" == "deactivating" ]]; then
    systemctl --user stop "$UNIT_NAME" || true
  fi

  for _ in $(seq 1 20); do
    state="$(service_state)"
    if [[ -z "$state" || "$state" == "inactive" || "$state" == "failed" ]]; then
      if pid="$(read_pid 2>/dev/null)" && is_pid_alive "$pid"; then
        kill -TERM "$pid" 2>/dev/null || true
        sleep 1
        if is_pid_alive "$pid"; then
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
      rm -f "$PID_FILE"
      echo "Runner stopped"
      return 0
    fi
    sleep 0.5
  done

  if pid="$(read_pid 2>/dev/null)" && is_pid_alive "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1
    rm -f "$PID_FILE"
    echo "Runner stopped after SIGKILL"
    exit 0
  fi

  echo "Runner did not stop cleanly; check systemctl --user status $UNIT_NAME" >&2
  return 1
}

restart_runner() {
  stop_runner || true
  start_runner
}

status_runner() {
  local state pid
  state="$(service_state)"
  pid="$(service_main_pid)"
  echo "Service: ${state:-inactive}"
  if [[ -n "$pid" && "$pid" != "0" ]]; then
    echo "MainPID: $pid"
  fi

  if [[ -f "$PID_FILE" ]]; then
    local file_pid
    file_pid="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$file_pid" ]]; then
      echo "RunnerPIDFile: $file_pid"
    fi
  fi

  if [[ -f "$STATUS_FILE" ]]; then
    echo "Status file: $STATUS_FILE"
    sed -n '1,120p' "$STATUS_FILE"
  else
    echo "Status file missing: $STATUS_FILE"
  fi
}

case "${1:-}" in
  start)
    start_runner
    ;;
  stop)
    stop_runner
    ;;
  status)
    status_runner
    ;;
  restart)
    restart_runner
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
