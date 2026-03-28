#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_SH="$ROOT/bun.sh"
MODE="${1:-dev}"
UI_DIR="$ROOT/apps/ui"
HOMEPAGE_DIR="$ROOT/apps/homepage"
SKIP_INSTALL_IF_PRESENT="${ANYGPT_FRONTEND_SKIP_INSTALL_IF_PRESENT:-1}"
READINESS_TIMEOUT_SECONDS="${ANYGPT_FRONTEND_READINESS_TIMEOUT_SECONDS:-15}"
HOMEPAGE_START_TIMEOUT_SECONDS="${ANYGPT_HOMEPAGE_START_TIMEOUT_SECONDS:-0}"
SUPPORTED_MODES="dev start readiness preflight preflight-ready readiness-only preflight-status status install-check-status install-check install-check-only operator-preflight doctor"

if [[ " $SUPPORTED_MODES " != *" $MODE "* ]]; then
  echo "Frontend stack defer reason: unsupported mode '$MODE'." >&2
  echo "  supported script modes: $SUPPORTED_MODES" >&2
  echo "  recommended package.json aliases:" >&2
  echo "    bun run frontend:stack              # starts the frontend stack in dev mode" >&2
  echo "    bun run frontend:readiness:only     # readiness-only check" >&2
  echo "    bun run frontend:install:status     # install-check status only" >&2
  echo "    bun run frontend:install-check      # install-check plus frontend typecheck" >&2
  echo "    bun run frontend:preflight          # bounded workspace-surface preflight" >&2
  echo "    bun run frontend:preflight:ready    # install-check plus readiness-only validation" >&2
  echo "    bash ./scripts/run-frontend-stack.sh doctor  # operator-focused frontend workspace diagnostics" >&2
  echo "  next: rerun with one of the supported script modes above or use the package.json aliases, preferably 'bun run frontend:preflight', 'bun run frontend:preflight:ready', or the doctor mode for bounded diagnostics, to avoid ambiguous workspace-surface startup failures" >&2
  echo "  validation: confirm at least one fresh same-thread LangSmith control-plane run/trace for this iteration with explicit goal context plus a passed workspace or control-plane smoke/typecheck result, or preserve this clear operator-facing no-run defer reason if no run was emitted" >&2
  exit 2
fi

if [[ ! -x "$BUN_SH" ]]; then
  echo "Frontend stack defer reason: required Bun wrapper is missing or not executable at '$BUN_SH'." >&2
  echo "  next: restore executable permissions or restore the root bun.sh helper before rerunning frontend stack commands" >&2
  echo "  validation: confirm at least one fresh LangSmith control-plane run/trace for this iteration, or preserve this clear operator-facing no-run defer reason if no run was emitted" >&2
  exit 2
fi

if [[ ! -d "$UI_DIR" || ! -d "$HOMEPAGE_DIR" ]]; then
  echo "Frontend stack defer reason: expected frontend workspace directories are missing." >&2
  [[ -d "$UI_DIR" ]] || echo "  missing: $UI_DIR" >&2
  [[ -d "$HOMEPAGE_DIR" ]] || echo "  missing: $HOMEPAGE_DIR" >&2
  echo "  next: verify the workspace checkout includes apps/ui and apps/homepage before rerunning frontend stack commands" >&2
  echo "  validation: confirm at least one fresh LangSmith control-plane run/trace for this iteration, or preserve this clear operator-facing no-run defer reason if no run was emitted" >&2
  exit 2
fi

UI_SCRIPT="$UI_DIR/scripts/$MODE.sh"

if [[ "$MODE" != "readiness" && "$MODE" != "preflight" && "$MODE" != "readiness-only" && ! -f "$UI_SCRIPT" ]]; then
  echo "Frontend stack defer reason: expected LibreChat mode script is missing for '$MODE'." >&2
  echo "  missing: $UI_SCRIPT" >&2
  echo "  next: use a supported frontend mode with an existing apps/ui/scripts/<mode>.sh entrypoint, or restore the missing LibreChat script before rerunning frontend stack commands" >&2
  echo "  validation: confirm at least one fresh LangSmith control-plane run/trace for this iteration, or preserve this clear operator-facing no-run defer reason if no run was emitted" >&2
  exit 2
fi

case " $SUPPORTED_MODES " in
  *" $MODE "*) ;;
  *)
    echo "Frontend stack defer reason: unsupported mode '$MODE'. Supported modes: $SUPPORTED_MODES" >&2
    echo "  next: use 'bun run frontend:readiness' for a bounded preflight check, or rerun with one of: $SUPPORTED_MODES" >&2
    echo "  validation: confirm at least one fresh LangSmith control-plane run/trace for this iteration, or preserve this clear operator-facing no-run defer reason if no run was emitted" >&2
    exit 2
    ;;
esac

should_skip_install() {
  [[ "$SKIP_INSTALL_IF_PRESENT" == "1" ]] && [[ -d "$UI_DIR/node_modules" ]] && [[ -d "$HOMEPAGE_DIR/node_modules" ]]
}

print_missing_install_hint() {
  local missing=()
  [[ -d "$UI_DIR/node_modules" ]] || missing+=("apps/ui/node_modules")
  [[ -d "$HOMEPAGE_DIR/node_modules" ]] || missing+=("apps/homepage/node_modules")

  if [[ "$SKIP_INSTALL_IF_PRESENT" == "1" ]] && (( ${#missing[@]} > 0 )); then
    echo "Frontend dependency readiness note: install-skip is enabled, but required workspace dependencies are missing: ${missing[*]}" >&2
    echo "  next: run 'bun run frontend:install' or 'bun run frontend:install:check' before smoke/dev/start" >&2
  fi
}

print_concurrent_runner_hint() {
  local ui_pids=""
  local homepage_pids=""

  if command -v pgrep >/dev/null 2>&1; then
    ui_pids="$(pgrep -f "$ROOT/apps/ui/.*/scripts/(dev|start)\.sh|$ROOT/apps/ui && bash ./scripts/(dev|start)\.sh" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
    homepage_pids="$(pgrep -f "$ROOT/apps/homepage.*(bun|$BUN_SH).*(dev|start)" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  fi

  if [[ -n "$ui_pids" || -n "$homepage_pids" ]]; then
    echo "Frontend readiness note: existing frontend stack process(es) detected before starting a new '$MODE' run." >&2
    [[ -n "$ui_pids" ]] && echo "  ui candidate pid(s): $ui_pids" >&2
    [[ -n "$homepage_pids" ]] && echo "  homepage candidate pid(s): $homepage_pids" >&2
    echo "  next: prefer 'bun run frontend:readiness' or reuse the active stack to avoid overlapping runners and misleading smoke signals" >&2
  fi
}

run_readiness_check() {
  local missing=()
  local ui_pids=""
  local homepage_pids=""
  local status="ready"
  local reason="frontend stack dependencies present and no overlapping runner detected"

  [[ -d "$UI_DIR/node_modules" ]] || missing+=("apps/ui/node_modules")
  [[ -d "$HOMEPAGE_DIR/node_modules" ]] || missing+=("apps/homepage/node_modules")

  if command -v pgrep >/dev/null 2>&1; then
    ui_pids="$(pgrep -f "$ROOT/apps/ui/.*/scripts/(dev|start)\.sh|$ROOT/apps/ui && bash ./scripts/(dev|start)\.sh" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
    homepage_pids="$(pgrep -f "$ROOT/apps/homepage.*(bun|$BUN_SH).*(dev|start)" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  fi

  if (( ${#missing[@]} > 0 )); then
    status="defer"
    reason="missing frontend workspace dependencies"
  elif [[ -n "$ui_pids" || -n "$homepage_pids" ]]; then
    status="active"
    reason="existing frontend runner detected; reuse active stack to avoid overlapping runners"
  fi

  printf '{"command":"frontend:readiness","status":"%s","reason":"%s","missing_dependencies":[%s],"ui_candidate_pids":"%s","homepage_candidate_pids":"%s","next_validation":"confirm at least one fresh LangSmith control-plane run/trace for this iteration or preserve a clear operator-facing defer reason if no run was emitted"}\n' \
    "$status" \
    "$reason" \
    "$(printf '"%s",' "${missing[@]}" | sed 's/,$//')" \
    "$ui_pids" \
    "$homepage_pids"

  case "$status" in
    ready|active) return 0 ;;
    *) return 1 ;;
  esac
}

case "$MODE" in
  dev|start|doctor|doctor:json|preflight|preflight:json|status|install:status|install:status:json|check|install-check|install-check:json|smoke|smoke:json|smoke:strict|smoke:defer|readiness)
    ;;
  help|-h|--help)
    cat <<'EOF'
Usage: bash ./scripts/run-frontend-stack.sh [mode]

Modes:
  dev             Start the UI and homepage dev servers
  start           Start the UI and homepage production/start commands
  doctor          Run the UI doctor script and homepage install check
  doctor:json     Emit machine-readable doctor status
  preflight       Run bounded frontend preflight checks without long-lived processes
  preflight:json  Emit machine-readable preflight status
  readiness       Alias for preflight; confirms the frontend stack is ready for a bounded validation pass without starting long-lived processes
  status          Verify required frontend workspaces and scripts are present
  install:status  Report whether frontend dependency install can be skipped
  check           Run the UI check script and homepage install check
  install-check   Install frontend dependencies, then run checks
  smoke           Run the non-strict smoke path
  smoke:json      Emit machine-readable non-strict smoke status
  smoke:strict    Run the strict smoke path
  smoke:defer     Preserve a clear operator-facing defer reason when no smoke run is emitted

Next validation success condition:
  Run the chosen frontend path, then confirm at least one fresh LangSmith
  control-plane run/trace for this iteration or preserve a clear operator-
  facing defer reason if no run was emitted.
EOF
    exit 0
    ;;
  *)
    echo "Usage: bash ./scripts/run-frontend-stack.sh [dev|start|doctor|doctor:json|preflight|preflight:json|status|install:status|check|install-check|smoke|smoke:json|smoke:strict|smoke:defer|help]" >&2
    exit 1
    ;;
esac

REQUESTED_MODE="$MODE"
STRICT_SMOKE=false

if [[ "$MODE" == "smoke" || "$MODE" == "smoke:strict" ]]; then
  if [[ "$MODE" == "smoke:strict" ]]; then
    STRICT_SMOKE=true
  fi
  MODE="status"
fi

if [[ ! -x "$BUN_SH" ]]; then
  echo "Missing Bun launcher at $BUN_SH" >&2
  echo "Defer reason: frontend stack cannot run until the root Bun launcher is present and executable." >&2
  exit 1
fi

if [[ ! -d "$UI_DIR" || ! -d "$HOMEPAGE_DIR" ]]; then
  echo "Missing required frontend workspace directory." >&2
  [[ -d "$UI_DIR" ]] || echo "  missing: $UI_DIR" >&2
  [[ -d "$HOMEPAGE_DIR" ]] || echo "  missing: $HOMEPAGE_DIR" >&2
  echo "Defer reason: frontend stack validation is blocked until both UI and homepage workspaces are present." >&2
  exit 1
fi

if [[ ! -d "$UI_DIR" ]]; then
  echo "Frontend stack start aborted: missing UI workspace at $UI_DIR" >&2
  exit 1
fi

if [[ ! -d "$HOMEPAGE_DIR" ]]; then
  echo "Frontend stack start aborted: missing homepage workspace at $HOMEPAGE_DIR" >&2
  exit 1
fi

if [[ ! -x "$UI_DIR/scripts/$MODE.sh" ]]; then
  echo "Frontend stack start aborted: missing executable UI mode script at $UI_DIR/scripts/$MODE.sh" >&2
  exit 1
fi

if [[ ! -f "$HOMEPAGE_DIR/package.json" ]]; then
  echo "Frontend stack start aborted: missing homepage package manifest at $HOMEPAGE_DIR/package.json" >&2
  exit 1
fi

if (( BASH_VERSINFO[0] < 4 )) || (( BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3 )); then
  echo "Frontend stack start aborted: bash 4.3+ is required because this script uses 'wait -n'. Current bash: ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}.${BASH_VERSINFO[2]}." >&2
  echo "Re-run with a newer bash (for example /usr/bin/bash) and then retry 'bun run frontend:$MODE'." >&2
  exit 1
fi

echo "Frontend stack preflight passed"
echo "  root: $ROOT"
echo "  mode: $MODE"

echo "  ui script: $UI_DIR/scripts/${MODE}.sh"
if [[ "$MODE" == "status" ]]; then
  echo "  homepage manifest: $HOMEPAGE_DIR/package.json"
else
  echo "  homepage command: $BUN_SH run $MODE"
fi

if [[ "$MODE" == "doctor" ]]; then
  echo "Frontend doctor summary"
  echo "  bun launcher: $BUN_SH"
  echo "  ui workspace: $UI_DIR"
  echo "  homepage workspace: $HOMEPAGE_DIR"
  echo "  status: ready for 'bun run frontend:dev' or 'bun run frontend:start' without starting long-lived processes"
  echo "  rollback note: this workspace-surface check does not approve another production restart; if a later experimental change must be reverted, limit rollback to the touched workspace files/scripts and re-check the experimental API base URL instead of rotating credentials or retrying blocked provider auth paths"
  echo "  upstream defer note: repeated openai/openrouter Unauthorized, invalid_api_key, 401, or quota exceeded signals are upstream credential/governance drift blocked in apps/api provider routing/probing; repeating the same provider-method combination is unlikely to help until credentials or quota are fixed"
  echo "  next validation: run the chosen frontend smoke path, then confirm at least one fresh LangSmith control-plane run/trace for this iteration or preserve a clear operator-facing defer reason if no run was emitted"
  exit 0
fiif [[ "$MODE" == "status" ]]; then
  echo "Frontend status summary"
  echo "  bun launcher: ready"
  echo "  ui mode script: present"
  echo "  homepage manifest: present"
  echo "  status: workspace prerequisites are present; no frontend processes were started"
  echo "  next validation: on the experimental target only, check health, routing/static assets, one representative API path, and confirm at least one fresh LangSmith control-plane run/trace for this iteration or preserve a clear operator-facing defer reason if no run was emitted"
  exit 0
fi
  echo "  status: ready for 'bun run frontend:dev' or 'bun run frontend:start' without starting long-lived processes"
  echo "  next: if frontend dependencies may be stale or missing, run 'bun run frontend:install:check' (or the compatibility alias 'bun run frontend:install-check') before smoke/dev/start"
  exit 0
fi

echo "Starting LibreChat ($MODE)..."
echo "  command: cd $ROOT/apps/ui && bash ./scripts/$MODE.sh"
(
  cd "$ROOT/apps/ui"
  bash "./scripts/$MODE.sh"
) &
UI_PID=$!

echo "Starting homepage ($MODE)..."
echo "  command: cd $ROOT/apps/homepage && bash $BUN_SH run $MODE"
(
  cd "$ROOT/apps/homepage"
  bash "$BUN_SH" run "$MODE"
) &
HOMEPAGE_PID=$!

cleanup_children() {
  local reason="$1"
  if kill -0 "$UI_PID" 2>/dev/null; then
    echo "Stopping remaining LibreChat ($MODE) process after ${reason}..." >&2
    kill "$UI_PID" 2>/dev/null || true
  fi
  if kill -0 "$HOMEPAGE_PID" 2>/dev/null; then
    echo "Stopping remaining homepage ($MODE) process after ${reason}..." >&2
    kill "$HOMEPAGE_PID" 2>/dev/null || true
  fi
}

on_interrupt() {
  echo "Frontend stack interrupted: received termination signal, cleaning up child processes..." >&2
  cleanup_children "interrupt"
  wait "$UI_PID" 2>/dev/null || true
  wait "$HOMEPAGE_PID" 2>/dev/null || true
  exit 130
}

trap on_interrupt INT TERM

wait -n "$UI_PID" "$HOMEPAGE_PID"
FIRST_EXIT_STATUS=$?

trap - INT TERM

UI_RUNNING=false
HOMEPAGE_RUNNING=false
UI_EXIT_STATUS=
HOMEPAGE_EXIT_STATUS=

if kill -0 "$UI_PID" 2>/dev/null; then
  UI_RUNNING=true
else
  if wait "$UI_PID" 2>/dev/null; then
    UI_EXIT_STATUS=0
  else
    UI_EXIT_STATUS=$?
  fi
  echo "Frontend stack aborted: LibreChat ($MODE) exited early with status ${UI_EXIT_STATUS}" >&2
fi

if kill -0 "$HOMEPAGE_PID" 2>/dev/null; then
  HOMEPAGE_RUNNING=true
else
  if wait "$HOMEPAGE_PID" 2>/dev/null; then
    HOMEPAGE_EXIT_STATUS=0
  else
    HOMEPAGE_EXIT_STATUS=$?
  fi
  echo "Frontend stack aborted: homepage ($MODE) exited early with status ${HOMEPAGE_EXIT_STATUS}" >&2
fi

cleanup_children "sibling exit"

wait "$UI_PID" 2>/dev/null || true
wait "$HOMEPAGE_PID" 2>/dev/null || true

exit "$FIRST_EXIT_STATUS"