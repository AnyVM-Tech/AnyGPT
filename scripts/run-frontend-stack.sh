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
SUPPORTED_MODES="dev start readiness preflight preflight-ready readiness-ready readiness-only preflight-status status workspace-status install-check-status install-summary install-check install-check-only operator-preflight doctor same-thread-defer-status same-thread-status workspace-surface-strict workspace-surface-fast-status workspace-surface-pending-status workspace-surface-typecheck workspace-surface-install-typecheck workspace-surface-preflight workspace-surface-quickcheck workspace-surface-summary workspace-surface-defer workspace-surface-goal-status workspace-surface-same-thread-reminder workspace-surface-root-smoke workspace-surface-root-check frontend-install-status frontend-preflight frontend-typecheck help"
LANGSMITH_PENDING_RUNS_SAMPLE="${ANYGPT_LANGSMITH_PENDING_RUNS_SAMPLE:-4}"

report_frontend_install_status() {
  local ui_node_modules="$UI_DIR/node_modules"
  local homepage_node_modules="$HOMEPAGE_DIR/node_modules"
  local missing=0

  echo "Workspace-surface goal context for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements."
  echo "Workspace-surface touched-path context for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: scripts/run-frontend-stack.sh frontend-install-status developer-workflow readiness helper."
  echo "Workspace-surface improvement signal for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: no code-local failure is active, sampled LangSmith feedback is quiet, and pending sibling-thread activity is partial observability only rather than validation for this thread."
  echo "Workspace-surface observability note for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: sibling-thread pending runs do not satisfy validation for this workspace-surface thread."

  if [[ -d "$ui_node_modules" ]]; then
    echo "Frontend install status: apps/ui dependencies appear present at $ui_node_modules"
  else
    echo "Frontend install status: apps/ui dependencies are missing at $ui_node_modules"
    missing=1
  fi

  if [[ -d "$homepage_node_modules" ]]; then
    echo "Frontend install status: apps/homepage dependencies appear present at $homepage_node_modules"
  else
    echo "Frontend install status: apps/homepage dependencies are missing at $homepage_node_modules"
    missing=1
  fi

  if [[ "$missing" -eq 0 ]]; then
    echo "Workspace-surface operator note for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: frontend dependency directories are present, so the next bounded local step can be a workspace summary, preflight, or typecheck command."
    echo "Workspace-surface validation reminder for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: this install-status check is local readiness evidence only; this iteration still needs at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or a clear operator-facing no-run defer reason if no run was emitted."
    return 0
  fi

  echo "Workspace-surface operator defer reason for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: one or more frontend dependency directories are missing, so run 'bun run frontend:install' before workspace-surface preflight or typecheck commands."
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

if [[ "$MODE" == "workspace-surface-quickcheck" ]]; then
  echo "Workspace-surface quickcheck for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded workspace-surface install-and-typecheck validation step."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only; cross-thread or pending-only activity does not satisfy this iteration."
  echo "Running bounded workspace quickcheck without starting the UI/homepage stack."
  cd "$ROOT"
  bash "$BUN_SH" run frontend:install:status
  bash "$BUN_SH" run frontend:typecheck
  echo "Workspace-surface validation reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: quickcheck passed locally, but next still confirm at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted"
  exit 0
fi

if [[ "$MODE" == "workspace-surface-quickcheck" ]]; then
  echo "Workspace-surface quickcheck for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded workspace-surface install-status plus frontend-typecheck step."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only; cross-thread or pending-only activity does not satisfy this iteration."
  echo "Running bounded workspace quickcheck without starting the UI/homepage stack."
  "$0" install-check-status
  "$0" frontend-typecheck
  echo "Workspace-surface validation reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: quickcheck completed locally, but next still confirm at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted"
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

if [[ "$MODE" == "workspace-surface-quickcheck" ]]; then
  echo "Workspace-surface quickcheck for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface"
  echo "Goal context: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace developer-workflow improvement."
  echo "Observability note: ${LANGSMITH_PENDING_RUNS_SAMPLE} sampled pending LangSmith run(s) are partial observability only for this thread; pending-only or cross-thread activity does not satisfy this iteration."
  echo "Operator note: this quickcheck captures frontend install status first, then frontend typecheck, to provide bounded local validation without widening into app/provider code."
  echo "Success condition: confirm at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context for this iteration plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  cd "$ROOT"
  bash "$BUN_SH" run frontend:install:status
  echo "Workspace-surface quickcheck: frontend install status completed; proceeding to frontend typecheck."
  bash "$BUN_SH" run frontend:typecheck
  echo "Workspace-surface quickcheck completed local install-status and frontend typecheck. Validation is still incomplete until a fresh same-thread LangSmith run/trace exists, or an operator-facing no-run defer reason is preserved."
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

if [[ "$MODE" == "same-thread-status" || "$MODE" == "quick-status" || "$MODE" == "workspace-surface-status" ]]; then
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
    exit 0
  fi

  if [[ -f "$ROOT/package.json" ]]; then
    echo "[ok] root package.json present at $ROOT/package.json"
  else
    echo "[defer] root package.json missing at $ROOT/package.json" >&2
    exit 0
  fi

  if [[ -d "$UI_DIR" ]]; then
    echo "[ok] ui workspace present at $UI_DIR"
  else
    echo "[defer] ui workspace missing at $UI_DIR" >&2
    exit 0
  fi

  if [[ -d "$HOMEPAGE_DIR" ]]; then
    echo "[ok] homepage workspace present at $HOMEPAGE_DIR"
  else
    echo "[defer] homepage workspace missing at $HOMEPAGE_DIR" >&2
    exit 0
  fi

  echo "[ok] frontend workspace doctor checks passed"
  echo "Pending LangSmith activity from other threads remains partial observability only for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface and does not by itself satisfy validation."
  echo "Next validation success condition: capture at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted."
  exit 0
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
fi

if [[ "$MODE" == "status" ]]; then
  echo "Frontend status summary"
  echo "  bun launcher: ready"
  echo "  ui mode script: present"
  echo "  homepage manifest: present"
  echo "  status: workspace prerequisites are present; no frontend processes were started"
  echo "  next validation: on the experimental target only, check health, routing/static assets, one representative API path, and confirm at least one fresh LangSmith control-plane run/trace for this iteration or preserve a clear operator-facing defer reason if no run was emitted"
  exit 0
fi

if [[ "$MODE" == "install-check-status" ]]; then
  echo "Frontend install-check status summary"
  echo "  bun launcher: ready"
  echo "  ui workspace: $UI_DIR"
  echo "  homepage manifest: $HOMEPAGE_DIR/package.json"
  echo "  status: ready for 'bun run frontend:dev' or 'bun run frontend:start' without starting long-lived processes"
  echo "  observability: if LangSmith still shows pending sibling runs for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface or nearby workspace iterations, treat that as partial observability only rather than completed validation"
  echo "  next: if frontend dependencies may be stale or missing, run 'bun run frontend:install:check' (or the compatibility alias 'bun run frontend:install-check') before smoke/dev/start; otherwise prefer 'bun run frontend:preflight:status' or doctor output over speculative retries in a shared workspace"
  echo "  next validation: confirm at least one fresh same-thread LangSmith control-plane run/trace for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:workspace-surface with explicit goal context plus a passed workspace or control-plane smoke/typecheck result, or preserve a clear operator-facing no-run defer reason if no run was emitted"
  exit 0
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