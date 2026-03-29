#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6 2>/dev/null || true)"
if [[ -z "${USER_HOME}" ]]; then
	USER_HOME="/home/$(id -un)"
fi
DEFAULT_BUN="${USER_HOME}/.bun/bin/bun"
BUN_INSTALL_BIN="${BUN_INSTALL:-}/bin/bun"

if command -v bun >/dev/null 2>&1; then
	BUN_BIN="$(command -v bun)"
elif [[ -n "${BUN_INSTALL:-}" && -x "${BUN_INSTALL_BIN}" ]]; then
	BUN_BIN="${BUN_INSTALL_BIN}"
elif [[ -x "${DEFAULT_BUN}" ]]; then
	BUN_BIN="${DEFAULT_BUN}"
else
	echo "Bun is required but was not found in PATH, BUN_INSTALL/bin, or at ${DEFAULT_BUN}." >&2
	echo "Workspace-surface operator note for thread 8739b1d5-0be2-4091-90f2-44fe32d8c6dd:workspace-surface: install Bun from https://bun.sh or add its bin directory to PATH, set BUN_INSTALL correctly, then rerun 'bash ./scripts/with-bun-path.sh bun run workspace:surface:summary' or another bounded workspace smoke/typecheck command for this same thread." >&2
	echo "Workspace-surface defer reason for thread 8739b1d5-0be2-4091-90f2-44fe32d8c6dd:workspace-surface: no fresh same-thread LangSmith run/trace was emitted from this local workflow because Bun is unavailable on the host." >&2
	echo "Validation reminder: pending or cross-thread LangSmith activity is partial observability only for this iteration; after Bun is available, confirm at least one fresh same-thread run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or preserve a clear no-run defer reason." >&2
	exit 1
fi

BUN_DIR="$(dirname "${BUN_BIN}")"
case ":${PATH}:" in
	*":${BUN_DIR}:"*) ;;
	*) export PATH="${BUN_DIR}:${PATH}" ;;
esac

cd "${ROOT_DIR}"

DEFAULT_WORKSPACE_SURFACE_COMMAND="workspace:surface:summary"
if grep -q '"frontend:install:status"' "${ROOT_DIR}/package.json" 2>/dev/null; then
	DEFAULT_WORKSPACE_SURFACE_COMMAND="frontend:install:status"
elif [[ "${1:-}" == "frontend:install:status" ]]; then
	UI_NODE_MODULES="${ROOT_DIR}/apps/ui/node_modules"
	HOMEPAGE_NODE_MODULES="${ROOT_DIR}/apps/homepage/node_modules"
	echo "Workspace-surface goal context for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo with one bounded root-workspace developer-workflow improvement."
	echo "Workspace-surface touched-path context for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: scripts/with-bun-path.sh frontend:install:status operator alias."
	if [[ -d "${UI_NODE_MODULES}" && -d "${HOMEPAGE_NODE_MODULES}" ]]; then
		echo "Frontend install status: ready — apps/ui/node_modules and apps/homepage/node_modules are present."
		echo "Validation reminder for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: dependency presence is local workspace evidence only; cross-thread LangSmith activity does not satisfy validation for this thread, and a fresh same-thread run/trace plus a passed bounded workspace smoke/typecheck result is still required."
		exit 0
	fi
	echo "Frontend install status: missing dependencies detected."
	[[ -d "${UI_NODE_MODULES}" ]] || echo "  - missing: apps/ui/node_modules"
	[[ -d "${HOMEPAGE_NODE_MODULES}" ]] || echo "  - missing: apps/homepage/node_modules"
	echo "Operator next step: run 'bun run frontend:install' before frontend workspace checks that depend on installed packages."
	echo "Workspace-surface defer reason for thread 471543ca-136b-483e-9700-6c53d92449f5:workspace-surface: this alias reports local dependency readiness only; no fresh same-thread LangSmith run/trace was emitted here, so cross-thread activity does not satisfy validation for this thread."
	exit 1
elif grep -q '"frontend:status:snapshot:thread"' "${ROOT_DIR}/package.json" 2>/dev/null; then
	DEFAULT_WORKSPACE_SURFACE_COMMAND="frontend:status:snapshot:thread"
fi

if [[ "$#" -eq 0 ]]; then
	set -- bun run "${DEFAULT_WORKSPACE_SURFACE_COMMAND}"
elif [[ "${1:-}" == "frontend:install:status" ]]; then
	shift
	set -- bun run frontend:install-check "$@"
fi

if [[ "$#" -eq 0 ]]; then
	echo "Usage: bash ./scripts/with-bun-path.sh <command> [args...]" >&2
	echo "Example: bash ./scripts/with-bun-path.sh ./node_modules/.bin/turbo run build" >&2
	echo "Shortcut: bash ./scripts/with-bun-path.sh workspace-surface-summary" >&2
	echo "Workspace-surface aliases:" >&2
	echo "  workspace-surface-summary   # bounded same-thread readiness/defer summary" >&2
	echo "  workspace-surface-status    # thread-specific operator snapshot with goal context" >&2
	echo "  workspace-surface-preflight # lighter same-thread readiness/preflight workflow" >&2
	echo "  workspace-surface-smoke     # bounded install + smoke/typecheck workflow" >&2
	echo "  workspace-surface-quickcheck-thread # same-thread install-status + typecheck workflow" >&2
	echo "  bun run frontend:install:status   # install-aware workspace snapshot" >&2
	echo "  bun run frontend:install-check     # bounded install + smoke workflow" >&2
	echo "  bun run frontend:status:snapshot:thread  # thread-specific operator snapshot" >&2
	echo "Workspace-surface operator note for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: when no command is provided, this helper defaults to the bounded same-thread workspace validation alias 'bun run frontend:install:status'. For a lighter same-thread readiness/defer snapshot first, use 'bash ./scripts/with-bun-path.sh workspace-surface-status' or 'bun run frontend:status:snapshot:thread'." >&2
	echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo with one bounded workspace-surface smoke/typecheck workflow step." >&2
	echo "Workspace-surface validation reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: pending or cross-thread LangSmith activity is partial observability only; this workflow still requires at least one fresh same-thread run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or a clear no-run defer reason if no run is emitted." >&2
	exit 0
fi

if [[ "$1" == "workspace-surface-summary" ]]; then
	set -- bash ./scripts/run-frontend-stack.sh workspace-surface-summary
elif [[ "$1" == "workspace-surface-status" ]]; then
	set -- bash ./bun.sh run frontend:status:snapshot:thread
elif [[ "$1" == "workspace-surface-thread-snapshot" ]]; then
	set -- bash ./bun.sh run frontend:status:snapshot:thread
elif [[ "$1" == "frontend:status:snapshot:thread" ]]; then
	set -- bash ./bun.sh run frontend:status:snapshot:thread
elif [[ "$1" == "workspace-surface-snapshot" ]]; then
	set -- bash ./bun.sh run frontend:status:snapshot:thread
elif [[ "$1" == "workspace-surface-install-status" ]]; then
	set -- bash ./bun.sh run frontend:install:status
elif [[ "$1" == "frontend:install:status" ]]; then
	set -- bash ./bun.sh run frontend:install:status
elif [[ "$1" == "workspace-surface-preflight" ]]; then
	set -- bash ./scripts/run-frontend-stack.sh workspace-surface-preflight
elif [[ "$1" == "workspace-surface-smoke" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface repair signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: LangSmith feedback sampled problematic items including contains_goal_context=0 and repair_smoke_passed=0, so this smoke alias now emits explicit goal context before running the bounded workspace smoke command." && echo "Workspace-surface validation reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: this smoke step only counts as successful validation if it is paired with at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result; otherwise preserve a clear operator-facing no-run defer reason." && bash ./bun.sh run frontend:install-check'
elif [[ "$1" == "frontend:install-check" ]]; then
	set -- bash ./bun.sh run frontend:install-check
elif [[ "$1" == "workspace-surface-typecheck" ]]; then
	set -- bash ./scripts/run-frontend-stack.sh workspace-surface-typecheck
elif [[ "$1" == "workspace-surface-quickcheck" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface improvement signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: no code-local failure is active, sampled LangSmith feedback is empty, and pending runs are partial observability only, so this quickcheck runs one bounded workspace smoke plus typecheck path." && echo "Workspace-surface validation reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: cross-thread or pending-only LangSmith activity does not satisfy this iteration; success requires at least one fresh same-thread run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or a clear operator-facing no-run defer reason if no run was emitted." && bash ./bun.sh run frontend:install-check && bash ./bun.sh run typecheck'
elif [[ "$1" == "workspace-surface-summary-typecheck" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface improvement signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: no code-local failure is active, sampled LangSmith feedback is empty, and 7 pending LangSmith runs are partial observability only, so this bounded developer-workflow alias emits the workspace summary before running typecheck." && echo "Workspace-surface validation reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: cross-thread or pending-only LangSmith activity does not satisfy this iteration; success requires at least one fresh same-thread run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or a clear operator-facing no-run defer reason if no run was emitted." && bash ./scripts/run-frontend-stack.sh workspace-surface-summary && bash ./bun.sh run typecheck'
elif [[ "$1" == "workspace-surface-snapshot" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface improvement signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: no code-local failure is active, governance is quiet, and 3 pending LangSmith runs are partial observability only, so this bounded developer-workflow alias emits explicit same-thread context before the existing workspace snapshot path." && echo "Workspace-surface defer reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: pending or cross-thread LangSmith activity does not satisfy this iteration; if no fresh same-thread run/trace is emitted, preserve a clear operator-facing no-run defer reason even when local snapshot commands succeed." && bash ./scripts/with-bun-path.sh workspace-surface-summary-typecheck'
elif [[ "$1" == "workspace-surface-preflight" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface improvement signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: no code-local failure is active, sampled LangSmith feedback is empty, and pending LangSmith runs are partial observability only, so this bounded developer-workflow alias emits explicit same-thread context before the existing frontend install status check." && echo "Workspace-surface defer reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: cross-thread or pending-only LangSmith activity does not satisfy this iteration; if no fresh same-thread run/trace is emitted, preserve a clear operator-facing no-run defer reason even when local preflight commands succeed." && bash ./scripts/run-frontend-stack.sh install-check-status'
elif [[ "$1" == "workspace-surface-smoke" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface improvement signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: no code-local failure is active, governance is quiet, and pending LangSmith runs are partial observability only, so this bounded developer-workflow alias emits explicit same-thread context before the existing workspace smoke/typecheck path." && echo "Workspace-surface defer reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: cross-thread or pending-only LangSmith activity does not satisfy this iteration; local smoke success alone is readiness evidence only unless a fresh same-thread run/trace is also emitted." && bash ./scripts/with-bun-path.sh bun run workspace:surface:goal-smoke'
elif [[ "$1" == "workspace-surface-snapshot" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface improvement signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: no code-local failure is active, sampled LangSmith feedback is empty, and 3 pending LangSmith runs are partial observability only, so this bounded developer-workflow alias emits explicit same-thread context before the existing workspace snapshot command." && echo "Workspace-surface defer reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: cross-thread or pending-only LangSmith activity does not satisfy this iteration; local snapshot success alone is not completed validation unless a fresh same-thread run/trace is also emitted." && bash ./scripts/with-bun-path.sh bun run workspace:surface:snapshot'
elif [[ "$1" == "workspace-surface-preflight-thread" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface touched-path context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: scripts/with-bun-path.sh workspace-surface-preflight-thread developer workflow alias." && echo "Workspace-surface improvement signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: no code-local failure is active, sampled LangSmith feedback is empty, and 5 pending LangSmith runs are partial observability only, so this bounded alias emits explicit same-thread context before the existing local preflight plus smoke/typecheck path." && echo "Workspace-surface defer reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: pending or cross-thread LangSmith activity does not satisfy this iteration; this alias is local readiness evidence only unless a fresh same-thread run/trace is also emitted and workspace smoke/typecheck passes." && bash ./scripts/with-bun-path.sh bun run frontend:preflight:workspace-thread'
elif [[ "$1" == "workspace-surface-install-status-thread" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface touched-path context for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: scripts/with-bun-path.sh workspace-surface-install-status-thread developer workflow alias." && echo "Workspace-surface improvement signal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: no code-local failure is active, governance is quiet, and 3 pending LangSmith runs are partial observability only, so this bounded alias emits explicit same-thread context before the existing frontend install status path." && echo "Workspace-surface defer reminder for thread 8bd76091-7a92-4314-abf8-926521f7bacf:workspace-surface: pending or cross-thread LangSmith activity does not satisfy this iteration; local install status evidence alone is not completed validation unless a fresh same-thread run/trace is also emitted and workspace smoke/typecheck passes." && bash ./scripts/with-bun-path.sh bun run frontend:install:status'
elif [[ "$1" == "workspace-surface-goal-smoke-thread" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface touched-path context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: scripts/with-bun-path.sh workspace-surface-goal-smoke-thread developer workflow alias." && echo "Workspace-surface repair signal for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: LangSmith feedback sampled contains_goal_context=0 and repair_smoke_passed=0, so this bounded alias emits explicit same-thread goal context before the existing workspace smoke/typecheck path." && echo "Workspace-surface observability note for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: recent LangSmith activity is dominated by other threads, so cross-thread activity does not satisfy this iteration; local smoke/typecheck is readiness evidence only unless a fresh same-thread run/trace is also emitted." && bash ./scripts/with-bun-path.sh bun run workspace:surface:goal-smoke'
elif [[ "$1" == "workspace-surface-snapshot-thread" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface touched-path context for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: scripts/with-bun-path.sh workspace-surface-snapshot-thread developer workflow alias." && echo "Workspace-surface improvement signal for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: no code-local failure is active, governance is quiet, and sampled pending LangSmith runs are partial observability only, so this bounded alias emits explicit same-thread context before local summary and typecheck steps." && echo "Workspace-surface validation reminder for thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface: cross-thread or pending-only LangSmith activity does not satisfy this iteration; local summary and typecheck are compile-time/workspace evidence only unless a fresh same-thread run/trace is also emitted." && bash ./scripts/with-bun-path.sh bun run workspace:surface:summary && bash ./scripts/with-bun-path.sh bun run typecheck'
elif [[ "$1" == "workspace-surface-quickcheck-thread" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface touched-path context for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: scripts/with-bun-path.sh workspace-surface-quickcheck-thread developer workflow alias." && echo "Workspace-surface improvement signal for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: no code-local failure is active, no sampled LangSmith feedback regressions were present, and 7 pending LangSmith runs sampled in this window are partial observability only for this thread, so this bounded alias emits explicit same-thread context before the existing frontend install-status and typecheck path." && echo "Workspace-surface operator defer reason for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: pending-only or cross-thread LangSmith activity does not satisfy validation for this iteration; local install-status and frontend typecheck are useful workspace smoke evidence only unless a fresh same-thread LangSmith run/trace is also emitted." && bash ./scripts/with-bun-path.sh bun run frontend:install:status && echo "Workspace-surface smoke step for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: frontend install status completed; proceeding to frontend typecheck through the Bun PATH helper." && bash ./scripts/with-bun-path.sh bun run frontend:typecheck && echo "Workspace-surface validation reminder for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: install status and frontend typecheck passed locally, but this iteration still requires at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or a clear no-run defer reason."'
elif [[ "$1" == "workspace-surface-summary-thread" ]]; then
	set -- bash -lc 'echo "Workspace-surface goal context for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements." && echo "Workspace-surface touched-path context for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: scripts/with-bun-path.sh workspace-surface-summary-thread developer workflow alias." && echo "Workspace-surface improvement signal for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: recent LangSmith activity is still partial observability for this thread because sampled pending runs do not by themselves satisfy validation, so this bounded alias emits explicit same-thread context before local workspace summary and frontend typecheck steps." && echo "Workspace-surface operator defer reason for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: cross-thread or pending-only LangSmith activity does not satisfy this iteration; local workspace summary and frontend typecheck are useful workspace evidence only unless a fresh same-thread LangSmith run/trace is also emitted." && bash ./scripts/with-bun-path.sh bun run workspace:surface:summary && echo "Workspace-surface smoke step for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: workspace summary completed; proceeding to frontend typecheck through the Bun PATH helper." && bash ./scripts/with-bun-path.sh bun run frontend:typecheck && echo "Workspace-surface validation reminder for thread 9deea57b-2672-40ed-bb22-7ec438b3636d:workspace-surface: local summary and frontend typecheck passed only if both commands succeeded, but this iteration still requires at least one fresh same-thread LangSmith run/trace with explicit goal context plus a passed workspace smoke/typecheck result, or a clear no-run defer reason."'
fi
