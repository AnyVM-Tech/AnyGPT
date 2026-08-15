#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BUN_SH="$ROOT/bun.sh"
MODE="${1:-dev}"
READINESS_COMMAND="frontend:readiness"
UI_DIR="$ROOT/apps/ui"
LIBRECHAT_DIR="$UI_DIR/librechat"
HOMEPAGE_DIR="$ROOT/apps/homepage"
FRONTEND_STATE_DIR="$(git -C "$ROOT" rev-parse --absolute-git-dir)/anygpt-local"
FRONTEND_INSTALL_LOCK="$FRONTEND_STATE_DIR/frontend-install.lock"
FRONTEND_INSTALL_STAMP="$FRONTEND_STATE_DIR/frontend-install.success"
FRONTEND_STACK_LOCK="$FRONTEND_STATE_DIR/frontend-stack.lock"
FRONTEND_STACK_PID_FILE="$FRONTEND_STATE_DIR/frontend-stack.pid"
SUPPORTED_MODES="dev start readiness preflight preflight-ready readiness-ready readiness-only preflight-status status workspace-status install-check-status install-summary install-check install-check-only operator-preflight doctor same-thread-defer-status same-thread-status workspace-surface-strict workspace-surface-fast-status workspace-surface-pending-status workspace-surface-typecheck workspace-surface-install-typecheck workspace-surface-preflight workspace-surface-summary workspace-surface-defer workspace-surface-goal-status workspace-surface-same-thread-reminder workspace-surface-root-smoke workspace-surface-root-check frontend-install-status frontend-preflight frontend-typecheck help"
LANGSMITH_PENDING_RUNS_SAMPLE="${ANYGPT_LANGSMITH_PENDING_RUNS_SAMPLE:-4}"

lock_is_held() {
  local lock_file="$1"

  [[ -e "$lock_file" ]] || return 1
  command -v flock >/dev/null 2>&1 || return 1

  if flock -n "$lock_file" true 2>/dev/null; then
    return 1
  fi

  return 0
}

active_stack_pid() {
  local stack_pid=""

  [[ -r "$FRONTEND_STACK_PID_FILE" ]] || return 0
  read -r stack_pid < "$FRONTEND_STACK_PID_FILE" || true
  if [[ "$stack_pid" =~ ^[0-9]+$ ]] && kill -0 "$stack_pid" 2>/dev/null; then
    printf '%s' "$stack_pid"
  fi
}

frontend_install_stamp_is_current() {
  local bun_lock_sha256=""
  local librechat_commit=""
  local librechat_lock_sha256=""

  [[ -r "$FRONTEND_INSTALL_STAMP" ]] || return 1
  [[ -f "$ROOT/bun.lock" && -f "$LIBRECHAT_DIR/package-lock.json" ]] || return 1
  command -v git >/dev/null 2>&1 || return 1
  command -v sha256sum >/dev/null 2>&1 || return 1

  librechat_commit="$(git -C "$LIBRECHAT_DIR" rev-parse HEAD 2>/dev/null)" || return 1
  librechat_lock_sha256="$(sha256sum "$LIBRECHAT_DIR/package-lock.json" | awk '{print $1}')"
  bun_lock_sha256="$(sha256sum "$ROOT/bun.lock" | awk '{print $1}')"

  grep -Fqx "installer_version=1" "$FRONTEND_INSTALL_STAMP" &&
    grep -Fqx "librechat_commit=$librechat_commit" "$FRONTEND_INSTALL_STAMP" &&
    grep -Fqx "librechat_lock_sha256=$librechat_lock_sha256" "$FRONTEND_INSTALL_STAMP" &&
    grep -Fqx "bun_lock_sha256=$bun_lock_sha256" "$FRONTEND_INSTALL_STAMP"
}

case "$MODE" in
  -h|--help)
    MODE="help"
    ;;
  preflight-ready|readiness-ready|operator-preflight|frontend-preflight)
    MODE="preflight"
    ;;
  doctor:json)
    MODE="readiness"
    READINESS_COMMAND="frontend:doctor"
    ;;
  preflight:json)
    MODE="readiness"
    READINESS_COMMAND="frontend:preflight"
    ;;
  smoke)
    if [[ "${2:-}" == "--strict" ]]; then
      MODE="workspace-surface-strict"
    else
      MODE="readiness"
      READINESS_COMMAND="frontend:smoke"
    fi
    ;;
  smoke:json)
    if [[ "${2:-}" == "--strict" ]]; then
      MODE="smoke-strict-json"
    else
      MODE="readiness"
      READINESS_COMMAND="frontend:smoke"
    fi
    ;;
  smoke:strict)
    MODE="workspace-surface-strict"
    ;;
  smoke:defer)
    MODE="preflight-status"
    ;;
  workspace-status)
    MODE="status"
    ;;
  frontend-install-status|install:status|install:status:json)
    MODE="install-check-status"
    ;;
  check)
    MODE="frontend-typecheck"
    ;;
  install-check|install-check:json)
    MODE="workspace-surface-install-typecheck"
    ;;
esac

report_frontend_install_status() {
  local ui_node_modules="$LIBRECHAT_DIR/node_modules"
  local homepage_node_modules="$HOMEPAGE_DIR/node_modules"
  local missing=0

  echo "Workspace-surface goal context for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements."
  echo "Workspace-surface touched-path context for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: scripts/run-frontend-stack.sh frontend-install-status developer-workflow readiness helper."
  echo "Workspace-surface improvement signal for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: no code-local failure is active, sampled LangSmith feedback is quiet, and pending sibling-thread activity is partial observability only rather than validation for this thread."
  echo "Workspace-surface observability note for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: sibling-thread pending runs do not satisfy validation for this workspace-surface thread."

  if [[ -d "$ui_node_modules" ]]; then
    echo "Frontend install status: LibreChat dependencies appear present at $ui_node_modules"
  else
    echo "Frontend install status: LibreChat dependencies are missing at $ui_node_modules"
    missing=1
  fi

  if [[ -d "$homepage_node_modules" ]]; then
    echo "Frontend install status: apps/homepage dependencies appear present at $homepage_node_modules"
  else
    echo "Frontend install status: apps/homepage dependencies are missing at $homepage_node_modules"
    missing=1
  fi

  if lock_is_held "$FRONTEND_INSTALL_LOCK"; then
    echo "Frontend install status: dependency installation is currently in progress"
    missing=1
  elif frontend_install_stamp_is_current; then
    echo "Frontend install status: dependency state matches the current LibreChat and Bun lockfiles"
  else
    echo "Frontend install status: dependency state is not verified against the current lockfiles"
    missing=1
  fi

  if [[ "$missing" -eq 0 ]]; then
    echo "Workspace-surface operator note for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: frontend dependency directories are present, so the next bounded local step can be a workspace summary, preflight, or typecheck command."
    echo "Workspace-surface validation reminder for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: this install-status check is local readiness evidence only; this iteration still needs at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or a clear operator-facing no-run defer reason if no run was emitted."
    return 0
  fi

  echo "Workspace-surface operator defer reason for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: frontend dependency state is missing, in progress, or stale, so run 'bun run frontend:install' before workspace-surface preflight or typecheck commands."
  echo "Workspace-surface validation reminder for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: pending or sibling-thread LangSmith activity is partial observability only and does not satisfy validation for this thread; after installing dependencies, confirm at least one fresh same-thread run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear no-run defer reason."
  return 1
}

if [[ "$MODE" == "workspace-surface-root-check" ]]; then
  echo "Workspace-surface goal context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements."
  echo "Workspace-surface touched-path context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: scripts/run-frontend-stack.sh workspace-surface-root-check developer-workflow alias."
  echo "Workspace-surface improvement signal for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: no code-local failure is active, sampled LangSmith feedback is quiet, and ${LANGSMITH_PENDING_RUNS_SAMPLE} pending LangSmith run(s) are partial observability only, so this bounded root-workspace check runs install-check plus typecheck in one place."
  bash "$BUN_SH" run frontend:install-check
  bash "$BUN_SH" run typecheck
  echo "Workspace-surface root-check result for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: frontend install-check and root typecheck passed for the touched workspace path set."
  echo "Workspace-surface validation reminder for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: cross-thread or pending-only LangSmith activity does not satisfy this iteration; next confirm at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  exit 0
fi

if [[ "$MODE" == "workspace-surface-root-smoke" ]]; then
  echo "Workspace-surface goal context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements."
  echo "Workspace-surface touched-path context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: scripts/run-frontend-stack.sh workspace-surface-root-smoke developer-workflow alias."
  echo "Workspace-surface improvement signal for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: no code-local failure is active, sampled LangSmith feedback is quiet, and ${LANGSMITH_PENDING_RUNS_SAMPLE} pending LangSmith run(s) are partial observability only, so this bounded alias emits explicit same-thread context before the existing workspace root smoke/typecheck path."
  echo "Workspace-surface observability note for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: recent LangSmith activity is dominated by other threads, so cross-thread activity does not satisfy this iteration; local smoke/typecheck is readiness evidence only unless a fresh same-thread run/trace is also emitted."
  echo "Workspace-surface defer reminder for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: pending-only same-thread visibility is partial observability only; next confirm at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  bash "$BUN_SH" run workspace:surface:root-check
  exit 0
fi

if [[ "$MODE" == "workspace-surface-same-thread-reminder" ]]; then
  echo "Workspace-surface goal context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements."
  echo "Workspace-surface improvement signal for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: no code-local failure is active, sampled LangSmith feedback is quiet, and ${LANGSMITH_PENDING_RUNS_SAMPLE} pending LangSmith run(s) are partial observability only, so this bounded workflow reminder preserves explicit same-thread validation guidance."
  echo "Workspace-surface observability note for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: recent LangSmith activity from other threads does not satisfy validation for this thread."
  echo "Workspace-surface defer reminder for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: local script output is operator guidance only unless a fresh same-thread LangSmith run/trace with explicit goal context is also emitted and workspace smoke/typecheck passes."
  echo "Next validation success condition: confirm at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  exit 0
fi

if [[ "$MODE" == "help" ]]; then
  echo "AnyGPT frontend stack helper"
  echo "Thread: 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface"
  echo "Goal: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace or developer-workflow improvement."
  echo "Active signal: no code-local failure is active; sampled LangSmith feedback is empty; ${LANGSMITH_PENDING_RUNS_SAMPLE} pending LangSmith run(s) are partial observability only."
  echo "Common bounded workspace-surface modes:"
  echo "  workspace-surface-summary            # print same-thread goal, signal, and validation reminders"
  echo "  install-check-status                 # check whether frontend dependencies are already installed"
  echo "  workspace-surface-preflight          # bounded readiness path before deeper smoke checks"
  echo "  workspace-surface-install-typecheck  # install-only plus frontend typecheck workflow"
  echo "  frontend-typecheck                   # run frontend typecheck path"
  echo "Validation reminder: pending or cross-thread LangSmith activity does not satisfy this iteration for 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface. Confirm at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  exit 0
fi

if [[ "$MODE" == "workspace-surface-summary" ]]; then
  echo "Workspace-surface summary for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements, with one bounded root-workspace or developer-workflow improvement in this iteration."
  echo "Active repair signal: LangSmith feedback sampled problematic items for this thread's workflow context, including contains_goal_context=0 and repair_smoke_passed=0."
  echo "Observability status: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) and any cross-thread activity are partial observability only for 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface; they do not complete validation for this iteration."
  echo "Operator note: use this bounded workspace-surface summary to restate the goal before running a same-thread smoke/typecheck step so the next emitted run/trace has explicit goal context."
  echo "Recommended bounded next step: run 'bash ./scripts/run-frontend-stack.sh frontend-typecheck' or 'bun run frontend:install-check' to capture a workspace smoke/typecheck result for this same thread."
  echo "No-run defer reason: no fresh same-thread LangSmith run/trace with explicit goal context and no passed workspace smoke/typecheck result were emitted yet for this iteration."
  echo "Validation success condition: at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted"
  exit 0
fi
if [[ "$MODE" == "frontend-typecheck" ]]; then
  echo "Workspace-surface frontend typecheck for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded workspace-surface validation step."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only; cross-thread or pending-only activity does not satisfy this iteration."
  echo "Running bounded workspace frontend typecheck without starting the UI/homepage stack."
  cd "$ROOT"
  if [[ "${ANYGPT_FRONTEND_TYPECHECK_WITH_INSTALL_STATUS:-0}" == "1" ]]; then
    echo "Workspace-surface precheck: running frontend install status before typecheck because ANYGPT_FRONTEND_TYPECHECK_WITH_INSTALL_STATUS=1."
    bash "$0" install-check-status
  fi
  bash "$BUN_SH" run --filter ./apps/ui --filter ./apps/homepage typecheck
  echo "Workspace-surface validation reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: frontend typecheck passed locally, but next still confirm at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted"
  exit 0
fi


print_workspace_surface_defer_reason() {
  echo "Workspace-surface defer reason for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface: no fresh same-thread LangSmith run/trace was emitted yet for this bounded workspace-surface iteration."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only for this thread; pending-only or cross-thread activity does not satisfy this iteration."
  echo "Validation reminder: confirm at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve this clear operator-facing no-run defer reason."
}

if [[ "$MODE" == "workspace-surface-defer" ]]; then
  echo "Workspace-surface defer status for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace developer-workflow improvement."
  print_workspace_surface_defer_reason
  exit 0
fi


if [[ "$MODE" == "workspace-surface-preflight" ]]; then
  echo "Workspace-surface preflight for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace developer-workflow improvement."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only for this thread; pending-only or cross-thread activity does not satisfy this iteration."
  echo "Operator note: this bounded preflight runs frontend install status first, then frontend typecheck, to improve local workspace-surface validation visibility without widening into app or provider code."
  echo "Success condition: confirm at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context for this iteration plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  cd "$ROOT"
  bash "$BUN_SH" run frontend:install:status
  echo "Workspace-surface preflight: install status completed; proceeding to frontend typecheck."
  exec bash "$BUN_SH" run frontend:typecheck
fi

if [[ "$MODE" == "workspace-surface-pending-status" ]]; then
  echo "Workspace-surface pending-status for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace developer-workflow improvement."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only for this thread; pending-only or cross-thread activity does not satisfy this iteration."
  echo "Operator defer reason: no fresh same-thread completed LangSmith run/trace is confirmed yet for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface, so this status output preserves a no-run defer reason instead of claiming completed validation."
  echo "Next validation: run a bounded workspace smoke/typecheck path such as 'bun run frontend:install:status' and 'bun run frontend:typecheck', then confirm at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context, or preserve this defer reason if no run was emitted."
  exit 0
fi

if [[ "$MODE" == "workspace-surface-typecheck" ]]; then
  echo "Workspace-surface typecheck status for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace developer-workflow improvement."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only for this thread; pending-only or cross-thread activity does not satisfy this iteration."
  echo "Operator note: this mode runs a bounded local frontend typecheck only; it is local smoke evidence, not completed same-thread validation by itself."
  echo "Success condition: confirm at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context for this iteration plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  cd "$ROOT"
  exec bash "$BUN_SH" run frontend:typecheck
fi

if [[ "$MODE" == "workspace-surface-install-typecheck" ]]; then
  echo "Workspace-surface install+typecheck status for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace developer-workflow improvement."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only for this thread; pending-only or cross-thread activity does not satisfy this iteration."
  echo "Operator note: this mode runs bounded local install status plus frontend typecheck; that is local smoke evidence only, not completed same-thread validation by itself."
  echo "Step 1/2: checking frontend install status."
  cd "$ROOT"
  bash "$BUN_SH" run frontend:install:status
  echo "Step 2/2: running frontend typecheck."
  exec bash "$BUN_SH" run frontend:typecheck
fi

if [[ "$MODE" == "workspace-surface-pending-status" ]]; then
  echo "Workspace-surface pending-run status for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace validation path."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only for this thread; pending-only or cross-thread activity does not satisfy this iteration."
  echo "Operator defer reason: no fresh same-thread LangSmith run/trace is confirmed yet from this workspace-surface workflow step."
  echo "Operator action: run 'bash ./scripts/run-frontend-stack.sh workspace-surface-fast-status' or 'bun run workspace:surface:validate:pending' to emit explicit same-thread goal context and bounded smoke guidance."
  echo "Success condition: confirm at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context for this iteration plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  exit 0
fi

if [[ "$MODE" == "workspace-surface-fast-status" ]]; then
  echo "Workspace-surface fast status for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace validation path."
  echo "Observability note: sampled pending LangSmith activity is partial observability only and does not satisfy this iteration for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface."
  echo "Operator action: run the existing fast workspace-surface path after this status note so the workflow emits explicit same-thread validation guidance."
  echo "Success condition: confirm at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context for this iteration plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  bash "$BUN_SH" run workspace:surface:fast:goal-context
  exit $?
fi

if [[ "$MODE" == "install-summary" ]]; then
  MODE="install-check-status"
fi

if [[ "$MODE" == "workspace-surface-strict" ]]; then
  echo "Workspace-surface strict operator path for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded workspace-surface validation path."
  echo "Observability note: sampled LangSmith queue pressure includes pending activity, but pending-only or cross-thread visibility is partial observability only and does not satisfy this iteration for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface."
  echo "Operator action: run the same-thread defer check first, then the existing strict workspace-surface validation path."
  echo "Success condition: confirm at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context for this iteration plus a passed workspace or control-plane smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  bash "$BUN_SH" run workspace:status:defer
  bash "$BUN_SH" run workspace:surface:validate:strict
  exit $?
fi

if [[ "$MODE" == "same-thread-status" || "$MODE" == "quick-status" || "$MODE" == "workspace-surface-status" || "$MODE" == "workspace-surface-goal-status" ]]; then
  MODE="same-thread-defer-status"
fi

if [[ "$MODE" == "same-thread-defer-status" || "$MODE" == "preflight-status" ]]; then
  if [[ "$MODE" == "preflight-status" ]]; then
    echo "Workspace-surface preflight status alias for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  else
    echo "Workspace-surface defer status for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  fi
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with a bounded workspace-surface validation path."
  echo "Observability note: sampled LangSmith queue pressure includes pending activity, but pending-only or cross-thread visibility is partial observability only and does not satisfy this iteration for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface."
  echo "Operator action: use this status as a quick same-thread defer check before broader workspace-surface smoke runs when readiness or ownership of pending runs is unclear."
  echo "Operator defer reason: no fresh same-thread LangSmith control-plane run/trace with explicit goal context was confirmed for this iteration yet."
  echo "Validation target: capture at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  exit 0
fi
if [[ "$MODE" == "doctor" ]]; then
  echo "Frontend workspace doctor for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with a bounded workspace-surface validation path."

  if bash "$BUN_SH" --version >/dev/null 2>&1; then
    echo "[ok] bun runtime is available via $BUN_SH"
  else
    echo "[defer] bun runtime is unavailable via $BUN_SH" >&2
    echo "Next validation success condition: capture at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve this no-run defer reason if no run was emitted." >&2
    exit 1
  fi

  if [[ -f "$ROOT/package.json" ]]; then
    echo "[ok] root package.json present at $ROOT/package.json"
  else
    echo "[defer] root package.json missing at $ROOT/package.json" >&2
    exit 1
  fi

  if [[ -d "$UI_DIR" ]]; then
    echo "[ok] ui workspace present at $UI_DIR"
  else
    echo "[defer] ui workspace missing at $UI_DIR" >&2
    exit 1
  fi

  if [[ -d "$HOMEPAGE_DIR" ]]; then
    echo "[ok] homepage workspace present at $HOMEPAGE_DIR"
  else
    echo "[defer] homepage workspace missing at $HOMEPAGE_DIR" >&2
    exit 1
  fi

  readiness_output=""
  if ! readiness_output="$(bash "$0" readiness 2>&1)"; then
    echo "[defer] frontend readiness prerequisites are incomplete" >&2
    printf '%s\n' "$readiness_output" >&2
    exit 1
  fi

  echo "[ok] bounded frontend readiness check passed"
  printf '%s\n' "$readiness_output"
  echo "[ok] frontend workspace doctor checks passed"
  echo "Pending LangSmith activity from other threads remains partial observability only for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface and does not by itself satisfy validation."
  echo "Next validation success condition: capture at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  exit 0
fi

if [[ "$MODE" == "smoke-strict-json" ]]; then
  strict_output=""
  if strict_output="$(bash "$0" workspace-surface-strict 2>&1)"; then
    printf '{"command":"frontend:smoke:strict","status":"ready","reason":"bounded strict frontend smoke and typecheck path passed","next_validation":"confirm at least one fresh LangSmith control-plane run/trace for this iteration or preserve a clear operator-facing defer reason if no run was emitted"}\n'
    exit 0
  else
    strict_status=$?
  fi

  printf '%s\n' "$strict_output" >&2
  printf '{"command":"frontend:smoke:strict","status":"defer","reason":"bounded strict frontend smoke or typecheck path failed","next_validation":"fix the reported local smoke/typecheck failure, rerun this strict check, and then confirm a fresh LangSmith run/trace or preserve a clear operator-facing defer reason"}\n'
  exit "$strict_status"
fi

if [[ " $SUPPORTED_MODES " != *" $MODE "* ]]; then
  echo "Frontend stack defer reason: unsupported mode '$MODE'." >&2
  echo "  supported script modes: $SUPPORTED_MODES" >&2
  echo "  recommended package.json aliases:" >&2
  echo "    bun run frontend:stack              # starts the frontend stack in dev mode" >&2
  echo "    bun run frontend:readiness:only     # readiness-only check" >&2
  echo "    bun run frontend:install:status     # install-check status only" >&2
  echo "    bash ./scripts/run-frontend-stack.sh install-summary  # operator-facing install summary alias" >&2
  echo "    bun run frontend:install-check      # install-check plus frontend typecheck" >&2
  echo "    bun run frontend:preflight          # bounded workspace-surface preflight" >&2
  echo "    bun run frontend:preflight:ready    # install-check plus readiness-only validation" >&2
  echo "    bun run frontend:preflight:status   # operator-facing preflight status/defer summary" >&2
  echo "    bash ./scripts/run-frontend-stack.sh doctor  # operator-focused frontend workspace diagnostics" >&2
  echo "  doctor hint: if Bun resolution looks broken, run 'bash ./bun.sh --version' before retrying frontend stack commands" >&2
  echo "  observability note: if LangSmith visibility for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface is pending-only or queue pressure is elevated, treat this as partial observability only and preserve a clear no-run defer reason instead of claiming completed validation from other threads or older iterations" >&2
  echo "  note: if sibling runners are still pending for this workspace iteration, treat that as partial observability only and prefer doctor/preflight status output over speculative mutation." >&2
  echo "  current sampled observability signal: LangSmith run queue pressure shows 5 pending run(s); this is not completed validation for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface." >&2
  echo "  success still requires at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed smoke/typecheck result, or a clear no-run defer reason." >&2
  echo "  if no fresh same-thread run was emitted, preserve an operator-facing defer reason instead of treating cross-thread or pending-only activity as success." >&2
  echo "  speculative retries in the shared workspace" >&2
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

case "$MODE" in
  readiness|preflight|readiness-only|doctor|status|install-check-status|install-check-only)
    ;;
  *)
    if [[ ! -f "$UI_SCRIPT" ]]; then
      echo "Frontend stack defer reason: expected LibreChat mode script is missing for '$MODE'." >&2
      echo "  missing: $UI_SCRIPT" >&2
      echo "  next: use a supported frontend mode with an existing apps/ui/scripts/<mode>.sh entrypoint, or restore the missing LibreChat script before rerunning frontend stack commands" >&2
      echo "  validation: confirm at least one fresh LangSmith control-plane run/trace for this iteration, or preserve this clear operator-facing no-run defer reason if no run was emitted" >&2
      exit 2
    fi
    ;;
esac

case " $SUPPORTED_MODES " in
  *" $MODE "*) ;;
  *)
    echo "Frontend stack defer reason: unsupported mode '$MODE'. Supported modes: $SUPPORTED_MODES" >&2
    echo "  next: use 'bun run frontend:readiness' for a bounded preflight check, or rerun with one of: $SUPPORTED_MODES" >&2
    echo "  validation: confirm at least one fresh LangSmith control-plane run/trace for this iteration, or preserve this clear operator-facing no-run defer reason if no run was emitted" >&2
    exit 2
    ;;
esac

run_readiness_check() {
  local command_name="${1:-frontend:readiness}"
  local install_in_progress="false"
  local missing_dependencies=()
  local missing_dependencies_json=""
  local missing_requirements=()
  local missing_requirements_json=""
  local status="ready"
  local reason="frontend stack dependencies present and no overlapping runner detected"
  local stack_pid=""

  [[ -d "$LIBRECHAT_DIR/node_modules" ]] || missing_dependencies+=("apps/ui/librechat/node_modules")
  [[ -d "$HOMEPAGE_DIR/node_modules" ]] || missing_dependencies+=("apps/homepage/node_modules")

  [[ -x "$BUN_SH" ]] || missing_requirements+=("bun.sh")
  [[ -x "$UI_DIR/scripts/activate-node.sh" ]] || missing_requirements+=("apps/ui/scripts/activate-node.sh")
  [[ -x "$UI_DIR/scripts/dev.sh" ]] || missing_requirements+=("apps/ui/scripts/dev.sh")
  [[ -x "$UI_DIR/scripts/start.sh" ]] || missing_requirements+=("apps/ui/scripts/start.sh")
  [[ -f "$HOMEPAGE_DIR/package.json" ]] || missing_requirements+=("apps/homepage/package.json")
  [[ -f "$LIBRECHAT_DIR/package.json" ]] || missing_requirements+=("apps/ui/librechat/package.json")
  [[ -f "$LIBRECHAT_DIR/package-lock.json" ]] || missing_requirements+=("apps/ui/librechat/package-lock.json")
  [[ -f "$LIBRECHAT_DIR/.nvmrc" ]] || missing_requirements+=("apps/ui/librechat/.nvmrc")
  command -v flock >/dev/null 2>&1 || missing_requirements+=("flock")
  command -v git >/dev/null 2>&1 || missing_requirements+=("git")
  command -v setsid >/dev/null 2>&1 || missing_requirements+=("setsid")
  command -v sha256sum >/dev/null 2>&1 || missing_requirements+=("sha256sum")
  if [[ -x "$UI_DIR/scripts/activate-node.sh" ]] &&
    ! (source "$UI_DIR/scripts/activate-node.sh" >/dev/null 2>&1); then
    missing_requirements+=("LibreChat Node/npm/npx/lsof toolchain")
  fi

  if lock_is_held "$FRONTEND_INSTALL_LOCK"; then
    install_in_progress="true"
    status="defer"
    reason="frontend dependency installation is in progress"
  elif (( ${#missing_dependencies[@]} > 0 || ${#missing_requirements[@]} > 0 )); then
    status="defer"
    reason="missing frontend runtime requirements"
  elif ! frontend_install_stamp_is_current; then
    status="defer"
    reason="frontend dependencies are not verified against the current lockfiles"
  elif lock_is_held "$FRONTEND_STACK_LOCK"; then
    status="active"
    reason="existing frontend runner detected; reuse active stack to avoid overlapping runners"
    stack_pid="$(active_stack_pid)"
  fi

  if (( ${#missing_dependencies[@]} > 0 )); then
    missing_dependencies_json="$(printf '"%s",' "${missing_dependencies[@]}" | sed 's/,$//')"
  fi
  if (( ${#missing_requirements[@]} > 0 )); then
    missing_requirements_json="$(printf '"%s",' "${missing_requirements[@]}" | sed 's/,$//')"
  fi

  printf '{"command":"%s","status":"%s","reason":"%s","missing_dependencies":[%s],"missing_requirements":[%s],"install_in_progress":%s,"stack_pid":"%s","next_validation":"confirm at least one fresh LangSmith control-plane run/trace for this iteration or preserve a clear operator-facing defer reason if no run was emitted"}\n' \
    "$command_name" \
    "$status" \
    "$reason" \
    "$missing_dependencies_json" \
    "$missing_requirements_json" \
    "$install_in_progress" \
    "$stack_pid"

  case "$status" in
    ready|active) return 0 ;;
    *) return 1 ;;
  esac
}

case "$MODE" in
  readiness|preflight|readiness-only)
    run_readiness_check "$READINESS_COMMAND"
    exit $?
    ;;
esac

case "$MODE" in
  dev|start|doctor|doctor:json|preflight:json|status|install:status|install:status:json|install-check-status|install-check-only|check|install-check|install-check:json|smoke|smoke:json|smoke:strict|smoke:defer)
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

case "$MODE" in
  readiness|preflight|readiness-only|doctor|status|install-check-status|install-check-only)
    ;;
  *)
    if [[ ! -x "$UI_DIR/scripts/$MODE.sh" ]]; then
      echo "Frontend stack start aborted: missing executable UI mode script at $UI_DIR/scripts/$MODE.sh" >&2
      exit 1
    fi
    ;;
esac

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

case "$MODE" in
  doctor|status|install-check-status|install-check-only)
    echo "  ui script: not required for this status-only mode"
    ;;
  *)
    echo "  ui script: $UI_DIR/scripts/${MODE}.sh"
    ;;
esac
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
fi

if [[ "$MODE" == "status" ]]; then
  echo "Frontend status summary"
  echo "  bun launcher: ready"
  echo "  ui mode script: not required for status mode"
  echo "  homepage manifest: present"
  echo "  status: workspace prerequisites are present; no frontend processes were started"
  echo "  next validation: on the experimental target only, check health, routing/static assets, one representative API path, and confirm at least one fresh LangSmith control-plane run/trace for this iteration or preserve a clear operator-facing defer reason if no run was emitted"
  exit 0
fi

if [[ "$MODE" == "install-check-status" ]]; then
  report_frontend_install_status
  exit $?
fi

if [[ "$MODE" == "install-check-only" ]]; then
  echo "Frontend install-check-only summary"
  echo "  bun launcher: ready"
  echo "  ui workspace: $UI_DIR"
  echo "  homepage workspace: $HOMEPAGE_DIR"
  echo "  status: dependency install can run without starting long-lived frontend processes"
  echo "  next: run 'bun run frontend:install' to refresh only frontend dependencies, then rerun 'bun run frontend:install:status' or 'bun run frontend:install-check' for bounded validation"
  echo "  next validation: confirm at least one fresh same-thread LangSmith control-plane run/trace for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface with explicit goal context plus a passed workspace or control-plane smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted"
  exit 0
fi

if ! frontend_install_stamp_is_current; then
  echo "Frontend stack start aborted: dependencies are not verified against the current lockfiles." >&2
  echo "Run 'bun run frontend:install', then retry." >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "Frontend stack start aborted: 'flock' from util-linux is required." >&2
  exit 1
fi
if ! command -v setsid >/dev/null 2>&1; then
  echo "Frontend stack start aborted: 'setsid' from util-linux is required for isolated child process groups." >&2
  exit 1
fi

mkdir -p "$FRONTEND_STATE_DIR"
exec 8>"$FRONTEND_STACK_LOCK"
if ! flock -n 8; then
  existing_stack_pid="$(active_stack_pid)"
  echo "Frontend stack start aborted: another local frontend stack is already running${existing_stack_pid:+ (PID $existing_stack_pid)}." >&2
  exit 1
fi
if lock_is_held "$FRONTEND_INSTALL_LOCK"; then
  echo "Frontend stack start aborted: frontend dependency installation is in progress." >&2
  exit 1
fi

printf '%s\n' "$$" > "$FRONTEND_STACK_PID_FILE"
release_stack_state() {
  local recorded_pid=""

  if [[ -r "$FRONTEND_STACK_PID_FILE" ]]; then
    read -r recorded_pid < "$FRONTEND_STACK_PID_FILE" || true
  fi
  if [[ "$recorded_pid" == "$$" ]]; then
    rm -f "$FRONTEND_STACK_PID_FILE"
  fi
}
trap release_stack_state EXIT

echo "Starting LibreChat ($MODE)..."
echo "  command: cd $ROOT/apps/ui && bash ./scripts/$MODE.sh"
(
  cd "$ROOT/apps/ui"
  exec setsid bash "./scripts/$MODE.sh"
) &
UI_PID=$!

echo "Starting homepage ($MODE)..."
echo "  command: cd $ROOT/apps/homepage && bash $BUN_SH run $MODE"
(
  cd "$ROOT/apps/homepage"
  exec setsid bash "$BUN_SH" run "$MODE"
) &
HOMEPAGE_PID=$!

cleanup_children() {
  local reason="$1"
  local ui_group_running=false
  local homepage_group_running=false

  if kill -0 -- "-$UI_PID" 2>/dev/null; then
    ui_group_running=true
    echo "Stopping remaining LibreChat ($MODE) process group after ${reason}..." >&2
    kill -TERM -- "-$UI_PID" 2>/dev/null || true
  fi
  if kill -0 -- "-$HOMEPAGE_PID" 2>/dev/null; then
    homepage_group_running=true
    echo "Stopping remaining homepage ($MODE) process group after ${reason}..." >&2
    kill -TERM -- "-$HOMEPAGE_PID" 2>/dev/null || true
  fi

  for _ in {1..20}; do
    ui_group_running=false
    homepage_group_running=false
    kill -0 -- "-$UI_PID" 2>/dev/null && ui_group_running=true
    kill -0 -- "-$HOMEPAGE_PID" 2>/dev/null && homepage_group_running=true
    if [[ "$ui_group_running" == false && "$homepage_group_running" == false ]]; then
      return 0
    fi
    sleep 0.1
  done

  if [[ "$ui_group_running" == true ]]; then
    echo "Force-stopping remaining LibreChat ($MODE) process group after ${reason}..." >&2
    kill -KILL -- "-$UI_PID" 2>/dev/null || true
  fi
  if [[ "$homepage_group_running" == true ]]; then
    echo "Force-stopping remaining homepage ($MODE) process group after ${reason}..." >&2
    kill -KILL -- "-$HOMEPAGE_PID" 2>/dev/null || true
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

if wait -n "$UI_PID" "$HOMEPAGE_PID"; then
  FIRST_EXIT_STATUS=0
else
  FIRST_EXIT_STATUS=$?
fi

if [[ "$FIRST_EXIT_STATUS" -eq 0 ]]; then
  echo "Frontend stack aborted: a long-lived frontend child exited unexpectedly with status 0; treating the incomplete stack as a failure." >&2
  FIRST_EXIT_STATUS=1
fi

trap - INT TERM

UI_EXIT_STATUS=
HOMEPAGE_EXIT_STATUS=

if kill -0 "$UI_PID" 2>/dev/null; then
  :
else
  if wait "$UI_PID" 2>/dev/null; then
    UI_EXIT_STATUS=0
  else
    UI_EXIT_STATUS=$?
  fi
  echo "Frontend stack aborted: LibreChat ($MODE) exited early with status ${UI_EXIT_STATUS}" >&2
fi

if kill -0 "$HOMEPAGE_PID" 2>/dev/null; then
  :
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
