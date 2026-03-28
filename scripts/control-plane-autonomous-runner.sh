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
CHILD_PID_GLOB="$CONTROL_DIR/live-autonomous-runner"*.pid
CHILD_STATUS_GLOB="$CONTROL_DIR/live-autonomous-runner-status."*.json
USER_SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="anygpt-control-plane-autonomous-runner.service"
UNIT_FILE="$USER_SERVICE_DIR/$UNIT_NAME"
SYSTEM_UNIT_FILE="/etc/systemd/system/$UNIT_NAME"

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

user_systemd_available() {
  systemctl --user show-environment >/dev/null 2>&1
}

system_systemd_available() {
  systemctl show-environment >/dev/null 2>&1
}

direct_runner_pid() {
  local pid
  pid="$(read_pid 2>/dev/null || true)"
  if [[ -n "$pid" ]] && is_pid_alive "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi

  local pid_file candidate
  shopt -s nullglob
  for pid_file in $CHILD_PID_GLOB; do
    candidate="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
    if [[ -n "$candidate" ]] && is_pid_alive "$candidate"; then
      printf '%s\n' "$candidate"
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

direct_runner_state() {
  local pid
  pid="$(direct_runner_pid)"
  if [[ -n "$pid" ]] && is_pid_alive "$pid"; then
    printf 'active\n'
    return 0
  fi
  printf 'inactive\n'
}

any_child_pid_files_alive() {
  local pid_file pid
  shopt -s nullglob
  for pid_file in $CHILD_PID_GLOB; do
    pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && is_pid_alive "$pid"; then
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

remove_stale_child_pid_files() {
  local pid_file pid
  shopt -s nullglob
  for pid_file in $CHILD_PID_GLOB; do
    pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
    if [[ -z "$pid" ]]; then
      rm -f "$pid_file"
      continue
    fi
    if ! is_pid_alive "$pid"; then
      rm -f "$pid_file"
    fi
  done
  shopt -u nullglob
}

lane_pid_file_for_status() {
  local status_file="$1"
  local base lane
  base="$(basename "$status_file")"
  lane="${base#live-autonomous-runner-status.}"
  lane="${lane%.json}"
  if [[ -z "$lane" || "$lane" == "$base" ]]; then
    return 1
  fi
  printf '%s/live-autonomous-runner.%s.pid\n' "$CONTROL_DIR" "$lane"
}

normalize_stale_child_status_files() {
  local status_file pid_file pid
  shopt -s nullglob
  for status_file in $CHILD_STATUS_GLOB; do
    if [[ "$status_file" == "$STATUS_FILE" || "$status_file" == *.previous ]]; then
      continue
    fi

    pid_file="$(lane_pid_file_for_status "$status_file" 2>/dev/null || true)"
    if [[ -n "$pid_file" && -f "$pid_file" ]]; then
      pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
      if [[ -n "$pid" ]] && is_pid_alive "$pid"; then
        continue
      fi
    fi

    "$ROOT_DIR/bun.sh" -e '
      import fs from "node:fs";

      const statusPath = process.argv[1];
      if (!statusPath || !fs.existsSync(statusPath)) process.exit(0);

      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      } catch {
        process.exit(0);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        process.exit(0);
      }

      const now = new Date().toISOString();
      const staleNote = "Lane inactive. No live PID was found for this status file.";
      parsed.running = false;
      parsed.phase = "completed";
      parsed.lastUpdatedAt = now;
      if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        if (!parsed.summary.includes(staleNote)) {
          parsed.summary = `${parsed.summary}\n\n[cleaned] ${staleNote}`;
        }
      } else {
        parsed.summary = staleNote;
      }

      fs.writeFileSync(statusPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    ' -- "$status_file"
  done
  shopt -u nullglob
}

all_child_pid_files_dead() {
  local pid_file pid
  shopt -s nullglob
  for pid_file in $CHILD_PID_GLOB; do
    pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && is_pid_alive "$pid"; then
      shopt -u nullglob
      return 1
    fi
  done
  shopt -u nullglob
  return 0
}

normalize_stale_status_file() {
  if [[ ! -f "$STATUS_FILE" ]]; then
    return 0
  fi

  "$ROOT_DIR/bun.sh" -e '
    import fs from "node:fs";

    const statusPath = process.argv[1];
    if (!statusPath || !fs.existsSync(statusPath)) process.exit(0);

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    } catch {
      process.exit(0);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      process.exit(0);
    }

    const now = new Date().toISOString();
    const staleNote = "Runner inactive. Stale runtime state was cleaned.";
    parsed.running = false;
    parsed.phase = "completed";
    parsed.lastUpdatedAt = now;
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      if (!parsed.summary.includes(staleNote)) {
        parsed.summary = `${parsed.summary}\n\n[cleaned] ${staleNote}`;
      }
    } else {
      parsed.summary = staleNote;
    }

    if (Array.isArray(parsed.coordinatedRunners)) {
      parsed.coordinatedRunners = parsed.coordinatedRunners.map((runner) => {
        if (!runner || typeof runner !== "object") return runner;
        return {
          ...runner,
          running: false,
          phase: "completed",
        };
      });
    }

    fs.writeFileSync(statusPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  ' -- "$STATUS_FILE"
}

normalize_active_child_status_file() {
  if [[ ! -f "$STATUS_FILE" ]]; then
    return 0
  fi

  "$ROOT_DIR/bun.sh" -e '
    import fs from "node:fs";

    const statusPath = process.argv[1];
    if (!statusPath || !fs.existsSync(statusPath)) process.exit(0);

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    } catch {
      process.exit(0);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      process.exit(0);
    }

    const now = new Date().toISOString();
    const note = "Child autonomous lanes are still active; status was reattached after coordinator PID drift.";
    parsed.running = true;
    parsed.phase = "streaming";
    parsed.lastUpdatedAt = now;
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      if (!parsed.summary.includes(note)) {
        parsed.summary = `${parsed.summary}\n\n[reattached] ${note}`;
      }
    } else {
      parsed.summary = note;
    }

    if (Array.isArray(parsed.coordinatedRunners)) {
      parsed.coordinatedRunners = parsed.coordinatedRunners.map((runner) => {
        if (!runner || typeof runner !== "object") return runner;
        return {
          ...runner,
          running: true,
          phase: runner.phase && runner.phase !== "completed" ? runner.phase : "streaming",
        };
      });
    }

    fs.writeFileSync(statusPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  ' -- "$STATUS_FILE"
}

cleanup_stale_runtime_state() {
  remove_stale_child_pid_files
  normalize_stale_child_status_files

  local state pid
  state="$(service_state)"
  pid="$(service_main_pid)"

  if [[ "$state" == "active" || "$state" == "activating" || "$state" == "deactivating" ]]; then
    if [[ ! -f "$PID_FILE" ]] && any_child_pid_files_alive; then
      normalize_active_child_status_file
    fi
    return 0
  fi

  if [[ -n "$pid" && "$pid" != "0" ]] && is_pid_alive "$pid"; then
    return 0
  fi

  if any_child_pid_files_alive; then
    normalize_active_child_status_file
    return 0
  fi

  rm -f "$PID_FILE"
  if all_child_pid_files_dead; then
    normalize_stale_status_file
  fi
}

service_state() {
  local state=""
  if user_systemd_available; then
    state="$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)"
    if [[ "$state" == "active" || "$state" == "activating" || "$state" == "deactivating" ]]; then
      printf '%s\n' "$state"
      return 0
    fi
  fi
  if system_systemd_available; then
    state="$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)"
    if [[ "$state" == "active" || "$state" == "activating" || "$state" == "deactivating" ]]; then
      printf '%s\n' "$state"
      return 0
    fi
  fi
  direct_runner_state
}

service_main_pid() {
  local state="" pid=""
  if user_systemd_available; then
    state="$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)"
    if [[ "$state" == "active" || "$state" == "activating" || "$state" == "deactivating" ]]; then
      systemctl --user show --property MainPID --value "$UNIT_NAME" 2>/dev/null || true
      return 0
    fi
  fi
  if system_systemd_available; then
    state="$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)"
    if [[ "$state" == "active" || "$state" == "activating" || "$state" == "deactivating" ]]; then
      systemctl show --property MainPID --value "$UNIT_NAME" 2>/dev/null || true
      return 0
    fi
  fi
  direct_runner_pid
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

write_system_unit_file() {
  cat > "$SYSTEM_UNIT_FILE" <<EOF
[Unit]
Description=AnyGPT LangGraph autonomous control-plane runner
After=network.target anygpt.service anygpt-experimental.service

[Service]
Type=simple
User=root
WorkingDirectory=$ROOT_DIR
ExecStart=$EXEC_SCRIPT
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
}

rotate_runtime_files() {
  if [[ -f "$STATUS_FILE" ]]; then mv "$STATUS_FILE" "$STATUS_FILE.previous"; fi
  if [[ -f "$CHECKPOINT_FILE" ]]; then mv "$CHECKPOINT_FILE" "$CHECKPOINT_FILE.previous"; fi
  if [[ -f "$LOG_FILE" ]]; then mv "$LOG_FILE" "$LOG_FILE.previous"; fi
  rm -f "$PID_FILE"
  remove_stale_child_pid_files
}

terminate_direct_runner_processes() {
  local pid pid_file child_pid
  if pid="$(read_pid 2>/dev/null)" && is_pid_alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    if is_pid_alive "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi

  shopt -s nullglob
  for pid_file in $CHILD_PID_GLOB; do
    child_pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
    if [[ -n "$child_pid" ]] && is_pid_alive "$child_pid"; then
      kill -TERM "$child_pid" 2>/dev/null || true
    fi
  done
  sleep 1
  for pid_file in $CHILD_PID_GLOB; do
    child_pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
    if [[ -n "$child_pid" ]] && is_pid_alive "$child_pid"; then
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  done
  shopt -u nullglob
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
  if user_systemd_available; then
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
  fi

  if system_systemd_available; then
    write_system_unit_file
    systemctl daemon-reload
    systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
    systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
    systemctl start "$UNIT_NAME"

    for _ in $(seq 1 20); do
      state="$(service_state)"
      if [[ "$state" == "active" || "$state" == "activating" ]]; then
        echo "Runner started (service_state=$state pid=$(service_main_pid))"
        return 0
      fi
      sleep 0.5
    done

    echo "Runner failed to start; check $LOG_FILE and systemctl status $UNIT_NAME" >&2
    return 1
  fi

  nohup bash "$EXEC_SCRIPT" >/dev/null 2>&1 &
  local bootstrap_pid=$!
  printf '%s\n' "$bootstrap_pid" > "$PID_FILE"

  for _ in $(seq 1 40); do
    state="$(service_state)"
    local active_pid
    active_pid="$(service_main_pid)"
    if [[ "$state" == "active" && -n "$active_pid" ]] && is_pid_alive "$active_pid"; then
      if [[ -f "$STATUS_FILE" ]]; then
        echo "Runner started (service_state=$state pid=$active_pid)"
        return 0
      fi
    fi
    if ! is_pid_alive "$bootstrap_pid"; then
      break
    fi
    sleep 0.5
  done

  if [[ -f "$LOG_FILE" ]]; then
    echo "Runner failed to start in direct mode; recent log output:" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
  else
    echo "Runner failed to start in direct mode and no log file was written." >&2
  fi
  return 1
}

stop_runner() {
  cleanup_stale_runtime_state
  local state user_state="" system_state=""
  state="$(service_state)"
  if user_systemd_available; then
    user_state="$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)"
  fi
  if system_systemd_available; then
    system_state="$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)"
  fi

  if [[ "$user_state" == "active" || "$user_state" == "activating" || "$user_state" == "deactivating" ]]; then
    systemctl --user stop "$UNIT_NAME" || true
  elif [[ "$system_state" == "active" || "$system_state" == "activating" || "$system_state" == "deactivating" ]]; then
    systemctl stop "$UNIT_NAME" || true
  else
    terminate_direct_runner_processes
  fi

  for _ in $(seq 1 20); do
    state="$(service_state)"
    if [[ -z "$state" || "$state" == "inactive" || "$state" == "failed" ]]; then
      rm -f "$PID_FILE"
      remove_stale_child_pid_files
      normalize_stale_status_file
      echo "Runner stopped"
      return 0
    fi
    sleep 0.5
  done

  if pid="$(read_pid 2>/dev/null)" && is_pid_alive "$pid"; then
    terminate_direct_runner_processes
    rm -f "$PID_FILE"
    remove_stale_child_pid_files
    normalize_stale_status_file
    echo "Runner stopped after SIGKILL"
    exit 0
  fi

  echo "Runner did not stop cleanly; check systemctl status $UNIT_NAME or $LOG_FILE" >&2
  return 1
}

restart_runner() {
  stop_runner || true
  start_runner
}

status_runner() {
  cleanup_stale_runtime_state
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
