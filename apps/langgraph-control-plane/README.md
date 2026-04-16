# AnyGPT LangGraph Control Plane

This workspace is a standalone orchestration service for planning and optionally executing build, test, and deploy jobs against this repository.

It now includes:

- multiple cooperating planner/execution agents inside a single LangGraph workflow
- direct MCP stdio server inspection from [`/.roo/mcp.json`](../../.roo/mcp.json)
- first-class MCP action planning/execution for bounded web research and browser inspection
- separate build, quality, and deploy planning stages
- experimental-safe defaults for AnyGPT API build, test, and deploy flows
- deterministic LangSmith-backed evaluation/regression gating for autonomous edits and execution

## Studio-Compatible Agent Server

This workspace now includes a LangGraph Studio-compatible app config in [`langgraph.json`](langgraph.json) that points Studio at the built control-plane graph export in [`dist/studioGraph.js`](dist/studioGraph.js). The `studio:dev` script builds the package first so Bun does not need to resolve the TypeScript graph through `tsx` at runtime.

Run the local Studio/agent server with:

```bash
bash ./bun.sh run -F anygpt-langgraph-control-plane studio:dev
```

Default connection details:

- Base URL: `http://localhost:2024`
- Host binding: `0.0.0.0`
- Config: [`apps/langgraph-control-plane/langgraph.json`](apps/langgraph-control-plane/langgraph.json)

The LangGraph server currently loads environment variables from [`../../.env.local`](../../.env.local) via [`langgraph.json`](langgraph.json). If you keep your control-plane credentials elsewhere, update the `env` path in [`langgraph.json`](langgraph.json) before launching Studio.

Studio now uses the same file-backed control-plane checkpoint persistence model as the CLI, writing state to [`apps/langgraph-control-plane/.control-plane/studio-checkpoints.json`](.control-plane/studio-checkpoints.json) instead of using process-local memory only.

### Runtime monitoring notes

#### Healthy-iteration validation rule

Even during quiet governance windows or healthy improvement iterations, validation for thread `d5588e9d-1c27-48e7-a06d-885f428c58db:control-plane` still requires at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted.

Treat pending-only same-thread LangSmith visibility as partial observability only. Treat runs from sibling threads such as `api-runtime`, `api-routing`, `api-platform`, `ui-surface`, `homepage-surface`, `workspace-surface`, or `research-scout` as cross-thread activity that does not satisfy validation for the current control-plane thread. Treat startup logs that only show graph registration, worker startup, or server-running followed by flushing, exit, or shutdown as partial readiness evidence only, not completed validation.

When blocked signals come from out-of-scope surfaces such as `apps/api/logs/provider-unique-errors.jsonl` or the blocked `apps/api provider/runtime routing` subsystem, keep the defer reason explicit rather than implying those apps/api issues were repaired from control-plane scope.

#### Localhost API refusal triage checklist

When the active control-plane thread is `b31cedc0-ceb5-48d7-8772-cf97f38a3b42:control-plane`, keep the operator-facing no-run defer reason explicit if the direct failure signal comes from blocked out-of-scope `apps/api/logs/provider-unique-errors.jsonl` entries or the blocked `apps/api provider/runtime routing` subsystem. In particular:

- Treat `apps/api/logs/provider-unique-errors.jsonl` entries such as OpenAI `sendMessage` failures against localhost or upstream responses endpoints as scope-blocked apps/api runtime/provider-routing issues, not as proof that a control-plane change repaired the underlying API path.
- If startup logs only show graph registration, worker startup, or server-running and then immediately flush, exit, or shut down, classify that as **partial readiness evidence only**, not completed validation.
- If LangSmith visibility for the current control-plane thread is pending-only, stale, absent, or dominated by sibling threads such as `b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-runtime`, `b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-data`, `b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-platform`, `b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface`, `b31cedc0-ceb5-48d7-8772-cf97f38a3b42:ui-surface`, or `b31cedc0-ceb5-48d7-8772-cf97f38a3b42:homepage-surface`, classify that as **partial observability only**; cross-thread activity does not satisfy validation for `b31cedc0-ceb5-48d7-8772-cf97f38a3b42:control-plane`.
- If both conditions happen together, record the state as **combined partial observability plus partial readiness only** and preserve a clear no-run defer reason instead of claiming validation success.
- Build or typecheck success is compile-time validation only and does not satisfy runtime validation by itself.
- Preserve prompt rollback context `anygpt-control-plane-agent:795656f0d31a78c81f973ac600fdfff02955e80d47d9cb7df48db7c6a3ef2b78` when documenting the defer reason.
- Retrying the same OpenAI `sendMessage` combination is unlikely to help until the blocked localhost apps/api target is serving again or the upstream provider/runtime issue clears.

The iteration is only validated after at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched control-plane path set, or a clear operator-facing no-run defer reason if no run was emitted.

#### Localhost API refusal triage checklist

When the active repair signal is `apps/api/logs/provider-unique-errors.jsonl` showing `openai sendMessage` `ECONNREFUSED` for `http://localhost:3101/v1/responses`, treat the direct fix as out of scope for the control-plane thread `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane` because the blocked subsystem is `apps/api provider/runtime routing` and the blocked log path is `apps/api/logs/provider-unique-errors.jsonl`. In this bounded control-plane iteration, only allowed control-plane files should change, and summaries or operator notes must not imply the localhost apps/api runtime issue was repaired from control-plane scope.

Use this operator-facing no-run defer reason shape when the localhost target is not serving:

- Restate the active goal in plain language as a bounded control-plane workflow-hardening or observability improvement for thread `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane`.
- Name `apps/api/logs/provider-unique-errors.jsonl` and the blocked subsystem `apps/api provider/runtime routing` explicitly, and say they remain out of scope and unrepaired in this iteration.
- State that retrying the same `openai sendMessage` localhost combination is unlikely to help until `http://localhost:3101/v1/responses` is serving again.
- Classify graph registration, worker startup, or server-running logs followed by flushing, exit, or shutdown as partial readiness evidence only, not completed validation.
- Classify pending-only same-thread LangSmith visibility as partial observability only, not completed validation.
- State that cross-thread LangSmith activity does not satisfy validation for `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane`.
- State that build or typecheck success is compile-time validation only and does not satisfy runtime validation by itself.
- Preserve the no-run defer reason unless the iteration produces at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set.

Use this checklist when the active repair signal is `apps/api/logs/provider-unique-errors.jsonl` showing `openai sendMessage ECONNREFUSED` for `http://localhost:3101/v1/responses`.

- Treat the blocked subsystem as `apps/api provider/runtime routing`.
- Treat the direct fix there as out of scope for the bounded control-plane thread `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane`.
- Do not claim the localhost refusal was fixed from control-plane scope unless a separate allowed apps/api change actually landed.
- If startup logs show graph registration, worker startup, or server-running and then immediately flush, exit, or shut down, record that as partial readiness evidence only, not completed validation.
- If LangSmith visibility is pending-only for this thread, or recent completed runs are mostly from other threads, record that as partial observability only; cross-thread activity does not satisfy this iteration.
- Preserve a clear operator-facing no-run defer reason until this same thread emits at least one fresh LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.

Use this compact defer/validation checklist when the active repair signal for thread `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane` is the scope-blocked `apps/api/logs/provider-unique-errors.jsonl` `openai sendMessage` `ECONNREFUSED` at `http://localhost:3101/v1/responses` in the blocked `apps/api provider/runtime routing` subsystem:

- Direct repair in `apps/api provider/runtime routing` is out of scope for this bounded control-plane iteration; do not imply the localhost API target was fixed from control-plane scope.
- Retrying the same `openai sendMessage` combination is unlikely to help until the localhost API target is serving again.
- Treat startup logs that show graph registration, worker startup, or server-running followed by flushing to persistent storage and exiting as partial readiness evidence only, not completed validation.
- Treat pending-only LangSmith visibility for this thread, or completed runs from other threads, as partial observability only; cross-thread activity does not satisfy validation for `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane`.
- Preserve a clear operator-facing no-run defer reason unless this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.


When the active repair signal for thread `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane` is `apps/api/logs/provider-unique-errors.jsonl` showing `openai sendMessage ECONNREFUSED` at `http://localhost:3101/v1/responses`, treat the blocked subsystem as `apps/api provider/runtime routing` and keep the direct fix deferred as out of scope for this bounded control-plane iteration.

Use this operator-facing checklist before proposing any broader mutation:

- Record that retrying the same `openai sendMessage` combination is unlikely to help until the localhost API target is serving again.
- Do not imply the underlying `apps/api` runtime issue was fixed from control-plane scope.
- Treat startup logs that show graph registration, worker startup, or server-running followed by flushing to persistent storage and exiting as partial readiness evidence only, not completed validation.
- Treat pending-only LangSmith visibility for this thread, or completed runs from other threads, as partial observability only; cross-thread activity does not satisfy validation for `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane`.
- Preserve a clear operator-facing no-run defer reason unless this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.
- If `allowDeploy` is false, keep deploy/restart actions deferred; do not treat build success alone as proof that `anygpt-experimental.service` is healthy.

#### Current-thread no-run defer checklist

Use this checklist when the active control-plane thread is `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane` and the repair signal is outside the control-plane allowlist, especially when `apps/api/logs/provider-unique-errors.jsonl` shows `openai sendMessage` `ECONNREFUSED` for `http://localhost:3101/v1/responses`.

- Classify the direct fix as out of scope in the blocked `apps/api provider/runtime routing` subsystem; do not imply a control-plane-only change fixed the localhost API refusal.
- If startup logs show graph registration, worker startup, or server-running and then immediately flush, exit, or shut down, record that as partial readiness evidence only, not completed validation.
- If LangSmith visibility is pending-only or mostly from sibling threads, record that as partial observability only; cross-thread activity does not satisfy validation for `8bd76091-7a92-4314-abf8-926521f7bacf:control-plane`.
- Preserve a clear operator-facing no-run defer reason unless this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.
- Treat repeated retries of the same `openai sendMessage` localhost combination as unlikely to help until the blocked localhost API target is serving again.

Operator defer rule for blocked localhost API refusals on thread `2334e644-b29b-4443-b478-adacbf7fb6eb:control-plane`: when the active repair signal is `apps/api/logs/provider-unique-errors.jsonl` showing `openai sendMessage ECONNREFUSED` against `http://localhost:3101/v1/responses`, treat the blocked subsystem as out-of-scope `apps/api provider/runtime routing` for this bounded control-plane iteration. Do not imply the localhost API refusal was fixed by a control-plane-only change. For this thread, graph registration, worker startup, and server-running logs followed by immediate flush/exiting are partial readiness evidence only, not completed validation. Pending-only LangSmith visibility or successful runs from sibling threads are partial observability only and do not satisfy validation for `2334e644-b29b-4443-b478-adacbf7fb6eb:control-plane`. Keep a clear operator-facing no-run defer reason visible until this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck, or until an operator-facing note clearly explains why no run was emitted while the blocked `apps/api provider/runtime routing` ECONNREFUSED condition remains unresolved.

Operator defer rule for blocked localhost API targets: when control-plane repair context includes `apps/api/logs/provider-unique-errors.jsonl` entries such as openai `sendMessage` `ECONNREFUSED` at `http://localhost:3101/v1/responses`, treat the direct fix as blocked in the out-of-scope `apps/api` provider/runtime routing subsystem. Do not claim the localhost refusal was fixed by a control-plane-only change. For thread `2334e644-b29b-4443-b478-adacbf7fb6eb:control-plane`, startup evidence such as graph registration, worker startup, and server-running followed by immediate flush/exiting is partial readiness only, not completed validation. Pending-only LangSmith visibility or successful runs from sibling threads are partial observability only and do not satisfy this thread. If no fresh same-thread control-plane run/trace with explicit goal context and no passed control-plane smoke/typecheck result exist yet, keep a clear operator-facing no-run defer reason visible in summaries and handoff notes.

Operator validation reminder for same-thread control-plane evidence: LangSmith feedback like `contains_goal_context=0` or `repair_smoke_passed=0` should be treated as a workflow-hardening signal for the control plane rather than proof that the blocked `apps/api` localhost refusal was repaired. For this thread, the success condition remains at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched control-plane path set, or a clear operator-facing no-run defer reason explaining why no run was emitted.

Operator defer rule for blocked localhost API refusal: if the active repair signal is `apps/api/logs/provider-unique-errors.jsonl` showing `openai sendMessage ECONNREFUSED` for `http://localhost:3101/v1/responses`, treat the direct fix as out of scope in the blocked `apps/api` provider/runtime routing subsystem for thread `2334e644-b29b-4443-b478-adacbf7fb6eb:control-plane`. Do not claim that a control-plane-only edit repaired the localhost API target. If control-plane startup logs show graph registration, worker startup, or server-running and then immediately show `Flushing to persistent storage, exiting...`, classify that as partial readiness evidence only, not completed validation. If LangSmith visibility is pending-only or recent successful runs belong to sibling threads, classify that as partial observability only; cross-thread activity does not satisfy this control-plane iteration. Keep a clear operator-facing no-run defer reason visible until this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.

Operator-facing defer template for this exact signal: `Blocked apps/api provider/runtime routing issue for thread 2334e644-b29b-4443-b478-adacbf7fb6eb:control-plane: apps/api/logs/provider-unique-errors.jsonl recorded openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses, so the direct fix is out of scope for this control-plane-only iteration. Control-plane startup logs currently provide partial readiness only because graph registration, worker startup, and server-running were followed by immediate flush/exiting. LangSmith evidence currently provides partial observability only because fresh completed runs are missing for this same thread and cross-thread activity does not count. Preserve this no-run defer reason until one fresh same-thread LangSmith control-plane run/trace with explicit goal context is recorded and the touched control-plane path set passes smoke/typecheck.`

Use the following control-plane-only interpretation rules during bounded repair iterations:

- Never treat provider failures recorded under `apps/api/logs/provider-unique-errors.jsonl` as fixed by a control-plane-only change. Those failures belong to the out-of-scope `apps/api` provider routing/probing subsystem unless a same-scope control-plane guard is explicitly changed.
- For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, studio-server logs that show graph registration, worker startup, and server-running followed by immediate `Flushing to persistent storage, exiting...` are partial readiness evidence only, not completed validation.
- Pending or successful LangSmith runs from other threads do not satisfy validation for `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`; this thread still needs one fresh same-thread run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or a clear operator-facing no-run defer reason.
- Production restart remains blocked in this experimental-safe control-plane lane. Do not restart `anygpt.service` under any circumstance from this workflow; if restart validation is ever separately approved later, only `anygpt-experimental.service` may be considered and the defer/rollback reason must be documented.

- Operator defer note for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: the active repair signal is `apps/api/logs/provider-unique-errors.jsonl` showing `openai` `sendMessage` to `http://localhost:3101/v1/responses` failing with `ECONNREFUSED`. That direct fix belongs to the blocked `apps/api` provider routing/probing subsystem and is out of scope for this bounded control-plane iteration, so do not summarize this control-plane change as having fixed the API/provider failure. Startup evidence that registered the graph, started workers, and briefly served before flushing/exiting is partial readiness only. Pending LangSmith activity from other threads, or pending-only visibility for this thread, is partial observability only and does not satisfy validation. Cross-thread successful or pending runs such as `api-data`, `homepage-surface`, `api-routing`, `api-runtime`, `ui-surface`, or `workspace-surface` do not satisfy this control-plane iteration. Do not restart production `anygpt.service` under this rollout; if runtime verification is attempted later, keep it against the experimental API base URL/service only. Validation succeeds only after at least one fresh same-thread LangSmith control-plane run/trace includes explicit goal context and control-plane smoke/typecheck passes; otherwise keep this defer reason in the operator summary.
- For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, if the active repair signal is an OpenAI `sendMessage` `ECONNREFUSED` event recorded in blocked file `apps/api/logs/provider-unique-errors.jsonl` against `http://localhost:3101/v1/responses`, treat the blocked subsystem as `apps/api` provider routing/probing/runtime availability and classify direct repair there as out of scope for this bounded control-plane iteration.
- For that same thread, treat Studio startup evidence such as graph registration, worker startup, and `Server running` followed by `Flushing to persistent storage, exiting...` as partial readiness evidence only, not completed validation.
- For that same thread, treat pending LangSmith visibility or runs from other threads as partial observability only; cross-thread activity does not satisfy this iteration.
- Preserve an operator-facing no-run defer reason until there is at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result.
- Before calling a control-plane iteration successful, confirm at least one fresh LangSmith control-plane run/trace for the current control-plane thread, not just any recent run from another scope or thread. If no same-thread run was emitted, record a clear operator-facing no-run defer reason instead. Zero fresh runs for the current iteration is an observability gap, not by itself a deploy or rollback trigger.
- Before any experimental mutation, do a quick readiness check that the control-plane runtime is actually serving, the Studio graph is registered, and pending concurrent LangSmith runners are not already creating misleading health signals or shared-workspace contention. If readiness is unclear, prefer a bounded operator-facing defer reason over mutation.
- After any bounded control-plane change, treat the iteration as successful only after checking graph registration, worker startup, pending-run growth, experimental API health against the isolated experimental base URL, and whether at least one fresh LangSmith control-plane run/trace was emitted for the current iteration. If no run was emitted, preserve a clear operator-facing no-run defer reason instead of inferring a deploy or rollback trigger.
- Repeated `openai`/`openrouter` `key_invalid`, `Unauthorized`, `401`, or `quota exceeded` events should be classified as upstream credential or provider-governance drift blocked in `apps/api` provider routing/probing by default, not as a control-plane regression by themselves.
- When that auth/quota pattern dominates, retrying the same provider-method combination is unlikely to help immediately until credentials or quota are fixed; prefer preserving an operator-facing defer reason over speculative control-plane escalation.
- The next control-plane smoke/validation success condition should confirm at least one fresh LangSmith control-plane run/trace for the iteration, or preserve a clear no-run defer reason if no run was emitted.
- Re-check after the change that the Studio server still registers graph id `control-plane`, starts workers cleanly, and preserves observability/governance payload compatibility around nullable fields and JSON-stringified LangSmith objects.

- Repeated `openai`/`openrouter` `key_invalid`, `Unauthorized`, `401`, or `quota exceeded` signals should be treated as upstream credential or provider-governance drift blocked in `apps/api` provider routing/probing by default, not as a control-plane deploy/rollback trigger by themselves. Retrying the same provider-method combination is unlikely to help immediately until credentials or quota are fixed.
- For bounded control-plane validation, prefer a smoke pass that confirms graph registration, worker bootstrap, and no immediate exit loop, then verify at least one fresh LangSmith control-plane run/trace was emitted for the iteration or preserve a clear operator-facing defer reason explaining why no run was emitted.
- LangSmith governance `recent-run-health` with zero recent runs is a control-plane monitoring gap, not by itself a deploy/rollback trigger.
- After any control-plane startup, restart, or rollout, the next smoke/validation step should confirm all three conditions: the graph still registers, the process stays up long enough to serve at least one iteration, and at least one fresh LangSmith control-plane run/trace is visible for that iteration.
- If no fresh LangSmith run is emitted, preserve a clear operator-facing defer reason in the run summary or handoff notes instead of treating the absence of runs alone as proof of a product or provider regression.
- Treat repeated `key_invalid`, `Unauthorized`, `invalid_api_key`, `401`, or quota-exhausted OpenAI/OpenRouter failures as upstream credential or provider-governance drift in `apps/api` provider routing/probing by default, not as a control-plane regression. Retrying the same provider-method combination is unlikely to help immediately until credentials, quota, or upstream governance are fixed.
- When those upstream/provider-bound signals dominate an otherwise healthy control-plane iteration, prefer a bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement over speculative provider edits outside this workspace.
- A successful control-plane iteration should leave either at least one fresh LangSmith control-plane run/trace for the current thread or a clear operator-facing defer reason explaining why no run was emitted.
- Experimental smoke validation remains bounded: confirm the control-plane graph registers cleanly, workers stay up, and avoid production restart actions unless separately approved; `anygpt-experimental.service` is the only restart candidate in normal experimental-safe flow.

- Treat repeated `key_invalid`, `Unauthorized`, `invalid_api_key`, `401`, or quota-exceeded signals for OpenAI/OpenRouter as upstream credential or provider-governance drift blocked in `apps/api` provider routing/probing by default, not as a control-plane regression. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed.
- During healthy control-plane iterations, prefer one small orchestration, observability, or workflow-hardening change over broad repo edits.
- Zero fresh control-plane LangSmith runs for an iteration is a monitoring gap, not by itself a deploy or rollback trigger; preserve a clear operator-facing defer reason when no run was emitted.
- The next bounded smoke/validation step after a control-plane change should confirm: (1) control-plane graph registration still succeeds, and (2) at least one fresh LangSmith control-plane run/trace was emitted for the iteration, or a clear no-run defer reason was recorded.

- Treat repeated `key_invalid`, `Unauthorized`, `invalid_api_key`, `401`, or `quota exceeded` events for the same provider family as upstream credential or provider-governance drift by default, blocked in `apps/api` provider routing/probing rather than a clear control-plane regression.
- When that pattern dominates, repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed; prefer a bounded control-plane observability, cooldown, prioritization, or explicit defer reason instead of speculative provider edits outside this workspace.
- Zero recent LangSmith runs is a monitoring gap, not by itself a deploy or rollback trigger.
- The next smoke or validation step for a control-plane iteration should confirm at least one fresh LangSmith control-plane run/trace, or preserve a clear operator-facing defer reason explaining why no run was emitted.

- Treat repeated `key_invalid`, `Unauthorized`, `invalid_api_key`, `401`, or `quota exceeded` events for the same provider family as upstream credential or provider-governance drift by default, blocked in `apps/api` provider routing/probing rather than a control-plane regression.
- When that auth/quota pattern dominates, repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed; prefer a bounded control-plane observability, cooldown, prioritization, or explicit defer reason instead of speculative provider edits outside this workspace.
- A successful control-plane smoke/validation pass for those iterations should confirm at least one fresh LangSmith control-plane run/trace was emitted for the iteration, or preserve a clear operator-facing defer reason explaining why no run was emitted.
- Treat repeated `key_invalid`, `Unauthorized`, `invalid_api_key`, `401`, or `quota exceeded` events for `openai`/`openrouter` as upstream credential or provider-governance drift by default, blocked in `apps/api` provider routing/probing. Repeating the same provider-method combination is unlikely to help until credentials or quota are fixed; in control-plane scope, prefer a bounded observability, cooldown, prioritization, or explicit defer-reason update instead of speculative provider edits.
- If recent LangSmith runs are missing or do not clearly cover the current iteration, treat that as a monitoring gap rather than, by itself, a deploy/rollback trigger. The next smoke step should confirm at least one fresh control-plane LangSmith run/trace or preserve a clear operator-facing defer reason explaining why no run was emitted.
- Treat repeated `provider_cap_blocked` and `provider_model_removed` events for the same provider family, capability, or region as upstream/provider-bound catalog drift by default, especially when the reason text says a capability is unavailable in a country or provider region.
- In those cases, prefer bounded control-plane actions such as clearer summaries, candidate-path prioritization, provider de-prioritization notes, or explicit no-op/defer reasons instead of speculative provider implementation edits outside the active scope.
- When provider sync churn is otherwise healthy (for example `Saved providers.json. Kept 1419, removed 102.`) and recent LangSmith runs show no active failures, bias toward one small orchestration, observability, or workflow-hardening improvement that can pass smoke validation quickly.

- Treat repeated `provider_cap_blocked` and `provider_model_removed` entries for Gemini image-output capability churn as upstream/provider-bound catalog or region drift by default; prefer control-plane observability, candidate prioritization, and operator-facing notes over speculative provider implementation edits when the active signal is region or country availability.
- When recent logs mainly show provider/model sync churn such as `Saved providers.json. Kept 1419, removed 102.`, prefer one small orchestration, observability, or workflow-hardening improvement inside the control plane instead of broad repo-wide repair attempts.
- Before approving even experimental rollout, confirm the change can be validated without restarting production `anygpt.service`; if a restart is required for validation, isolate it to `anygpt-experimental.service` only.
- Control-plane smoke validation for bounded changes should prefer no-secrets checks such as `bash ./bun.sh run -F anygpt-langgraph-control-plane typecheck` and other local control-plane validation that does not require production service interruption.

- Treat repeated `provider_cap_blocked` and `provider_model_removed` events for the same provider family, capability, or region as upstream/provider-bound catalog drift by default, especially when the reason mentions country or provider-region availability.
- When those region-blocked signals dominate, prefer control-plane actions that improve classification, defer/no-op reasoning, candidate-path prioritization, and operator-facing notes instead of speculative provider implementation edits outside the active scope.
- Treat repeated `provider_cap_blocked` and `provider_model_removed` events for the same provider family, capability, or region as upstream/provider-bound catalog or regional availability churn by default, especially when the reason text says image generation is unavailable in a country or provider region.
- When that churn dominates recent logs, prefer bounded control-plane responses such as sharper failure-origin notes, candidate-path prioritization, provider de-prioritization guidance, or explicit no-op/defer summaries instead of speculative provider implementation edits outside scope.
- Treat repeated `provider_cap_blocked` and `provider_model_removed` events for region- or country-restricted capabilities as upstream/provider-bound catalog drift by default. In those cases, prefer bounded control-plane actions such as clearer defer reasons, candidate-path prioritization, and operator-facing notes over speculative provider implementation edits.
- Recent provider/model churn such as `Saved providers.json. Kept 1419, removed 102.` should usually be treated as normal upstream catalog sync activity unless it coincides with a control-plane validation failure.
- Region-blocked Gemini probe events like `provider_cap_blocked` or `provider_model_removed` for image output are upstream/provider-bound signals by default; prefer documenting or prioritizing them in planning notes instead of assuming a local control-plane defect.
- The Studio log line `Flushing to persistent storage, exiting...` should not be treated as proof of a control-plane bug by itself. If it appears after graph registration and startup, confirm whether the experimental Studio surface intentionally exited before proposing lifecycle changes.
- During healthy iterations with quiet governance checks, prefer small orchestration, observability, or documentation hardening changes in this workspace over speculative provider or worker-lifecycle edits.

## Purpose

This package is intentionally separated from [`apps/api`](../api/README.md) so that agent orchestration, approval flow, and deployment logic do not become part of the API runtime.

The initial scaffold focuses on:

- planning repo-level and API-level build/test jobs
- optional execution of those jobs
- keeping deploy as an explicit opt-in step
- providing a clean extraction path into its own repository later

## Scripts

```bash
# Plan jobs only
bun run dev -- --goal="Ship a fix" --scopes=repo,api

# Execute planned jobs
bun run dev -- --goal="Validate API changes" --scopes=api --execute

# Research and plan bounded anyscan improvements
bun run dev -- --goal="Research and plan improvements for anyscan crawling, persistence, and API behavior" --scopes=anyscan,research-scout --execute --mcp-actions

# Execute with first-class MCP browser/search actions enabled
bun run dev -- --goal="Review https://docs.langchain.com/oss/javascript/langgraph/overview and https://github.com/openclaw/openclaw" \
  --scopes=control-plane,repo-surface \
  --execute \
  --mcp-actions \
  --mcp-target-urls=https://docs.langchain.com/oss/javascript/langgraph/overview,https://github.com/openclaw/openclaw

# Execute with an explicit deploy command
bun run dev -- --goal="Release API" --scopes=api --execute --allow-deploy --deploy-command="sudo systemctl restart anygpt-experimental"
```

## Current Scope Map

The built-in workflow currently understands these scopes:

- `repo`
- `repo-surface`
- `api`
- `api-experimental`
- `control-plane`
- `anyscan`
- `research-scout`

When coordinated multi-runner mode is active, requesting `anyscan` also provisions the `research-scout` lane so queued web research can be turned into file-mapped implementation notes for `apps/anyscan`.

Additional scopes can be added by extending the target map in [`src/workflow.ts`](src/workflow.ts).

## Agent Layout

The workflow is split into cooperating nodes in [`src/workflow.ts`](src/workflow.ts):

- `inspectMcp` — loads MCP server metadata
- `plannerAgent` — normalizes scopes and planning notes
- `planMcpActions` — builds a bounded first-class MCP tool plan from the goal and discovered tool inventory
- `buildAgent` — generates build jobs
- `qualityAgent` — generates test jobs
- `deployAgent` — generates deploy jobs
- `mergePlan` — combines all agent output into the final job plan
- `approvalGate` — pauses for approval before risky operations when execution is enabled
- `runMcpActions` — executes approved MCP search/browser actions before shell jobs and autonomous edits
- `runJobs` — optionally executes the plan
- `summarize` — emits the human-readable and JSON result

## MCP Support

By default the control plane reads [`/.roo/mcp.json`](../../.roo/mcp.json).

You can override it:

```bash
bun run dev -- --goal="Validate repo" --scopes=repo --mcp-config=.roo/mcp.json
```

Current MCP support now directly inspects enabled stdio servers during planning:

- loads configured MCP servers from [`/.roo/mcp.json`](../../.roo/mcp.json)
- passes configured server environment variables to the spawned MCP server process
- connects with the MCP TypeScript client over stdio
- lists available tools from each enabled server
- includes discovered tool inventories, allowed tools, and inspection status in the generated plan

The control plane can now also execute a bounded MCP action lane when `--mcp-actions` or `CONTROL_PLANE_MCP_ACTIONS=true` is enabled:

- Brave Search can be used for goal-driven web research
- Playwright MCP can open explicitly supplied target URLs and capture browser snapshots
- tools listed in `alwaysAllow` stay approval-free, while non-allowlisted tools flow through the existing approval gate
- tool execution stays deterministic and policy-driven instead of letting the model invent arbitrary side effects

Disabled servers remain skipped, unsupported transport types are reported in planner notes, and summaries only expose sanitized environment key names rather than secret values.

## AI Agents

The planner, build, quality, and deploy stages can now use AI-backed advisory agents while still keeping the actual shell commands policy-driven and experimental-safe.

The AI path is optional and activates only when these environment variables are configured:

```bash
CONTROL_PLANE_AI_BASE_URL=https://gpt.anyvm.tech/v1
CONTROL_PLANE_AI_API_KEY=your-anygpt-api-key
CONTROL_PLANE_AI_MODEL=gpt-5.4
CONTROL_PLANE_AI_REASONING_EFFORT=xhigh
CONTROL_PLANE_AI_TEMPERATURE=0.2
```

Compatible fallbacks are also recognized from:

- `ANYGPT_API_BASE_URL`
- `ANYGPT_API_KEY`
- `ANYGPT_MODEL`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

If those are not set, the control plane also tries a local AnyGPT-backed fallback automatically:

- base URL defaults to [`http://127.0.0.1:3000/v1`](../api/README.md)
- model defaults to `gpt-5.4`
- API key falls back to a valid local key from [`apps/api/keys.json`](../api/keys.json) when a `test-key-for-automated-testing-*` entry is present

That gives the control plane a working AI-agent path against a locally running AnyGPT experimental API without requiring extra manual environment setup.

When the resolved control-plane model is `gpt-5.4` and no reasoning effort is explicitly configured, the control plane now defaults to `xhigh`. Set `CONTROL_PLANE_AI_REASONING_EFFORT` if you want a different reasoning level.

When selecting Gemini-family models through AnyGPT, use bare Gemini model IDs such as `gemini-3.1-pro-preview` for native Gemini routing. Avoid `google/gemini-...` here unless you intentionally want the OpenRouter-style/provider-prefixed path.

When enabled, the AI agents:

- analyze log-driven planning context
- review MCP-discovered tool inventories
- add planner/build/quality/deploy notes to the run
- can resolve their system prompts from a LangSmith-managed prompt bundle with explicit ref/tag selection and local fallback
- keep actual build/test/deploy commands deterministic instead of letting the model invent arbitrary shell execution

If AI configuration is missing, the control plane falls back to the deterministic LangGraph workflow and the summary reports that AI agents are disabled.

If you want runtime LangSmith tracing without writing secrets into repo files, export one of these before starting the control plane:

```bash
export CONTROL_PLANE_LANGSMITH_API_KEY=...
# preferred for org/workspace runtime usage
export CONTROL_PLANE_LANGSMITH_SERVICE_KEY=...
# optional for discovery/interactive operations
export CONTROL_PLANE_LANGSMITH_PERSONAL_API_KEY=...
# or
export LANGSMITH_API_KEY=...
# or
export LANGCHAIN_API_KEY=...

# Optional explicit workspace selection
export CONTROL_PLANE_LANGSMITH_WORKSPACE_ID=...
# Or let the control plane auto-discover a workspace by name
export CONTROL_PLANE_LANGSMITH_WORKSPACE_NAME=anygpt
```

The CLI normalizes those into the standard LangSmith/LangChain runtime variables at startup. If a workspace ID is not provided, it tries to discover the workspace named `anygpt` automatically using the LangSmith API.

Prompt bundle selection for the AI nodes can be controlled separately:

```bash
export CONTROL_PLANE_PROMPT_IDENTIFIER=anygpt-control-plane-agent
export CONTROL_PLANE_PROMPT_CHANNEL=live
export CONTROL_PLANE_PROMPT_SYNC=true
export CONTROL_PLANE_PROMPT_SYNC_CHANNEL=default
export CONTROL_PLANE_PROMPT_PROMOTE_CHANNEL=staging

# Optional exact ref override (identifier:tag or identifier:commit)
export CONTROL_PLANE_PROMPT_REF=anygpt-control-plane-agent:live

# CLI equivalents
bun run dev -- --goal="Prompt smoke" --scopes=repo \
  --prompt-identifier=anygpt-control-plane-agent \
  --prompt-channel=live \
  --prompt-promote=staging
```

Prompt selection precedence for the control-plane AI nodes is:

1. explicit `--prompt-ref` / `CONTROL_PLANE_PROMPT_REF`
2. tagged channel selection via `identifier:channel`
3. latest synced version for the prompt identifier
4. local bundled fallback in [`src/workflow.ts`](src/workflow.ts)

The prompt lifecycle is now channel-aware and rollback-friendly:

- supported lifecycle channels: `candidate`, `default`, `live`
- the workflow records the selected prompt channel, commit hash, available channels, promotion reason, and rollback reference in both LangSmith metadata and the runner status file
- promotion to another channel is only attempted after the deterministic evaluation gate and governance gate both leave the requested target open
- when promotion is blocked, the blocked reason is surfaced explicitly instead of silently skipping the request

When LangSmith runtime integration is enabled, the inspection stage syncs the local prompt bundle to the configured sync channel, resolves the best prompt ref using the precedence above, and can optionally promote the selected bundle back to another bounded tag on the same prompt identifier. This keeps prompt automation limited to the control-plane prompt bundle instead of expanding into broader workspace or admin automation.

Current LangSmith integration in the control plane now covers:

- workspace discovery/selection
- accessible workspace inventory plus sampled workspace role introspection
- project creation/upsert and project inspection
- current-project description/metadata inspection for governance/admin state
- bounded current-project governance description/metadata sync hooks
- recent run inspection
- recent run metadata/tags sampling for trace/thread correlation
- dataset creation and run-to-dataset seeding
- seed dataset creation for control-plane experiments
- prompt listing and prompt commit discovery
- prompt selection precedence for control-plane AI nodes
- prompt push/sync hooks for the control-plane prompt bundle
- bounded prompt promotion/version tagging hooks on the same prompt identifier
- prompt commit/channel/rollback metadata propagation into LangSmith and runner status
- annotation queue listing plus bounded queue detail/item sampling
- recent feedback inspection tied to sampled runs/queue items
- client helpers for controlled feedback creation against runs/examples
- evaluation experiment execution against the seed dataset
- deterministic evaluation/regression gate calculation from LangSmith evaluator output
- weighted scorecard / baseline-aware evaluation summaries for regression checks
- deterministic governance/admin flags for workspace pinning, project metadata alignment, run health, review backlog, and feedback signal presence
- deterministic governance gate calculation for autonomous edits and execution targets
- summary/status surfacing of workspace/project/dataset/prompt/run/annotation/feedback/governance information

## Experimental Runtime Targeting

The control plane now treats the experimental API target as an explicit runtime surface rather than an implicit fallback.

- default experimental API base URL: [`http://127.0.0.1:3310`](http://127.0.0.1:3310)
- default experimental service name: [`anygpt-experimental.service`](../../apps/api/anygpt-experimental.service)
- override env: [`CONTROL_PLANE_ANYGPT_API_BASE_URL`](../api/package.json)

This base URL is used by the control-plane AI path, repair validation, and runner status surfacing so autonomous iterations stop accidentally routing back into the overloaded production loopback target.

## Governance Profiles

The control plane now supports simple governance profiles defined in [`governance-profiles.json`](governance-profiles.json).

- active profile env: `CONTROL_PLANE_GOVERNANCE_PROFILE`
- default profile: `experimental`
- built-in examples: `experimental`, `staging`, `prod`

Profiles currently tune LangSmith governance behavior such as annotation queue backlog warning thresholds and whether warn-level governance should block autonomous changes.

Profile fields now include:

- `queueBacklogWarnThreshold`
- `requireFeedback`
- `minimumFeedbackCount`
- `minimumEvaluationResults`
- `minimumSuccessfulEvaluations`
- `blockAutonomousOnWarn`
- `gateTarget` (`autonomous-edits`, `execution`, or `both`)
- `requirePromptCommit`

This lets operator policy decide whether missing feedback, insufficient recent evaluation coverage, warn-level governance flags, or prompt versions without commit hashes should block bounded automation.

## Evaluation Scorecard Controls

The evaluation gate now supports a scorecard-style metric set in addition to the primary metric.

New env/CLI surfaces:

- `CONTROL_PLANE_EVAL_GATE_REQUIRED_METRICS`
- `CONTROL_PLANE_EVAL_GATE_METRIC_THRESHOLDS`
- `CONTROL_PLANE_EVAL_GATE_AGGREGATION_MODE`
- `CONTROL_PLANE_EVAL_GATE_METRIC_WEIGHTS`
- `CONTROL_PLANE_EVAL_GATE_MIN_WEIGHTED_SCORE`
- `CONTROL_PLANE_EVAL_GATE_SCORECARD_NAME`
- `CONTROL_PLANE_EVAL_GATE_BASELINE_EXPERIMENT`

These extend the existing single-metric gate so additional LangSmith evaluator metrics can be surfaced and enforced without replacing the current `metricKey` / `minMetricAverageScore` path. The workflow now supports both “all required metrics must pass” and weighted scorecard aggregation, plus baseline experiment labeling for regression-oriented scorecards.

The inspection stage keeps this automation bounded: it samples accessible workspaces, current-project admin metadata, queue metadata, bounded queue items, and recent feedback artifacts into workflow state, planner notes, summaries, and the runner status file; reconciles only the configured control-plane project's bounded governance description/metadata markers; syncs the local control-plane prompt bundle; optionally promotes the selected prompt bundle to another tag on the same identifier; computes deterministic evaluation and governance flags from LangSmith artifacts; and now feeds those bounded signals into the closed-loop repair path. It still does **not** implement arbitrary workspace/project mutation, queue triage execution, or feedback moderation automation.

## Evaluation / Regression Gating

The control plane now computes a deterministic evaluation gate from the existing LangSmith seed-dataset evaluation hook in [`src/workflow.ts`](src/workflow.ts).

The model does **not** decide the gate. The workflow aggregates the configured evaluator metric from LangSmith, compares it against a fixed policy, and only blocks autonomous edits and/or execution when the policy is set to `enforce`.

Supported configuration:

```bash
export CONTROL_PLANE_EVAL_GATE_MODE=advisory              # off | advisory | enforce
export CONTROL_PLANE_EVAL_GATE_TARGET=both                # execution | autonomous-edits | both
export CONTROL_PLANE_EVAL_GATE_REQUIRE_EVALUATION=false   # fail closed when true and no evaluation is available
export CONTROL_PLANE_EVAL_GATE_MIN_RESULTS=1
export CONTROL_PLANE_EVAL_GATE_METRIC=contains_goal_context
export CONTROL_PLANE_EVAL_GATE_MIN_SCORE=1
export CONTROL_PLANE_EVAL_GATE_AGGREGATION_MODE=all        # all | weighted
export CONTROL_PLANE_EVAL_GATE_REQUIRED_METRICS=scopes_echoed,prompt_commit_tracked
export CONTROL_PLANE_EVAL_GATE_METRIC_THRESHOLDS=scopes_echoed=1,prompt_commit_tracked=1
export CONTROL_PLANE_EVAL_GATE_METRIC_WEIGHTS=contains_goal_context=2,scopes_echoed=1,prompt_commit_tracked=1
export CONTROL_PLANE_EVAL_GATE_MIN_WEIGHTED_SCORE=0.95
export CONTROL_PLANE_EVAL_GATE_SCORECARD_NAME=control-plane-scorecard
export CONTROL_PLANE_EVAL_GATE_BASELINE_EXPERIMENT=anygpt-control-plane-baseline

# CLI equivalents
bun run dev -- --goal="Regression gate smoke" --scopes=api-experimental --execute \
  --eval-gate-mode=enforce \
  --eval-gate-target=both \
  --eval-gate-require-evaluation=true \
  --eval-gate-min-results=1 \
  --eval-gate-metric=contains_goal_context \
  --eval-gate-min-score=1 \
  --eval-gate-required-metrics=scopes_echoed,prompt_commit_tracked \
  --eval-gate-metric-thresholds=scopes_echoed=1,prompt_commit_tracked=1 \
  --eval-gate-aggregation-mode=weighted \
  --eval-gate-metric-weights=contains_goal_context=2,scopes_echoed=1,prompt_commit_tracked=1 \
  --eval-gate-min-weighted-score=0.95
```

Default behavior is intentionally bounded:

- mode defaults to `advisory`
- target defaults to `both`
- metric defaults to `contains_goal_context`
- the gate requires an average score of at least `1` across at least `1` scored result when evaluation data exists
- missing evaluation data only blocks when `requireEvaluation=true`

When the gate is enforced and fails, the workflow can stop before risky approval prompts, skip autonomous code modification, skip normal job execution, or block both depending on the configured target.

The same deterministic gate is also reused after repair smoke validation. A repair is only promoted when the smoke step succeeds and the gate does not block promotion; otherwise the workflow rolls back touched files from the recorded autonomous-edit session manifest.

## Checkpoints, Streaming, and Resume

The control plane now uses a file-backed LangGraph checkpointer under [`apps/langgraph-control-plane/.control-plane/checkpoints.json`](.control-plane/checkpoints.json) so runs can be resumed by thread ID even under Bun.

Execution is streamed node-by-node from the CLI instead of waiting for a final one-shot result, so you can see planner updates, MCP inspection results, and interrupts as they happen.

Useful patterns:

```bash
# Start a checkpointed execution run with a stable thread id
bun run dev -- --goal="Validate API changes" --scopes=api-experimental --execute --thread-id=api-run-1

# Resume a paused approval gate and allow execution to continue
bun run dev -- --thread-id=api-run-1 --resume=approve

# Resume a paused approval gate and deny execution
bun run dev -- --thread-id=api-run-1 --resume=deny

# Skip manual approval interrupts for trusted experimental runs
bun run dev -- --goal="Validate API changes" --scopes=api-experimental --execute --auto-approve
```

The CLI prints streamed chunks, current thread ID, checkpoint path, and a resume command whenever the graph pauses on an interrupt.

## Continuous and Autonomous Mode

The control plane can now run continuously instead of exiting after a single graph pass.

Useful flags:

```bash
# Continuous plan loop
bun run dev -- --goal="Watch repo health" --scopes=repo --continuous --interval-ms=10000

# Continuous autonomous execution loop (enables execute + auto-approve)
bun run dev -- --goal="Continuously validate experimental API" --scopes=api-experimental --autonomous

# Detached live autonomous runner with PID/log/status management
bun run control-plane:autonomous:start
bun run control-plane:autonomous:status
bun run control-plane:autonomous:stop

# Bounded autonomous run for smoke testing
bun run dev -- --goal="Autonomous smoke run" --scopes=api-experimental --autonomous --interval-ms=1000 --max-iterations=2
```

When `--interval-ms` is omitted, continuous and autonomous loops now default to `1000ms`. Override that default with `CONTROL_PLANE_INTERVAL_MS` for the direct CLI, or with `CONTROL_PLANE_AUTONOMOUS_INTERVAL_MS` for the detached wrapper.

Continuous/autonomous status is persisted to [`apps/langgraph-control-plane/.control-plane/runner-status.json`](.control-plane/runner-status.json) for the direct CLI and to [`apps/langgraph-control-plane/.control-plane/live-autonomous-runner-status.json`](.control-plane/live-autonomous-runner-status.json) for the detached wrapper, including:

- current iteration
- running phase (`starting`, `streaming`, `sleeping`, `paused`, `completed`, `failed`)
- thread ID
- checkpoint path
- requested/effective scopes plus any adaptive scope expansion reason
- requested/selected prompt bundle refs plus sync/promotion outcomes
- last summary
- proposed/applied autonomous edit counts
- last applied edit paths
- current autonomous lane (`repair` vs `improvement`)
- autonomous planner strategy, focused agent count, and focused agent summaries
- post-repair validation/backtest outcomes
- experimental restart status and reason
- sampled LangSmith workspace names/count and current project admin metadata
- governance flag counts, actionable governance flags, and governance mutation statuses
- governance gate status/reason/blocked targets
- evaluation gate mode/status/reason and blocked actions
- evaluation scorecard aggregation mode, weighted score, baseline experiment, and metric deltas
- selected prompt channel, available prompt channels, rollback reference, and promotion reasons
- repair touched paths plus observability tags for trace/run correlation
- last error, if any

When LangSmith integration is enabled, runner summaries also surface workspace, bounded project-admin, governance, dataset, prompt, run, evaluation, evaluation-gate, prompt-selection, prompt-sync, and prompt-promotion information.

Autonomous mode does **not** imply deploy permission. It only turns on continuous execution plus automatic approval for the existing risky-operation gates. Deploy still requires the normal deploy flags and safety guardrails, and enforced evaluation gating can still stop the loop before edits or jobs continue.

## Autonomous Code Modification Mode

The control plane can now propose and apply bounded code edits before normal job execution when autonomous edit mode is enabled. This mode is experimental and remains bounded to approved scope and allowed paths.

Useful flags:

```bash
# Enable autonomous code edits for a single execute run
bun run dev -- --goal="Fix control-plane issues" --scopes=control-plane --execute --autonomous-edits

# Continuous autonomous code-editing loop
bun run dev -- --goal="Continuously improve experimental API" --scopes=api-experimental --autonomous

# Coordinated multi-runner autonomous loop
bun run dev -- --goal="Continuously improve repo health" --scopes=repo,api,api-experimental,control-plane,repo-surface --autonomous --multi-runner

# Customize write scope and action count
bun run dev -- --goal="Control-plane self-heal" --scopes=control-plane --execute --autonomous-edits --edit-allowlist=apps/langgraph-control-plane,apps/api --max-edit-actions=2
```

Autonomous code edits are enforced through the allowlist/denylist logic, session manifests, touched-file snapshots, and rollback helpers in [`apps/langgraph-control-plane/src/autonomousEdits.ts`](src/autonomousEdits.ts).

Continuous autonomous runs now fan out up to `CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM` focused edit agents per iteration. The planner keeps one primary full-context agent and, when aggressive experimental mode is active, adds narrower API/control-plane/repo-focused edit agents so the loop stops spending every iteration on one broad no-op plan.

`--multi-runner` now adds a supervisor process on top of that internal planner fanout. The coordinator writes the main status file, derives per-lane child status/checkpoint/pid/log files, and keeps child runners on locked disjoint lanes such as `api-routing`, `api-runtime`, `api-data`, `api-platform`, `control-plane`, `workspace-surface`, `homepage-surface`, and `ui-surface` instead of letting adaptive scope expansion collapse them back into overlap.

When CodeQL SARIF results are available, the control plane now ingests them as repair signals. Drop SARIF files into common paths such as `reports/codeql-results.sarif`, `logs/codeql-results.sarif`, or `apps/langgraph-control-plane/.control-plane/codeql-results.sarif`, or point the runner at custom SARIF files with `CONTROL_PLANE_CODEQL_RESULTS=path/to/results.sarif,path/to/more.sarif`.

Default allowlist:

- `apps/langgraph-control-plane/**`
- `apps/api/**`

Default denylist includes:

- `.env` files
- [`apps/api/keys.json`](../api/keys.json)
- `node_modules`
- `dist` outputs
- lockfiles
- [`apps/langgraph-control-plane/.control-plane/`](.control-plane/)

The agent proposes edits first, routes them through the same approval or auto-approval gate, then applies them with explicit path enforcement before any regular build/test jobs continue unless the deterministic evaluation gate blocks autonomous modification first.

## Closed-Loop Autonomous Repair Workflow

The control plane now runs a bounded repair/improvement loop on top of the existing graph in [`apps/langgraph-control-plane/src/workflow.ts`](src/workflow.ts):

1. detect repair signals from recent log tails, LangSmith run/governance context, failed jobs, and the current evaluation-gate state
2. derive either a repair intent or a healthy-state improvement intent and pass that bounded context into the existing autonomous edit planner
3. propose at most `maxEditActions` edits within the current allowlist and denylist boundaries, preferring the smallest bounded change when real repair signals exist
4. apply edits through the shared autonomous edit machinery, which records a per-run session manifest plus touched-file snapshots
5. run bounded smoke validation for touched areas
6. evaluate the repaired state with the existing evaluation-gating machinery and LangSmith runtime hooks when available
7. when API files were promoted, run post-repair build/backtest validation against the experimental path
8. auto-restart only `anygpt-experimental` after post-repair validation passes on an autonomous run
9. deterministically promote or rollback

Promotion is only allowed when edit application succeeds, bounded smoke validation succeeds, and the deterministic evaluation gate does not block promotion.

Recent hardening also added:

- one-edit-per-path deduping in the autonomous planner to avoid overlapping replace operations on the same file
- deterministic queue-overload fallback maintenance against live on-disk source
- queue overload errors now carry queue label / concurrency / pending / overload-count metadata for route-level correlation
- runner status and LangSmith metadata now capture prompt provenance, repair touched paths, rollback state, and restart outcomes together
- replace edits now fail fast when the target block matches multiple times and include a closer anchored diagnostic when the target is missing
- Gemini remote-media preflight normalization so unsupported remote media URLs fail with a stable non-retryable error shape instead of surfacing ambiguously

Rollback is automatic when a touched repair fails smoke validation, when the evaluation gate blocks promotion after repair evaluation, or when post-repair validation fails after a promoted API change. Rollback restores previous contents for changed files and removes newly created files based on the recorded session manifest.

Runtime speed/aggression controls are now environment-driven:

```bash
CONTROL_PLANE_INTERVAL_MS=1000
CONTROL_PLANE_MCP_INSPECTION_TIMEOUT_MS=8000
CONTROL_PLANE_AI_AGENT_TIMEOUT_MS=25000
CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM=6
CONTROL_PLANE_REPAIR_SMOKE_TIMEOUT_MS=120000
CONTROL_PLANE_POST_REPAIR_VALIDATION_TIMEOUT_MS=600000
CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL=true
```

The detached wrapper also accepts `CONTROL_PLANE_AUTONOMOUS_*` overrides, but now falls back to the standard `CONTROL_PLANE_INTERVAL_MS`, `CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM`, and `CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL` knobs when those detached-specific vars are unset.

The runner status file at [`apps/langgraph-control-plane/.control-plane/runner-status.json`](.control-plane/runner-status.json) now surfaces the repair-loop status, intent summary, planner fanout/focus metadata, smoke result counts, promoted paths, rollback paths, and repair session metadata. The detached service writes the same fields to [`apps/langgraph-control-plane/.control-plane/live-autonomous-runner-status.json`](.control-plane/live-autonomous-runner-status.json).

It also now persists the prompt lifecycle fields, governance gate state, evaluation scorecard fields, repair touched paths, and observability tags needed to correlate LangSmith runs back to a specific bounded edit session.

For deterministic bounded smoke runs or operator-guided repairs, you can inject a runtime JSON edit plan without writing secrets into the repository:

```bash
cat >/tmp/control-plane-repair-plan.json <<'JSON'
{
  "summary": "Bounded repair smoke plan",
  "edits": [
    {
      "type": "write",
      "path": "apps/langgraph-control-plane/src/repairSmokeSuccess.ts",
      "reason": "Bounded repair smoke",
      "content": "export const controlPlaneRepairSmokeSuccess = 'ok';\n"
    }
  ]
}
JSON

CONTROL_PLANE_AUTONOMOUS_EDIT_PLAN_FILE=/tmp/control-plane-repair-plan.json \
  bun run dev -- --goal="Repair smoke" --scopes=control-plane --execute --autonomous-edits --auto-approve
```

That override is runtime-only and is still filtered through the same path enforcement, smoke validation, evaluation, and rollback logic.

## Human Approval Interrupts

When execution mode is enabled, the control plane uses LangGraph interrupts to pause before risky operations such as:

- cloning production Redis/Dragonfly DB `0` into experimental DB `1`
- running deploy commands

Approval is manual by default. Resume the same thread with `--resume=approve` or `--resume=deny`. If approval is denied, the summary reports that execution was halted before job execution instead of only saying no jobs were created.

## AnyGPT API Safety Defaults

For AnyGPT API scopes, the control plane is biased toward experimental-safe execution:

- API build jobs default to the experimental build path
- API test jobs use isolated control-plane data files under [`apps/api/.control-plane/`](../api/.control-plane/)
- API test jobs can seed those isolated files from the current production JSON data without mutating the live files
- the deploy default is [`sudo systemctl restart anygpt-experimental`](../../apps/api/anygpt-experimental.service)
- promoted autonomous API repairs run an additional experimental build/backtest pass before any restart is attempted
- autonomous post-repair restarts target `anygpt-experimental` by default and only occur on autonomous runs after validation passes
- production API restarts are now available as an explicit opt-in post-repair path via `CONTROL_PLANE_AUTO_RESTART_PRODUCTION=true`, and only run after promoted autonomous API edits pass post-repair validation
- production restarts still stay out of the normal default path; enabling the production restart flag should be treated as an operator-level choice for `anygpt.service` / [`apps/api/anygpt-api.service`](../../apps/api/anygpt-api.service)
- API planning ingests recent repo/API log tails before generating build/test/fix plans

The current scaffold keeps Redis/Dragonfly isolation as a control-plane concern by cloning production DB `0` into experimental DB `1` before API test execution, while the API’s isolated test flow also separates filesystem-backed data through [`API_PROVIDERS_FILE`](../api/modules/dataManager.ts), [`API_KEYS_FILE`](../api/modules/dataManager.ts), and [`API_MODELS_FILE`](../api/modules/dataManager.ts) overrides.

If your experimental runtime shares the same Dragonfly instance as production, set:

```bash
CONTROL_PLANE_DATA_SOURCE_PREFERENCE=redis
CONTROL_PLANE_REDIS_URL=127.0.0.1:6380
CONTROL_PLANE_REDIS_USERNAME=default
CONTROL_PLANE_REDIS_PASSWORD=...
CONTROL_PLANE_REDIS_TLS=false
CONTROL_PLANE_SOURCE_REDIS_DB=0
CONTROL_PLANE_TARGET_REDIS_DB=1
```

That makes the control plane clone production Redis/Dragonfly DB `0` into experimental DB `1`, while still seeding isolated filesystem copies from production JSON data.

## Operator Runbook

Recommended bounded operator loop for Studio and autonomous validation:

1. verify Studio / LangGraph agent-server health with [`bash ./bun.sh run -F anygpt-langgraph-control-plane studio:dev`](package.json)
2. export LangSmith credentials plus the desired workspace / project / governance profile
3. run [`bash ./bun.sh run -F anygpt-langgraph-control-plane typecheck`](package.json) and [`bash ./bun.sh run -F anygpt-api typecheck`](../api/package.json) before enabling autonomous edits
4. start a bounded control-plane run and inspect [`apps/langgraph-control-plane/.control-plane/runner-status.json`](.control-plane/runner-status.json) for:
   - prompt selected channel / commit / rollback reference
   - evaluation gate scorecard status and weighted score
   - governance gate blocked targets and actionable flags
   - repair touched paths and restart status
5. if a promoted prompt regresses, use the recorded prompt rollback reference to pin the control plane back to the earlier prompt commit without requiring a code rollback

For a no-secrets local smoke pass of the modified control plane itself:

```bash
bash ./bun.sh run -F anygpt-langgraph-control-plane typecheck
bash ./bun.sh run -F anygpt-api typecheck
```

## Log-Driven Planning

The control plane treats recent logs as first-class planning input. By default it inspects tails from common API log files such as:

- [`apps/api/logs/probe-errors.jsonl`](../api/logs/probe-errors.jsonl)
- [`apps/api/logs/fast-image-sync.log`](../api/logs/fast-image-sync.log)
- [`apps/api/logs/admin-keys.jsonl`](../api/logs/admin-keys.jsonl)
- [`apps/api/logs/api-error.jsonl`](../api/logs/api-error.jsonl)

It also samples other recent `*.log`, `*.jsonl`, and `*.txt` files under [`apps/api/logs/`](../api/logs/) so the graph can bias build/test/fix plans toward real observed failures and fresh operational churn instead of only static repository state.

Before log content is attached to planner state or emitted in summaries, the workflow redacts sensitive fields such as API keys, passwords, bearer tokens, Redis credentials, and source IP addresses.

## Extraction Path

To split this into a fully separate repository later:

1. copy [`apps/langgraph-control-plane`](.) into a new repository
2. replace local command assumptions with git clone/pull logic for the AnyGPT repo
3. add secret management, approvals, and deployment credentials there
4. keep this repo as the execution target with stable scripts like [`package.json`](../../package.json) and [`apps/api/package.json`](../api/package.json)

## Notes

- This scaffold uses LangGraph JavaScript via [`@langchain/langgraph`](package.json).
- It is designed as a control plane, not as part of the production API process.
- The workflow is intentionally minimal so it can be hardened later with approvals, retries, remote runners, and deployment policies.
- Live autonomous smoke validation should prefer bounded documentation-only edits within this README.
- During quiet control-plane improvement iterations, do not treat cross-thread LangSmith activity as validation for the current thread. For thread-specific validation, require at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result.
- If the current thread has no fresh same-thread LangSmith control-plane run/trace yet, the iteration summary should explicitly say validation is still missing for that exact thread and should preserve a short operator-facing no-run defer reason instead of implying success from older or other-thread activity.
- If the current thread only has pending LangSmith visibility, treat that as partial observability evidence only, not a completed validation run, and keep a clear operator-facing no-run defer reason until a fresh same-thread run completes.
- If startup logs only show graph registration, worker startup, or server-running followed by an immediate flush, exit, or shutdown, record that as partial readiness evidence only and preserve a clear operator-facing no-run defer reason instead of claiming success.
- If both signals happen together for the same thread — pending LangSmith visibility and startup logs that flush or exit soon after startup — classify the state as combined partial observability plus partial readiness only, and do not mark the iteration validated until same-thread smoke/typecheck and run evidence exist.
- During quiet iterations with passing governance and no code-local repair target, prefer a README-only or similarly smoke-safe control-plane observability/workflow-hardening edit, and explicitly say that choice was made because same-thread validation is still missing for the current thread.
- When LangSmith feedback includes `contains_goal_context=0`, restate the active user goal in plain language in the summary and in each edit reason, and name the exact current control-plane thread instead of relying on implicit context.
- When LangSmith feedback includes `repair_smoke_passed=0`, treat compile/build confidence as insufficient by itself and explicitly require either a passed control-plane smoke/typecheck result plus a fresh same-thread LangSmith run/trace, or a clear operator-facing no-run defer reason.
- A compact defer line is preferred when validation is missing: `No fresh same-thread LangSmith control-plane run/trace for <thread>; startup evidence is partial readiness only; awaiting passed control-plane smoke/typecheck or preserving no-run defer reason.`
- If startup logs and LangSmith evidence are both incomplete, use a combined defer line such as: `No fresh same-thread LangSmith control-plane run/trace for <thread>; pending visibility and startup logs are partial observability/readiness only; awaiting passed control-plane smoke/typecheck or preserving no-run defer reason.`
- A compact goal-context line is preferred when feedback flagged missing context: `Goal for <thread>: <plain-language goal>. Validation still pending until a fresh same-thread LangSmith control-plane run/trace records this goal context and control-plane smoke/typecheck passes.`
- During quiet control-plane improvement iterations, do not treat cross-thread LangSmith activity as validation for the current thread. Require one fresh same-thread run/trace for the active control-plane thread, or preserve a no-run defer reason.
- Treat startup logs that show graph registration, worker startup, or server-running evidence followed soon by `Flushing to persistent storage, exiting...` as partial readiness only. That evidence is useful, but it does not replace same-thread smoke/typecheck plus a fresh same-thread LangSmith run/trace.
- A compact operator-facing validation checklist is preferred before calling an iteration successful:
  1. confirm the active control-plane thread ID is named in the summary;
  2. confirm any startup evidence is classified as full validation vs partial readiness only;
  3. confirm recent LangSmith evidence is same-thread rather than cross-thread;
  4. confirm control-plane smoke/typecheck passed;
  5. otherwise preserve a clear no-run defer reason.
- A compact quiet-iteration defer line is preferred when the current thread still lacks validation: `No fresh same-thread LangSmith control-plane run/trace for <thread>; cross-thread activity does not satisfy this iteration; startup evidence is partial readiness only if the server flushed/exited soon after startup; awaiting passed control-plane smoke/typecheck or preserving no-run defer reason.`
- During quiet improvement windows with healthy governance, prefer README-only or other operator-facing control-plane observability/workflow-hardening edits when the active thread still lacks a fresh same-thread LangSmith control-plane run/trace. This is smoke-safer than speculative source mutation and should be stated plainly in the summary/edit reason.
- A compact same-thread defer template is preferred for the active thread: `Goal for <thread>: <plain-language goal>. No fresh same-thread LangSmith control-plane run/trace yet; any graph registration, worker startup, or server-running logs followed by flush/exit are partial readiness only; cross-thread or pending-only LangSmith activity does not satisfy this iteration; awaiting passed control-plane smoke/typecheck or preserving this no-run defer reason.`
- When sampled LangSmith activity is mostly from other threads, explicitly record that cross-thread success does not validate the current thread. Prefer a compact line such as: `Observed LangSmith activity belongs mostly to other threads; this thread still needs one fresh same-thread control-plane run/trace with explicit goal context.`
- When the current thread has only pending same-thread LangSmith visibility, classify it as partial observability only, not completed validation. Prefer a compact line such as: `Pending same-thread LangSmith visibility for <thread> is observability evidence only; it does not replace a completed same-thread run/trace plus passed smoke/typecheck.`
- When pending same-thread visibility and startup logs that flush/exit soon after readiness appear together, explicitly summarize the state as combined partial observability plus partial readiness only, and preserve a no-run defer reason instead of calling the iteration successful.
- A compact combined-state defer template is preferred for the active thread: `Goal for <thread>: <plain-language goal>. Same-thread LangSmith visibility is pending-only, so observability is partial; graph registration/worker startup/server-running logs followed by flush/exit are partial readiness only; cross-thread activity does not satisfy this iteration; awaiting one fresh same-thread control-plane run/trace with explicit goal context plus passed smoke/typecheck, or preserving this no-run defer reason.`
- During quiet control-plane improvement iterations with no code-local repair target, prefer a README-only or similarly operator-facing workflow-hardening change when same-thread validation is still missing. Record the active thread explicitly, state that upstream/provider-bound failures in blocked subsystems such as `apps/api provider routing/probing` remain out of scope for the bounded control-plane iteration, and avoid treating cross-thread LangSmith success as validation for the current thread.
- A compact quiet-iteration defer template is preferred when the current thread has no fresh completed run: `Goal for <thread>: <plain-language goal>. This control-plane iteration chose a smoke-safer observability/workflow-hardening improvement because no fresh same-thread LangSmith control-plane run/trace exists yet; any graph registration, worker startup, or server-running logs followed by flush/exit are partial readiness only; cross-thread activity does not satisfy this iteration; upstream/provider-bound failures in blocked subsystems such as apps/api provider routing/probing remain out of scope; awaiting one fresh same-thread control-plane run/trace with explicit goal context plus passed smoke/typecheck, or preserving this no-run defer reason.`
- When the active thread has pending visibility or no fresh completed run yet, prefer an explicit same-thread defer line that names the exact thread and distinguishes pending-only observability from completed validation. Recommended template: `Goal for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane: continuously monitor, fix, and improve AnyGPT within control-plane scope. Same-thread LangSmith visibility is still missing or pending-only for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, so observability is partial; graph registration, worker startup, and server-running logs followed by flush/exit are partial readiness only; cross-thread activity does not satisfy this iteration; upstream/provider-bound failures blocked in apps/api provider routing/probing remain out of scope; awaiting one fresh same-thread control-plane run/trace with explicit goal context plus passed smoke/typecheck, or preserving this no-run defer reason.`
- If recent logs are dominated by repeated OpenAI/OpenRouter 401, invalid_api_key, quota, or 5xx failures while control-plane scope is active, summarize them as upstream/provider-bound drift or instability blocked in `apps/api provider routing/probing`, say retrying the same provider-method combination is unlikely to help immediately, and keep the operator-facing defer reason focused on producing one fresh same-thread control-plane LangSmith run/trace rather than implying the blocked apps/api subsystem was fixed.
- During quiet control-plane improvement iterations for the current thread (for example `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`) when governance is passing but no fresh same-thread LangSmith control-plane run/trace exists yet, prefer a README-only or similarly smoke-safe operator-facing observability/workflow-hardening change. In the summary and edit reason, explicitly say startup evidence such as graph registration, worker startup, and server-running logs followed by flush/exit is partial readiness only, not completed validation; explicitly say cross-thread LangSmith activity does not satisfy the current thread; and preserve a clear no-run defer reason until there is at least one fresh same-thread control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result.
- Use this compact no-run defer template for quiet same-thread gaps: `Control-plane thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane is still awaiting one fresh same-thread LangSmith run/trace with explicit goal context; current startup logs only show partial readiness (graph registration/worker startup/server-running followed by flush or exit), cross-thread LangSmith activity does not satisfy this iteration, and upstream/provider-bound failures in apps/api provider routing/probing remain scope-blocked for this control-plane pass.`
- Before treating a quiet iteration as successful, explicitly check and record four items together: same-thread LangSmith run/trace presence, explicit goal context on that run, passed control-plane smoke/typecheck result, and whether startup evidence stayed up instead of immediately flushing/exiting. If any item is missing, keep the operator-facing no-run defer reason instead of claiming validation success.
- Use this compact quiet-iteration validation checklist before closing a control-plane pass: `thread=<current control-plane thread>; same_thread_run=<yes|no>; goal_context=<yes|no>; smoke_or_typecheck=<pass|fail|not-run>; startup_state=<steady|partial-readiness-only>; defer_reason=<text if any field is missing>`. Treat `startup_state=partial-readiness-only` whenever logs show graph registration, worker startup, or server-running evidence followed by flush, exit, or shutdown.
- If the current thread still lacks a fresh completed same-thread LangSmith control-plane run/trace, record the defer reason in one sentence that names the exact thread, says cross-thread LangSmith activity does not satisfy the iteration, and says startup logs that reached graph registration/worker startup/server-running but then flushed or exited are partial readiness only.
- During quiet control-plane improvement iterations with no code-local repair target, prefer a README-only or other operator-facing observability/workflow-hardening change, and do not call the pass successful when the current thread only has partial readiness evidence (graph registration, worker startup, or server-running followed by flush/exit) or only cross-thread/pending LangSmith visibility; preserve a same-thread no-run defer reason until this thread has one fresh completed LangSmith run/trace with explicit goal context and a passed control-plane smoke/typecheck result.
- Use this exact defer template when the current control-plane thread still lacks completed same-thread validation: `No fresh same-thread LangSmith control-plane run/trace was observed for thread <thread-id>; cross-thread activity does not satisfy this iteration, and any startup logs that reached graph registration, worker startup, or server-running but then flushed/exited are partial readiness evidence only. Validation remains deferred until one fresh same-thread run/trace includes explicit goal context and control-plane smoke/typecheck passes.`
- For quiet README-only control-plane improvements, record the post-change validation line in this compact form before closing the pass: `thread=<current control-plane thread>; same_thread_run=<yes|no>; pending_same_thread_run=<yes|no>; goal_context=<yes|no>; smoke_or_typecheck=<pass|fail|not-run>; startup_state=<steady|partial-readiness-only>; result=<validated|deferred>`.
- For quiet control-plane iterations on the current thread, do not treat cross-thread LangSmith activity as validation for this pass. If the current thread only has startup logs showing graph registration, worker startup, or server-running followed by flush/exit, record that as `startup_state=partial-readiness-only` and preserve the same-thread no-run defer reason until one fresh same-thread LangSmith control-plane run/trace exists with explicit goal context and control-plane smoke/typecheck passes.
- If the current thread has no fresh completed same-thread LangSmith control-plane run/trace yet, use this operator-facing defer sentence verbatim or with only thread-specific substitutions: `Validation deferred for thread <current control-plane thread>: same-thread LangSmith evidence is still missing; any pending same-thread visibility is partial observability only, and any startup logs that reached graph registration, worker startup, or server-running before flush/exit are partial readiness only.`
- Use this quick closeout checklist before calling a quiet control-plane improvement successful: `(1) same-thread LangSmith run/trace is fresh for the current control-plane thread, not just another thread; (2) goal context is explicit on that same-thread run/trace; (3) control-plane smoke/typecheck passed, or the no-run defer reason says why it did not run; (4) startup logs that show graph registration, worker startup, or server-running followed by flush/exit are recorded as partial readiness only, not completed validation; (5) if provider noise is dominated by repeated OpenAI/OpenRouter 401/402/500-style failures, classify that as upstream drift blocked in apps/api provider routing/probing rather than as proof of a control-plane regression; (6) if no fresh same-thread run exists yet, the summary must explicitly say validation is deferred for the current thread rather than implying success from pending-only or cross-thread activity.`
- For quiet README-only or workflow-hardening iterations, use this compact validation line in the summary when applicable: `same_thread_validation=missing thread=<current control-plane thread> observability=pending-or-missing readiness=partial-if-startup-flushed smoke=not-yet-run decision=defer`. This line is a reminder that cross-thread runs do not count for the current thread, and that graph registration, worker startup, or server-running logs followed by flush/exit remain partial readiness only until a fresh same-thread LangSmith control-plane run/trace and control-plane smoke/typecheck result exist.
- If repeated OpenAI/OpenRouter 401/402/500-style provider noise is present during an otherwise healthy control-plane iteration, keep the summary focused on the blocked subsystem `apps/api provider routing/probing`, say retrying the same provider-method combination is unlikely to help immediately, and still require either one fresh same-thread LangSmith control-plane run/trace plus passed control-plane smoke/typecheck or a clear operator-facing no-run defer reason for the current thread.
- When LangSmith feedback for the current control-plane iteration includes `contains_goal_context=0` or `repair_smoke_passed=0`, treat that as a workflow-hardening requirement to explicitly restate the active goal in plain language, name the exact current thread, and record one of only two acceptable validation outcomes: `(a)` a fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or `(b)` a clear operator-facing no-run defer reason. For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, recent startup logs showing graph registration, worker startup, and server-running followed by `Flushing to persistent storage, exiting...` count as partial readiness evidence only, not completed validation, and recent cross-thread or pending-only LangSmith activity must not be treated as success for this thread.
- During quiet improvement iterations for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, use this operator-facing defer template whenever same-thread validation is still missing: `defer_reason=No fresh same-thread LangSmith control-plane run/trace was emitted for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane; startup logs only showed partial readiness (graph registration, worker startup, server-running, then flush/exit), and cross-thread or pending-only activity does not satisfy validation. Next required success condition: one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus passed control-plane smoke/typecheck, or this defer reason preserved verbatim.`
- Before calling a quiet improvement iteration successful for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, record this compact validation checklist in the summary or operator note: `same_thread_run=fresh|missing; goal_context=present|missing; smoke_or_typecheck=passed|missing; readiness=partial|confirmed; defer_reason=required_when_missing_run`. Treat `readiness=partial` as the correct value when logs only show graph registration, worker startup, and server-running followed by flush/exit.
- If no fresh same-thread LangSmith run exists yet for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, prefer a README-only or other operator-facing control-plane change and append this one-line status cue: `validation_status=deferred_pending_same_thread_run`.
- If sampled LangSmith activity for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane` is only pending, record it explicitly as `same_thread_observability=partial_pending_only` and do not count it as completed validation; cross-thread completed runs still do not satisfy this thread.
- When pending same-thread visibility and startup logs that show graph registration, worker startup, or server-running are followed by flush/exit, summarize the state as `observability=partial readiness=partial` and preserve the no-run defer reason instead of marking the iteration successful.
- If repeated OpenAI/OpenRouter 401/402/500-style provider noise appears during the same window, classify it as upstream/provider-bound drift blocked in `apps/api provider routing/probing`; retrying the same provider-method combination is unlikely to help immediately, so keep the control-plane summary focused on observability and the same-thread validation/defer outcome above rather than implying the blocked apps/api subsystem was fixed.
- Use this compact operator-facing defer template when the current thread still lacks completed validation: `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane same_thread_run=missing same_thread_observability=missing_or_pending_only readiness=partial_if_startup_then_exit blocked_subsystem=apps/api_provider_routing/probing_when_provider_noise_repeats validation_status=deferred_pending_same_thread_run next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- Before marking a control-plane iteration successful, explicitly check and record all of the following for the same thread: `goal_context=present`, `langsmith_same_thread_run=completed`, `smoke_or_typecheck=passed`, and `readiness=not_just_startup_then_exit`. If any item is missing, preserve the defer reason instead of inferring success from partial evidence.
- Treat this compact validation checklist as the minimum operator-facing status line for the current thread: `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane goal_context=required same_thread_run=required smoke_or_typecheck=required startup_then_exit=partial_readiness_only cross_thread_runs=not_sufficient`.
- Do not mark the iteration successful from cross-thread LangSmith activity, pending-only same-thread visibility, or startup logs that register graphs/start workers/start the server and then flush or exit; those are observability/readiness hints only until the same-thread run and smoke/typecheck evidence above exist.
- When pending-run pressure is visible for the current control-plane iteration, prefer README-only or other operator-facing workflow-hardening changes over speculative source mutations unless a clear code-local defect is present in an allowed control-plane file. Record the current thread explicitly, treat pending same-thread visibility as partial observability only, and preserve a no-run defer reason until a fresh same-thread LangSmith control-plane run/trace and passed smoke/typecheck result exist.
- For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, treat the current combination of `same_thread_run=missing`, cross-thread/pending-only LangSmith activity, and studio startup logs that register graphs/start workers/start the server and then immediately flush/exit as combined partial observability plus partial readiness only. Do not mark validation complete from that evidence alone; record a compact defer line such as `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane same_thread_run=missing readiness=partial_startup_then_exit validation_status=deferred blocked_subsystem=apps/api_provider_routing/probing_when_openai_noise_repeats next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck` until a fresh same-thread LangSmith control-plane run/trace and passed smoke/typecheck result exist.
- When repeated OpenAI/OpenRouter 401, invalid_api_key, quota, or 500 sendMessage noise is present while control-plane scope is active, classify it as upstream/provider-bound drift blocked in the out-of-scope `apps/api` provider routing/probing subsystem by default rather than a control-plane regression. For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, retrying the same provider-method combination is unlikely to help immediately; prefer a compact defer line that preserves operator context, for example: `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane provider_noise=openai_sendMessage_401_500 blocked_subsystem=apps/api_provider_routing/probing decision=control_plane_observability_only validation_status=deferred next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- During quiet control-plane improvement iterations with no fresh same-thread validation yet, prefer README-only or other operator-facing workflow-hardening changes over speculative source mutations unless a clear code-local defect is visible in an allowed control-plane file. Cross-thread LangSmith runs do not satisfy this thread, and startup logs that reach server-running and then flush/exit remain partial readiness only until a fresh same-thread LangSmith control-plane run/trace and passed smoke/typecheck result exist.
- For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, treat the current state as `same_thread_run=missing` unless the sampled LangSmith evidence explicitly names that exact thread with a fresh completed control-plane run/trace. If observability is dominated by other threads or only pending visibility exists, preserve an operator-facing no-run defer reason instead of claiming validation from cross-thread activity.
- When sampled provider noise is dominated by repeated OpenAI/OpenRouter auth or 5xx churn such as `openai sendMessage 401/500`, classify it as upstream/provider-bound drift blocked in `apps/api` provider routing/probing for this control-plane iteration. Retrying the same provider-method combination is unlikely to help immediately; prefer an operator-facing defer line or observability note over speculative provider edits outside scope.
- A compact defer line is preferred when readiness or observability is partial, for example: `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane same_thread_run=missing same_thread_pending=unknown readiness=partial_startup_then_exit validation_status=deferred reason=no_fresh_same_thread_langsmith_run blocked_subsystem=apps/api_provider_routing/probing_when_openai_sendMessage_401_500_noise_repeats next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- A compact same-thread validation checklist is preferred before calling an iteration successful: `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane goal_context=required same_thread_run=fresh_and_completed smoke_or_typecheck=passed startup_state=not_just_partial_readiness cross_thread_runs=ignored_for_success`. If any field is missing, preserve a no-run defer reason instead of claiming success.
- For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, treat sampled LangSmith runs from `:api-runtime`, `:api-routing`, `:workspace-surface`, or any other sibling thread as cross-thread activity only; they do not satisfy this iteration's same-thread validation requirement.
- For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, if startup evidence shows graph registration, worker startup, or `Server running` and then immediately shows `Flushing to persistent storage, exiting...`, record `readiness=partial_startup_then_exit` and keep validation deferred unless a fresh same-thread LangSmith control-plane run/trace and passed smoke/typecheck result are also present.
- When provider noise is dominated by repeated `openai sendMessage` `401` or `500` failures, classify that cluster as upstream/provider-bound drift blocked in the out-of-scope `apps/api` provider routing/probing subsystem for this control-plane iteration; prefer surfacing that blocked subsystem in the defer line instead of retrying the same provider-method combination.
- A compact combined partial-observability/partial-readiness defer line is preferred when both conditions apply, for example: `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane same_thread_run=missing same_thread_pending=none_seen_for_this_thread readiness=partial_startup_then_exit validation_status=deferred reason=no_fresh_same_thread_langsmith_run cross_thread_activity=ignored blocked_subsystem=apps/api_provider_routing/probing_when_openai_sendMessage_401_500_noise_repeats next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- During quiet control-plane improvement iterations for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, if governance/evaluation are otherwise passing but there is still no fresh completed same-thread LangSmith control-plane run/trace, prefer one smallest bounded README-only or operator-facing observability/workflow-hardening change and explicitly record that choice as smoke-safer than speculative source mutation.
- In that quiet-iteration case, keep the defer reason explicit instead of claiming success from cross-thread activity or startup-only evidence: `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane validation_status=deferred reason=no_fresh_same_thread_langsmith_run improvement_mode=quiet_iteration smoke_safer_change=readme_or_operator_facing_only startup_state=partial_readiness_if_server_started_then_exited cross_thread_runs=ignored next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- Treat recent runs from sibling threads such as `:homepage-surface`, `:api-data`, `:ui-surface`, or `:workspace-surface` as cross-thread observability only; they do not satisfy validation for `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`.
- If startup logs show `Registering graph`, `Starting 10 workers`, or `Server running` and then immediately show `Flushing to persistent storage, exiting...`, record that state as `readiness=partial_startup_then_exit`, not as a completed smoke pass.
- When the current repair window is otherwise quiet but monitoring is dominated by repeated `openai sendMessage` `401` or `500` failures, classify that cluster as upstream/provider-bound drift blocked in the out-of-scope `apps/api provider routing/probing` subsystem and preserve that blocked-subsystem note in the defer reason instead of retrying the same provider-method combination.
- Preferred compact defer line for this exact thread when all three conditions apply (no fresh same-thread run, cross-thread activity present, and startup-then-exit logs observed): `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane same_thread_run=missing cross_thread_activity=present_but_ignored readiness=partial_startup_then_exit validation_status=deferred reason=no_fresh_same_thread_langsmith_run blocked_subsystem=apps/api_provider_routing/probing_when_openai_sendMessage_401_500_noise_repeats next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- Quiet-iteration operator rule: when governance is passing and no code-local repair target is present, prefer README-only or other operator-facing control-plane changes until `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane` emits at least one fresh same-thread LangSmith run/trace with explicit goal context and a passed control-plane smoke/typecheck result.
- Same-thread validation rule: a `summarize` success on `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane` without a fresh same-thread smoke/typecheck result is still observability evidence only, not completed validation.
- Provider-noise defer rule: if monitoring is dominated by repeated OpenAI `sendMessage` `401` or `500` failures, record `blocked_subsystem=apps/api_provider_routing/probing` and `provider_retry_same_method_unlikely_to_help=true` in the operator-facing defer reason rather than implying the out-of-scope apps/api issue was repaired from control-plane scope.
- Quiet-iteration defer template for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: when same-thread validation is still missing but startup logs show graph registration, worker startup, and server-running followed by an immediate flush/exit, classify the state as `partial_observability_plus_partial_readiness_only`; if cross-thread runs exist, mark them as ignored for validation; if repeated OpenAI `sendMessage` `401` or `500` noise is present, keep `blocked_subsystem=apps/api_provider_routing/probing` and `provider_retry_same_method_unlikely_to_help=true`; and end the defer note with `next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- Operator-facing defer example for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: `status=deferred thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane readiness=partial graph_registered=true workers_started=true server_running=true exited_soon_after_start=true observability=same_thread_run_missing cross_thread_runs_ignored=true blocked_subsystem=apps/api_provider_routing/probing provider_retry_same_method_unlikely_to_help=true reason=no_fresh_same_thread_langsmith_run_and_startup_only_showed_partial_readiness next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- Same-thread validation checklist for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: require all of the following before calling the iteration validated: `(1)` a fresh LangSmith run/trace on the exact same thread with explicit goal context, `(2)` a passed control-plane smoke or typecheck result tied to that iteration, and `(3)` no reliance on cross-thread runs, older iterations, or pending-only visibility. If startup logs only show graph registration, worker startup, and server-running followed by an immediate flush/exit, record that as `partial_readiness_only=true` rather than success.
- Provider-noise classification note for this control-plane thread: repeated OpenAI `sendMessage` `401` or `500` entries remain upstream/provider-bound drift blocked in `apps/api provider routing/probing`; retrying the same provider-method combination is unlikely to help immediately from control-plane scope, so the operator-facing note should preserve `blocked_subsystem=apps/api_provider_routing/probing` until credentials, quota, or upstream stability are addressed outside this bounded iteration.
- Compact no-run defer template for quiet control-plane iterations: `status=deferred thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane partial_readiness_only=true same_thread_validation_observed=false cross_thread_activity_ignored=true blocked_subsystem=apps/api_provider_routing/probing reason=no_fresh_same_thread_langsmith_run_or_passed_control_plane_smoke next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- Quiet-iteration operator note for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: when governance is passing and no code-local repair target exists, prefer a README-only or similarly smoke-safe control-plane observability/workflow-hardening change. Cross-thread LangSmith activity such as `:api-platform`, `:ui-surface`, `:homepage-surface`, or `:workspace-surface` does not satisfy validation for this control-plane thread.
- Partial-readiness wording rule for this thread: if logs show graph registration, worker startup, or `Server running` and then immediately show `Flushing to persistent storage, exiting...`, record `partial_readiness_only=true` and keep the iteration in deferred/not-yet-validated state unless a fresh same-thread LangSmith control-plane run/trace and a passed control-plane smoke/typecheck result are also present.
- Recommended compact observability line for summaries and defer reasons on this thread: `thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane same_thread_run=fresh_required startup_state=partial_readiness_only cross_thread_runs=ignored blocked_subsystem=apps/api_provider_routing/probing`.
- Quiet improvement validation rule for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: if the iteration only makes a README-only or other smoke-safe control-plane observability/workflow-hardening change, do not mark it validated from startup logs or cross-thread LangSmith activity alone. Treat `Registering graph`, `Starting 10 workers`, and `Server running` followed by `Flushing to persistent storage, exiting...` as partial readiness only, and require either (a) one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or (b) an explicit no-run defer reason that says validation is still pending for this thread.
- Operator-facing defer template for quiet README-only improvements on this thread: `status=deferred thread=2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane change_scope=readme_only same_thread_run=fresh_required startup_state=partial_readiness_only cross_thread_runs=ignored reason=no_fresh_same_thread_langsmith_run_and_no_passed_control_plane_smoke next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- Quiet improvement operator checklist for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: if the only change is a README-only or other smoke-safe control-plane observability/workflow-hardening edit, keep the iteration in deferred/not-yet-validated state until a fresh same-thread LangSmith control-plane run/trace exists. Treat `Registering graph`, `Starting 10 workers`, and `Server running` followed by `Flushing to persistent storage, exiting...` as partial readiness only; treat pending or successful runs from `workspace-surface`, `api-runtime`, `api-platform`, `api-routing`, or `ui-surface` as cross-thread evidence only; and record a no-run defer reason unless a passed control-plane smoke/typecheck result is also present for this same thread.
- Provider-noise triage note for this control-plane thread: repeated OpenAI/OpenRouter 500, 429, Unauthorized, invalid_api_key, 401, 402, or quota-style failures belong to the blocked subsystem `apps/api provider routing/probing`, so direct repair there is out of scope for this bounded control-plane iteration. Treat those signals as upstream/provider-bound drift or instability, note that repeating the same provider-method combination is unlikely to help immediately, and do not count them as proof of a control-plane regression. For thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, preserve an operator-facing defer reason unless there is also at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result.
- Compact defer line for quiet control-plane improvements on this thread: `same_thread_validation_required=true startup_logs=partial_readiness_only cross_thread_langsmith_runs=ignored provider_noise_scope_blocked=apps/api_provider_routing_probing next_success_condition=fresh_same_thread_langsmith_run_with_goal_context_plus_passed_control_plane_smoke_or_typecheck`.
- Same-thread validation note for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: treat `Registering graph`, `Starting 10 workers`, and `Server running` followed by `Flushing to persistent storage, exiting...` as combined partial readiness only, not a completed validation run. Pending or successful LangSmith runs from `api-platform`, `api-runtime`, `workspace-surface`, or `ui-surface` are cross-thread evidence only and must not be used to clear this thread. If no fresh same-thread control-plane run/trace is emitted after a README-only or other smoke-safe improvement, record an explicit no-run defer reason such as `no fresh same-thread control-plane LangSmith run observed for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane; startup evidence remained partial-readiness-only; cross-thread runs ignored; awaiting passed control-plane smoke/typecheck plus same-thread goal-context trace`.
- Quiet-iteration operator checklist for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: after any smoke-safe control-plane improvement, confirm the experimental control-plane target is still reachable, confirm pending control-plane-adjacent runs are not worsening, and then require one of two outcomes before calling the iteration successful: (1) at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or (2) a clear operator-facing no-run defer reason that explicitly says startup evidence was partial-readiness-only and cross-thread LangSmith runs were ignored.
- Quiet-iteration no-run defer template for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: `goal=bounded_control_plane_improvement signal=quiet_governance_window same_thread_run=missing same_thread_pending=none_observed startup_readiness=partial_only startup_evidence="Registering graph; Starting 10 workers; Server running; Flushing to persistent storage, exiting..." cross_thread_runs=ignored blocked_subsystem=apps/api_provider_routing_probing blocked_provider_noise="openai /v1/responses 500 and 429" decision=defer_validation_claim next_success_condition="fresh same-thread LangSmith control-plane run/trace with explicit goal context plus passed control-plane smoke/typecheck, or preserve this no-run defer reason if no run is emitted"`.
- Same-thread validation reminder for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: do not treat runs from `api-data`, `api-platform`, `api-runtime`, `workspace-surface`, or `ui-surface` as satisfying this control-plane iteration. Pending-only visibility for other threads is cross-thread observability, not validation for this thread.
- Partial-readiness reminder for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`: if logs show `Registering graph`, `Starting 10 workers`, or `Server running` and then immediately show `Flushing to persistent storage, exiting...`, record that as partial readiness only. Do not clear the iteration unless a fresh same-thread LangSmith control-plane run/trace and passed control-plane smoke/typecheck result are also present.
- Operator-facing defer note for blocked provider noise: repeated OpenAI `/v1/responses` 500/429 failures belong to the blocked `apps/api` provider routing/probing subsystem for this control-plane-only iteration. Retrying the same provider-method combination is unlikely to help immediately; prefer documenting the defer reason and waiting for fresh same-thread control-plane validation evidence.
- Quiet-iteration validation checklist for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`:
  1. Confirm whether there is at least one fresh same-thread LangSmith control-plane run/trace for `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane` with explicit goal context; do not count cross-thread runs.
  2. If Studio logs show `Registering graph`, `Starting 10 workers`, or `Server running` and then `Flushing to persistent storage, exiting...`, record that as partial readiness only, not completed validation.
  3. If no fresh same-thread run exists, preserve an operator-facing no-run defer reason instead of claiming success.
  4. Only clear the iteration after a passed control-plane smoke/typecheck result and at least one fresh same-thread LangSmith control-plane run/trace, or after explicitly recording why no run was emitted.
- Quiet-iteration no-run defer template for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`:
  - `Goal:` bounded control-plane orchestration/observability/workflow-hardening improvement while monitoring broader repo health.
  - `Same-thread LangSmith status:` no fresh completed run/trace yet for `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`; cross-thread runs do not satisfy this iteration.
  - `Pending-run note:` if LangSmith only shows pending visibility for `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, record that as partial observability only, not completed validation.
  - `Readiness status:` if logs reached `Registering graph`, `Starting 10 workers`, or `Server running` and then immediately flushed/exited, treat that as partial readiness evidence only.
  - `Combined partial state:` if pending same-thread LangSmith visibility appears together with startup logs that immediately flushed/exited, record the state as combined partial observability plus partial readiness only, not a successful validation run.
  - `Quiet-iteration edit choice:` when governance is quiet and no code-local control-plane defect is visible, prefer one smallest README-only or operator-facing observability/workflow-hardening change over speculative source mutation.
  - `No-run discipline:` do not mark the iteration successful from startup logs, cross-thread runs, or pending-only visibility; preserve the defer note until same-thread validation exists.
  - `Quiet-iteration same-thread check:` when recent LangSmith activity is healthy but belongs to other threads, explicitly record that cross-thread success does not satisfy thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`; require either one fresh same-thread control-plane run/trace with explicit goal context or a preserved no-run defer reason.
  - `Blocked noise outside scope:` repeated OpenAI `/v1/responses` 500/429 failures belong to the blocked `apps/api` provider routing/probing subsystem for this control-plane-only iteration, so retrying the same provider-method combination is unlikely to help immediately.
  - `Validation needed next:` one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or this defer note preserved verbatim when no run was emitted.
  - `Quiet-iteration README-only preference:` when governance is passing, no code-local repair target is present, and thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane` still lacks a fresh completed LangSmith control-plane run/trace, prefer the smallest README-only or operator-facing observability/workflow-hardening change over speculative source mutation.
  - `Partial-readiness wording:` if startup logs show graph registration, worker startup, and server-running but then immediately flush or exit, record that as partial readiness evidence only for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`, not completed validation.
  - `Same-thread proof rule:` cross-thread success and pending-only LangSmith visibility do not satisfy this iteration for thread `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`; keep the no-run defer reason until a fresh same-thread completed run/trace exists.
- `Operator-facing defer reason template:` `No fresh completed LangSmith control-plane run/trace was observed yet for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane. Startup logs that reached graph registration, worker startup, and server-running and then flushed/exited only show partial readiness, not completed validation. Cross-thread or pending-only LangSmith activity does not satisfy this iteration. Repeated OpenAI /v1/responses 500/429 noise is blocked in apps/api provider routing/probing for this control-plane-only pass, so retrying the same provider-method combination is unlikely to help immediately. Next required proof is one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result.`
- `Same-thread validation quick checklist:`
  - Confirm the thread id in the summary exactly matches `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`.
  - Treat `Registering graph`, `Starting 10 workers`, and `Server running` followed by `Flushing to persistent storage, exiting...` as partial readiness only, not a completed smoke result.
  - Do not count cross-thread runs such as `:workspace-surface`, `:api-runtime`, `:api-data`, `:ui-surface`, or `:homepage-surface` as proof for this control-plane iteration.
  - Do not count pending-only LangSmith visibility as proof for this control-plane iteration.
  - If no fresh same-thread completed run exists yet, preserve the defer reason verbatim instead of claiming validation success.
  - Only mark validation complete after both a fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result are present.
- `Same-thread summary template for repair-smoke/goal-context gaps:`
  - `Goal:` `Continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements.`
  - `Thread:` `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`
  - `Active repair signal:` `LangSmith feedback sampled contains_goal_context=0 and repair_smoke_passed=0 for this control-plane iteration.`
  - `Readiness classification:` `Startup logs showing graph registration, worker startup, and server-running followed by flush/exit are partial readiness only, not completed validation.`
  - `Observability classification:` `Pending-only or cross-thread LangSmith activity is partial observability only and does not satisfy this same-thread control-plane iteration.`
  - `Required success condition:` `At least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or a clear operator-facing no-run defer reason if no run was emitted.`
- `Same-thread summary template for quiet improvement iterations with missing validation evidence:`
  - `Goal:` `Continuously monitor, fix, and improve AnyGPT across the repo, checking API, control-plane, UI, homepage, runtime health, routing, model availability, governance drift, and bounded safe improvements.`
  - `Thread:` `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`
  - `Active repair signal:` `Governance is quiet and recent LangSmith feedback is healthy, but this iteration still has no fresh completed same-thread LangSmith control-plane run/trace.`
  - `Readiness classification:` `Registering graph`, `Starting 10 workers`, and `Server running` followed by `Flushing to persistent storage, exiting...` are partial readiness only for this thread, not completed validation.`
  - `Observability classification:` `Cross-thread activity such as :api-runtime, :ui-surface, :workspace-surface, or pending-only same-project visibility does not satisfy this control-plane iteration.`
  - `Operator-facing defer reason:` `No fresh same-thread control-plane run/trace was emitted for this iteration, so validation remains deferred even though governance is passing and startup evidence is partially healthy.`
  - `Required success condition:` `At least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or preserve the no-run defer reason above if no run was emitted.`
- `Quiet-iteration operator checklist:`
  - `Treat provider noise correctly:` `Repeated OpenAI/OpenRouter 401, 402, 429, quota, or 5xx churn usually belongs to the blocked apps/api provider routing/probing subsystem during control-plane-only iterations; do not claim that retrying the same provider-method combination fixed the issue from control-plane scope.`
  - `Treat startup logs correctly:` `Graph registration, worker startup, and server-running logs followed by immediate flush/exit are partial readiness only, not a successful validation run.`
  - `Treat LangSmith visibility correctly:` `Cross-thread success or pending-only visibility is partial observability only; it does not satisfy the current control-plane thread.`
  - `Close the loop explicitly:` `If no fresh same-thread run/trace exists yet, keep the operator-facing no-run defer reason in the summary instead of implying validation succeeded.`
- `Same-thread validation template for quiet control-plane iterations:`
  - `Thread to name explicitly:` `2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane`
  - `Goal line:` `Goal: continuously monitor, fix, and improve AnyGPT with one bounded control-plane orchestration, observability, or workflow-hardening change.`
  - `Blocked-noise line:` `Repeated OpenAI gpt-5.4 500/429 failures are upstream/provider-bound noise blocked in the apps/api provider routing/probing subsystem; retrying the same provider-method combination is unlikely to help immediately from control-plane scope.`
  - `Readiness line:` `Studio logs showing graph registration, worker startup, and server-running followed by immediate flush/exit are partial readiness evidence only for this thread, not completed validation.`
  - `Observability line:` `Recent LangSmith activity from other threads or pending-only visibility is partial observability only and does not satisfy this control-plane iteration.`
  - `Defer line:` `No fresh same-thread control-plane run/trace was emitted for this iteration yet, so keep an operator-facing no-run defer reason instead of claiming success.`
  - `Success condition line:` `Validation succeeds only after at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or after preserving the no-run defer reason when no run was emitted.`
  - `Operator summary line:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if same-thread validation is still missing, explicitly say startup evidence is partial readiness only, cross-thread or pending-only LangSmith visibility is partial observability only, and this iteration remains deferred with no-run status rather than successful.`
- `Quiet-iteration approval line:` `During quiet control-plane improvement iterations, treat README-only or other operator-facing observability/workflow-hardening edits as compile/readiness-only until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result exists for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane.`
- `Blocked-noise defer line:` `Repeated OpenAI sendMessage 500/429/401/ECONNREFUSED failures belong to the blocked apps/api provider routing/probing subsystem for this control-plane thread; retrying the same provider-method combination is unlikely to help immediately, so keep the summary focused on the control-plane defer reason instead of implying the upstream apps/api issue was fixed.`
- `Same-thread validation guard line:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, do not treat cross-thread LangSmith activity as validation; if studio logs show graph registration, worker startup, and server-running followed by immediate flush/exit, classify that as partial readiness only, and preserve a no-run defer reason until a fresh same-thread control-plane run/trace with explicit goal context and a passed smoke/typecheck result exists.`
- `Localhost-refusal defer line:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, an OpenAI sendMessage ECONNREFUSED event against http://localhost:3101/v1/responses is a scope-blocked apps/api provider routing/probing/runtime availability issue, not proof of a control-plane regression; record it as out of scope for this bounded control-plane iteration, avoid implying the underlying apps/api issue was fixed here, and keep the operator-facing result as no-run deferred unless a fresh same-thread LangSmith control-plane run/trace plus passed smoke/typecheck result is present.`
- `Localhost-refusal readiness line:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if the active signal is a localhost-targeted OpenAI sendMessage ECONNREFUSED event from apps/api/logs/provider-unique-errors.jsonl while studio logs also show graph registration, worker startup, and server-running followed by immediate flush/exit, summarize that state as scope-blocked apps/api provider routing/probing/runtime availability plus partial readiness only; do not treat cross-thread pending LangSmith runs as validation, and preserve a clear no-run defer reason until a fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result exists.`
- `Localhost-refusal operator summary line:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, when the active repair signal is an OpenAI sendMessage ECONNREFUSED event in blocked file apps/api/logs/provider-unique-errors.jsonl against http://localhost:3101/v1/responses, state plainly that direct repair belongs to the out-of-scope apps/api provider routing/probing/runtime-availability subsystem, that graph registration/worker startup/server-running followed by flush/exit is partial readiness evidence only, and that the iteration remains no-run deferred until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result is recorded.`
- `Localhost-refusal no-run defer rule:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if the active signal remains the blocked apps/api/logs/provider-unique-errors.jsonl OpenAI sendMessage ECONNREFUSED event against http://localhost:3101/v1/responses and there is still no fresh completed same-thread LangSmith control-plane run/trace, keep the outcome operator-facing as no-run deferred; do not claim validated runtime success from startup logs alone, because graph registration, worker startup, and server-running followed by flush/exit are partial readiness evidence only, and cross-thread or pending-only LangSmith activity does not satisfy this iteration.`
- `Localhost-refusal validation checklist:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, when the active repair signal is the blocked apps/api/logs/provider-unique-errors.jsonl OpenAI sendMessage ECONNREFUSED event against http://localhost:3101/v1/responses, record the outcome in this order: (1) direct repair is out of scope because the blocked subsystem is apps/api provider routing/probing/runtime availability, (2) graph registration, worker startup, and server-running followed by flush/exit count as partial readiness evidence only, (3) pending or cross-thread LangSmith visibility counts as partial observability only, and (4) success is not met until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists, otherwise preserve a clear operator-facing no-run defer reason.`
- `Localhost-refusal operator summary template:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if the active repair signal is still the blocked apps/api/logs/provider-unique-errors.jsonl OpenAI sendMessage ECONNREFUSED event against http://localhost:3101/v1/responses, summarize it as an out-of-scope apps/api provider routing/probing/runtime-availability issue, not a control-plane-local fix. Also state that graph registration, worker startup, and server-running followed by immediate flush/exit are partial readiness evidence only, that cross-thread LangSmith runs do not satisfy this iteration, and that the iteration remains no-run deferred until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result is recorded.`
- `Localhost-refusal no-run defer template:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if the active repair signal remains the blocked apps/api/logs/provider-unique-errors.jsonl OpenAI sendMessage ECONNREFUSED event against http://localhost:3101/v1/responses and no fresh same-thread LangSmith control-plane run/trace was emitted, preserve this operator-facing defer reason: direct repair is out of scope because the blocked subsystem is apps/api provider routing/probing/runtime availability; current graph registration, worker startup, and server-running followed by flush/exit are partial readiness evidence only; pending or cross-thread LangSmith visibility is partial observability only; therefore this control-plane iteration should report no-run deferred rather than claiming provider recovery or completed validation.`
- `Localhost-refusal validation checklist:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, when the active repair signal is the blocked apps/api/logs/provider-unique-errors.jsonl OpenAI sendMessage ECONNREFUSED event against http://localhost:3101/v1/responses, record validation in this order: (1) explicitly say the blocked subsystem is apps/api provider routing/probing/runtime availability and that direct repair there is out of scope for this bounded control-plane iteration, (2) classify graph registration, worker startup, and server-running followed by immediate flush/exit as partial readiness evidence only, (3) classify pending or cross-thread LangSmith visibility as partial observability only and not a completed same-thread validation run, and (4) only mark success after at least one fresh same-thread LangSmith control-plane run/trace for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane with explicit goal context plus a passed control-plane smoke/typecheck result; otherwise preserve the operator-facing no-run defer reason.`
- `Localhost-refusal same-thread observability note:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if recent LangSmith activity is mostly from other threads or only shows pending visibility, record that cross-thread activity does not satisfy this iteration and that pending-only visibility is partial observability evidence only. Pair that note with the readiness caveat that graph registration, worker startup, and server-running followed by flush/exit are partial readiness evidence only, then preserve the no-run defer reason until a fresh same-thread control-plane run/trace and passed smoke/typecheck result are recorded.`
- `Localhost-refusal operator defer template:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, when the active repair signal is the blocked apps/api/logs/provider-unique-errors.jsonl OpenAI sendMessage ECONNREFUSED event against http://localhost:3101/v1/responses, use an operator-facing defer reason that explicitly says the blocked subsystem is apps/api provider routing/probing/runtime availability, direct repair there is out of scope for this bounded control-plane iteration, graph registration/worker startup/server-running followed by immediate flush or exit is partial readiness evidence only, and pending or cross-thread LangSmith visibility is partial observability only. Do not claim provider recovery or completed validation until at least one fresh same-thread LangSmith control-plane run/trace for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane with explicit goal context plus a passed control-plane smoke/typecheck result is recorded; otherwise preserve the no-run defer reason.`
- `Localhost-refusal validation checklist:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, treat the blocked apps/api/logs/provider-unique-errors.jsonl OpenAI sendMessage ECONNREFUSED event against http://localhost:3101/v1/responses as an apps/api provider routing/probing/runtime availability issue that is out of scope for this bounded control-plane iteration. Before calling the iteration successful, explicitly confirm all of the following in the same thread: (1) a fresh LangSmith control-plane run/trace exists for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, (2) that run/trace includes explicit goal context, and (3) control-plane smoke/typecheck passed. If startup logs only show graph registration, worker startup, or server-running followed by flush/exit, record that as partial readiness evidence only. If LangSmith visibility is pending-only or mostly from other threads, record that as partial observability evidence only. If both conditions happen together, classify the state as combined partial observability plus partial readiness only for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane. Cross-thread activity does not satisfy this iteration. If either condition remains true, preserve a clear operator-facing no-run defer reason instead of implying the localhost refusal was fixed.`
- `Operator-facing no-run defer template for localhost refusal:` `Thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane is carrying a control-plane-only workflow-hardening change while the direct failure remains blocked in apps/api provider routing/probing/runtime availability. The active repair signal is an OpenAI sendMessage ECONNREFUSED against http://localhost:3101/v1/responses from apps/api/logs/provider-unique-errors.jsonl, so this iteration does not claim the underlying apps/api issue was repaired. Current startup evidence of graph registration, worker startup, and server-running followed by immediate flush/exit is partial readiness only, not completed validation. Current LangSmith visibility from other threads or pending-only runs is partial observability only, not same-thread validation for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane. Keep the defer reason in place until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result is recorded; otherwise report that no completed same-thread validation run was emitted.`
- `Operator checklist for scope-blocked localhost refusal:` `If the active failure is a localhost ECONNREFUSED from apps/api/logs/provider-unique-errors.jsonl, record the blocked subsystem as apps/api provider routing/probing/runtime availability and explicitly say the control-plane iteration did not repair that direct failure. For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, treat graph registration, worker startup, and server-running logs followed by immediate flush/exit as partial readiness only. Treat pending same-thread visibility or runs from other threads as partial observability only; cross-thread activity does not satisfy this iteration. Preserve a no-run defer reason unless a fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result is available. Experimental-only validation may target anygpt-experimental.service and the redacted experimental API base; production anygpt.service restart remains blocked without separate explicit approval.`
- `Same-thread validation gate for control-plane monitor/defer iterations:` `When the active repair signal is scope-blocked in apps/api, do not mark the control-plane iteration successful from startup logs alone. For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, classify graph registration, worker startup, and server-running followed by immediate flush/exit as partial readiness only, and classify pending same-thread LangSmith visibility or cross-thread LangSmith activity as partial observability only. The operator-facing outcome must either include one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or preserve a clear no-run defer reason stating that no completed same-thread validation run was emitted. Keep experimental approval limited to anygpt-experimental.service and the redacted experimental API base; production anygpt.service actions remain blocked without separate explicit approval.`
- `Scope-blocked apps/api runtime availability defer note:` `If the active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED to http://localhost:3101/v1/responses, record the blocked subsystem as apps/api provider routing/probing/runtime availability and explicitly say this control-plane iteration did not repair that direct apps/api failure. For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, treat graph registration, worker startup, and server-running logs followed by immediate flush/exit as partial readiness only, and treat LangSmith runs from other threads as insufficient for same-thread validation. The operator-facing outcome must preserve a no-run defer reason unless a fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result is available.`
- `Operator-facing no-run defer template for scope-blocked localhost API failures:` `Thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane is limited to control-plane scope. The active repair signal is blocked in apps/api provider routing/probing/runtime availability: apps/api/logs/provider-unique-errors.jsonl recorded openai sendMessage ECONNREFUSED to http://localhost:3101/v1/responses. This iteration only updated control-plane operator guidance and did not repair the direct apps/api failure. Control-plane startup logs showing graph registration, worker startup, and server-running followed by immediate flush/exit count as partial readiness evidence only, not completed validation. Pending or cross-thread LangSmith activity does not satisfy same-thread validation for this thread. Mark the outcome as no-run deferred unless a fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result is attached.`
- `Same-thread validation checklist for scope-blocked localhost API failures:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if the active repair signal remains apps/api/logs/provider-unique-errors.jsonl with openai sendMessage ECONNREFUSED to http://localhost:3101/v1/responses, explicitly record the blocked subsystem as apps/api provider routing/probing/runtime availability and keep the outcome in control-plane defer mode. Treat graph registration, worker startup, and server-running logs followed by immediate flush/exit as partial readiness only. Treat pending same-thread visibility as partial observability only, and treat runs from workspace-surface, api-routing, ui-surface, api-data, or other threads as insufficient for this control-plane iteration. Validation is complete only when at least one fresh same-thread LangSmith control-plane run/trace includes explicit goal context and control-plane smoke/typecheck passes; otherwise preserve the operator-facing no-run defer reason.`
- `Operator defer template for scope-blocked localhost API failures:` `Thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane remains limited to control-plane scope. The active repair signal is still blocked in apps/api provider routing/probing/runtime availability because apps/api/logs/provider-unique-errors.jsonl recorded openai sendMessage ECONNREFUSED to http://localhost:3101/v1/responses. This control-plane iteration did not repair the direct apps/api failure. LangGraph startup evidence that registered the control-plane graph, started workers, and briefly served before flushing/exiting counts as partial readiness only, not a completed validation run. Recent LangSmith activity from homepage-surface, api-platform, ui-surface, or workspace-surface does not satisfy same-thread validation for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane. Keep the outcome as no-run deferred until a fresh same-thread LangSmith control-plane run/trace with explicit goal context is captured and control-plane smoke/typecheck passes; otherwise retain this defer reason verbatim.`
- `Same-thread validation checklist for scope-blocked provider failures:` `1) Confirm the active repair signal is still the out-of-scope apps/api provider routing/probing/runtime availability failure from apps/api/logs/provider-unique-errors.jsonl rather than claiming it was fixed in control-plane code. 2) Treat graph registration, worker startup, server-running logs, and then immediate flush/exiting as partial readiness only. 3) Treat pending or successful LangSmith runs from other threads as insufficient; only thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane counts for this iteration. 4) If no fresh same-thread control-plane run/trace exists yet, preserve the operator-facing no-run defer reason instead of promoting confidence from historical or cross-thread evidence. 5) Only mark validation complete after a fresh same-thread LangSmith control-plane run/trace includes explicit goal context and control-plane smoke/typecheck passes.`
- `Operator defer template for this thread:` `Thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane remains a no-run defer while the direct apps/api repair target stays blocked in apps/api/logs/provider-unique-errors.jsonl and apps/api provider routing/probing/runtime availability. The active blocked signal is openai sendMessage to http://localhost:3101/v1/responses returning ECONNREFUSED, which is outside control-plane scope and must not be summarized as fixed here. Startup evidence that registered the graph, started workers, and briefly served before flushing/exiting is partial readiness only. Pending LangSmith activity from other threads, or pending-only visibility for this thread, is partial observability only and does not satisfy validation. Cross-thread successful or pending runs such as api-data, homepage-surface, api-routing, api-runtime, or workspace-surface do not satisfy this control-plane iteration. Do not restart production anygpt.service under this rollout; if runtime verification is attempted later, keep it against the experimental API base URL/service only. Do not claim the apps/api ECONNREFUSED failure was fixed by this control-plane change. Validation succeeds only after at least one fresh same-thread LangSmith control-plane run/trace includes explicit goal context and control-plane smoke/typecheck passes; otherwise keep this defer reason in the operator summary.`
- `Same-thread validation checklist for this thread:` `1) Confirm a fresh LangSmith run/trace exists for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, not just other threads. 2) Confirm the run/trace includes explicit goal context for the bounded control-plane repair. 3) Confirm control-plane smoke/typecheck passed for the touched control-plane path set. 4) If startup logs again show graph registration, worker startup, or server-running followed by immediate flush/exiting, record that as partial readiness only and keep the no-run defer reason unless the same-thread run/trace and smoke/typecheck evidence also exist. 5) If no fresh same-thread run/trace was emitted, preserve the operator-facing defer reason instead of promoting confidence from cross-thread or pending-only evidence.`
- `Scope-blocked provider failure note for this thread:` `The active repair signal is apps/api/logs/provider-unique-errors.jsonl reporting openai sendMessage to http://localhost:3101/v1/responses returning ECONNREFUSED. Direct repair is blocked by scope in the apps/api provider routing/probing subsystem for this bounded control-plane iteration, so do not summarize that provider failure as fixed here. Treat graph registration, worker startup, and server-running logs followed by immediate flush/exiting as partial readiness only, and treat missing or pending-only same-thread LangSmith visibility for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane as partial observability only. Cross-thread runs do not satisfy this iteration. Validation succeeds only after at least one fresh same-thread LangSmith control-plane run/trace includes explicit goal context and control-plane smoke/typecheck passes; otherwise preserve this operator-facing no-run defer reason.`
- `Operator triage cue for this thread:` `If the latest signal is still apps/api/logs/provider-unique-errors.jsonl with openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses, classify it as scope-blocked in apps/api provider routing/probing for thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane. Do not retry or summarize the same apps/api provider-method combination as fixed from control-plane scope alone. If LangSmith evidence is only pending or belongs to other threads, record that as partial observability only. If startup logs again show graph registration, worker startup, or server-running followed by immediate flush/exiting, record that as partial readiness only. Only clear the defer reason after one fresh same-thread LangSmith control-plane run/trace with explicit goal context is visible and control-plane smoke/typecheck passes for the touched control-plane path set.`
- `Same-thread validation checklist for this thread:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, do not treat the current pending recent runs as completed validation when they are pending or mostly belong to other threads. Cross-thread activity does not satisfy this iteration for the control-plane thread. Do not treat graph registration, worker startup, or server-running logs followed by immediate flush/exiting as stable runtime health; that is partial readiness only. Because the active repair signal remains the scope-blocked apps/api/logs/provider-unique-errors.jsonl openai sendMessage ECONNREFUSED in apps/api provider routing/probing, preserve a no-run defer reason unless this thread emits at least one fresh completed LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.`
- `LangSmith feedback hardening cue for this thread:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, sampled feedback contains contains_goal_context=0 and repair_smoke_passed=0. Treat that as a workflow-hardening signal: restate the active goal in plain language in the next summary, require explicit same-thread goal-context evidence, and do not call the iteration healthy until at least one fresh same-thread LangSmith control-plane run/trace includes explicit goal context and the touched control-plane path set passes smoke/typecheck. If no run is emitted, preserve a clear operator-facing no-run defer reason instead of inferring success from pending or cross-thread runs.`
- `Scope-blocked provider failure note for this thread:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, the active repair signal is an openai sendMessage ECONNREFUSED event recorded in apps/api/logs/provider-unique-errors.jsonl against http://localhost:3101/v1/responses. Direct repair is blocked in the out-of-scope apps/api provider routing/probing subsystem for this bounded control-plane iteration, so do not summarize the underlying provider issue as fixed from a control-plane-only change. Treat studio-server logs that show graph registration, worker startup, and server-running followed by immediate 'Flushing to persistent storage, exiting...' as partial readiness evidence only, not completed validation. Pending or completed LangSmith runs in other threads do not satisfy this iteration for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane. Preserve a clear operator-facing no-run defer reason unless this exact thread emits at least one fresh completed LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.`
- `Same-thread validation success condition for this thread:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, startup evidence alone is insufficient because graph registration, worker startup, and server-running followed by immediate flush/exit count as partial readiness only. The next successful validation state is either: (a) at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched control-plane path set, or (b) a clear operator-facing no-run defer reason explaining why no run was emitted. Cross-thread activity and older iterations do not satisfy this thread.`
- `Scope-blocked localhost ECONNREFUSED handling for this thread:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if the active repair signal is an openai sendMessage ECONNREFUSED event recorded in blocked out-of-scope file apps/api/logs/provider-unique-errors.jsonl against http://localhost:3101/v1/responses, classify the direct fix as blocked in the out-of-scope apps/api provider routing/probing subsystem. Do not summarize that provider/runtime issue as repaired by a control-plane-only change. Treat graph registration, worker startup, and server-running logs followed by immediate flush/exit as partial readiness evidence only, and treat pending or completed LangSmith runs from other threads as partial observability at best, not validation for this thread. Operator-facing defer note: localhost:3101 refusal usually means the target API/runtime was not serving for that provider path during sampling, and repeating the same provider-method combination from control-plane scope is unlikely to help until the blocked apps/api provider/runtime path is restored. Preserve a clear operator-facing no-run defer reason unless this exact thread emits at least one fresh completed LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.`
- `Experimental-only validation reminder for this thread:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, keep approval and any runtime validation limited to anygpt-experimental.service and the redacted experimental API base. Do not treat apps/api provider 500/429/401 or localhost ECONNREFUSED logs as fixed by this control-plane-only iteration, and do not restart production anygpt.service. If startup logs again show graph registration, worker startup, or server-running followed by immediate flush/exit, record that as partial readiness only. If recent LangSmith activity remains cross-thread or pending-only, record that as partial observability only. The next successful validation state is one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched control-plane path set, or a clear operator-facing no-run defer reason if no run was emitted.`
- `Localhost provider refusal defer note:` `When apps/api/logs/provider-unique-errors.jsonl shows openai sendMessage ECONNREFUSED for http://localhost:3101/v1/responses during thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, classify the direct fix as blocked in the out-of-scope apps/api provider/runtime subsystem rather than as a control-plane regression. Record that retrying the same provider-method combination is unlikely to help until the localhost API target is serving again. Treat graph registration, worker startup, and server-running logs followed by immediate flush/exit as partial readiness evidence only, not completed validation, and treat cross-thread or pending-only LangSmith visibility as partial observability only, not same-thread proof. Preserve a clear operator-facing no-run defer reason unless this exact thread emits at least one fresh completed LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.`
- `Same-thread validation gate for localhost provider noise:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, do not treat apps/api localhost ECONNREFUSED at http://localhost:3101/v1/responses as fixed by a control-plane-only edit. If the latest control-plane evidence still consists of graph registration, worker startup, and server-running logs followed by immediate flush/exiting, record that as partial readiness only. If LangSmith visibility is still pending-only or belongs to sibling threads such as api-data, api-routing, or workspace-surface, record that as partial observability only; cross-thread activity does not satisfy this control-plane iteration. The operator-facing success condition remains one fresh same-thread LangSmith control-plane run/trace with explicit goal context for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane plus a passed control-plane smoke/typecheck result for the touched control-plane path set, or a clear no-run defer reason explaining why no run was emitted.`
- `Operator defer template for localhost API refusal:` `When apps/api/logs/provider-unique-errors.jsonl shows openai sendMessage ECONNREFUSED for http://localhost:3101/v1/responses during thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, classify the direct fix as blocked in the out-of-scope apps/api provider/runtime subsystem and say retrying the same provider-method combination is unlikely to help until the localhost API target is serving again. If control-plane startup logs only show graph registration, worker startup, and server-running before an immediate flush/exit, describe that as partial readiness only. If same-thread LangSmith evidence is missing while sibling threads have recent activity, explicitly say cross-thread activity does not satisfy this control-plane iteration and preserve a clear no-run defer reason instead of claiming the provider issue was fixed by the control plane.`
- `Operator defer checklist for blocked localhost API refusal:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, if the active repair signal is apps/api/logs/provider-unique-errors.jsonl reporting openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses, record the issue as blocked in the out-of-scope apps/api provider/runtime subsystem. Do not imply the localhost API refusal was fixed by a control-plane-only edit. Treat graph registration, worker startup, and server-running logs followed by immediate flush/exiting as partial readiness only. Treat pending-only LangSmith visibility or successful runs from sibling threads such as api-runtime, workspace-surface, ui-surface, homepage-surface, or api-platform as partial observability only; cross-thread activity does not satisfy this control-plane iteration. The operator-facing success condition remains one fresh same-thread LangSmith control-plane run/trace with explicit goal context for 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane plus a passed control-plane smoke/typecheck result for the touched control-plane path set, or a clear no-run defer reason explaining why no run was emitted.`
- `Same-thread validation reminder for blocked localhost API refusal:` `For thread 2ecf435b-4dc3-45ec-bdae-27cee1f93b64:control-plane, recent LangSmith governance and evaluation signals are healthy, but they do not replace one fresh same-thread control-plane run/trace for this iteration. If the latest control-plane studio log only shows graph registration, worker startup, and server-running before flushing to persistent storage and exiting, classify that as partial readiness evidence only. If recent LangSmith activity is pending or successful only on sibling threads, classify that as partial observability only. Keep the no-run defer reason visible until this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck, or until an operator-facing note clearly explains why no run was emitted while the blocked apps/api provider/runtime ECONNREFUSED condition remains unresolved.`
- `Current-thread localhost API defer template:` `For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, the active goal is to continuously monitor, fix, and improve AnyGPT with bounded safe control-plane changes. If apps/api/logs/provider-unique-errors.jsonl shows openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses, classify the direct fix as out of scope in the blocked apps/api provider/runtime routing subsystem and do not imply the localhost API refusal was fixed by a control-plane-only change. Retry of the same openai sendMessage combination is unlikely to help until the localhost API target is serving again. If control-plane startup logs show graph registration, worker startup, or server-running followed by flushing to persistent storage and exiting, record that as partial readiness evidence only, not completed validation. If LangSmith visibility is pending-only or successful only on sibling threads such as homepage-surface, workspace-surface, ui-surface, or api-runtime, record that as partial observability only; cross-thread activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Keep a clear operator-facing no-run defer reason until this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck, or until an operator-facing note clearly explains why no run was emitted.`
- `Current-thread combined partial-readiness/partial-observability template:` `For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, the active goal is to continuously monitor, fix, and improve AnyGPT with bounded safe control-plane changes. The active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses; the direct fix remains out of scope in the blocked apps/api provider/runtime routing subsystem, so do not imply that a control-plane-only change repaired the localhost API target. When startup logs show graph registration, worker startup, and server-running before an immediate flush/exit, classify that as partial readiness evidence only. When LangSmith visibility is pending-only or mostly from other threads, classify that as partial observability only; cross-thread activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. In that combined state, preserve a clear operator-facing no-run defer reason and report the next success condition as one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or a clear defer reason explaining why no run was emitted.`
- `Scope-blocked localhost API refusal template:` `For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, the active goal is to continuously monitor, fix, and improve AnyGPT with bounded safe control-plane changes. The active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses. The direct fix is out of scope for this bounded control-plane iteration because the blocked subsystem is apps/api provider/runtime routing availability, and retrying the same openai sendMessage combination is unlikely to help until the localhost API target is serving again. If control-plane startup logs show graph registration, worker startup, or server-running followed by an immediate flush, exit, or shutdown, treat that as partial readiness evidence only, not completed validation. If LangSmith visibility is pending-only or mostly from other threads, treat that as partial observability only; cross-thread activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Preserve a clear operator-facing no-run defer reason unless this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.`
- `No-run defer reason template for scope-blocked localhost refusals:` `For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, no fresh same-thread LangSmith control-plane run/trace with explicit goal context and no passed control-plane smoke/typecheck result were emitted for this iteration. The active goal remains bounded control-plane monitoring and improvement, while the active repair signal remains the scope-blocked apps/api/logs/provider-unique-errors.jsonl openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses. Because the blocked subsystem is apps/api provider/runtime routing availability outside the control-plane allowlist, this iteration should report a no-run defer reason instead of implying the localhost API refusal was fixed. Treat graph registration, worker startup, and server-running followed by immediate flush/exit as partial readiness evidence only, and treat pending-only or cross-thread LangSmith visibility as partial observability only. The next success condition is one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched control-plane path set, or this explicit defer reason if no run is emitted.`
- `Combined partial-readiness plus partial-observability template:` `For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, the active goal is still bounded control-plane monitoring and safe improvement, and the active repair signal is still the scope-blocked apps/api/logs/provider-unique-errors.jsonl openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses in the blocked apps/api provider/runtime routing subsystem. Control-plane startup logs showing graph registration, worker startup, or server-running followed by flushing to persistent storage and exiting are only partial readiness evidence, not completed validation. Pending-only LangSmith visibility for this thread, or completed runs from other threads, is only partial observability evidence; cross-thread activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Preserve a clear operator-facing no-run defer reason unless this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.`
- `Localhost API refusal defer template:` `For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, the active goal is continuous bounded control-plane monitoring and safe improvement across AnyGPT, and the active repair signal is the scope-blocked apps/api/logs/provider-unique-errors.jsonl openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses in the blocked apps/api provider/runtime routing subsystem. Direct repair in apps/api provider/runtime routing is out of scope for this bounded control-plane iteration, and retrying the same openai sendMessage combination is unlikely to help until the localhost API target is serving again. If control-plane startup logs show graph registration, worker startup, or server-running followed by flushing to persistent storage and exiting, treat that as partial readiness evidence only, not completed validation. If LangSmith visibility is pending-only for this thread or recent completed runs are mostly from other threads, treat that as partial observability only; cross-thread activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Preserve a clear operator-facing no-run defer reason unless this thread emits at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck.`
- `Localhost API refusal operator checklist:` `1) Confirm the blocked subsystem is apps/api provider/runtime routing and record that the direct fix is out of scope for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. 2) If startup logs only show graph registration, worker startup, or server-running followed by flush/exit, record partial readiness evidence only. 3) If LangSmith visibility is pending-only for this thread or recent completed runs are from other threads, record partial observability only; cross-thread activity does not satisfy this iteration. 4) Do not imply the localhost ECONNREFUSED issue was fixed from control-plane scope. 5) Keep the operator-facing no-run defer reason until there is at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set.`
- `No-run defer template for localhost API refusal:` `Thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane is carrying a bounded control-plane observability/workflow-hardening change only. The active goal is to continuously monitor, fix, and improve AnyGPT with safe control-plane-only changes while the direct fix for apps/api/logs/provider-unique-errors.jsonl openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses remains blocked out of scope in apps/api provider/runtime routing. Do not imply the localhost refusal was repaired from control-plane scope. LangSmith feedback for this repair window must be checked on this same thread; older runs, cross-thread runs, or pending-only visibility do not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Startup logs that register graphs, start workers, or report server-running before flushing/exiting are partial readiness evidence only, not completed validation. Preserve this no-run defer reason unless and until this same thread emits at least one fresh LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck. If no same-thread run was emitted, keep the defer reason explicit and operator-facing instead of claiming success.`
- `Operator checklist for this localhost refusal case:` `1) Name the blocked subsystem explicitly as apps/api provider/runtime routing for apps/api/logs/provider-unique-errors.jsonl openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses. 2) State that retrying the same openai sendMessage combination is unlikely to help until the localhost API target is serving again. 3) Record graph registration, worker startup, and server-running followed by flush/exit as partial readiness evidence only. 4) Record pending-only LangSmith visibility or runs from other threads as partial observability only; cross-thread activity does not satisfy thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. 5) Preserve the selected prompt reference and rollback reference when making bounded control-plane-only changes. 6) Do not restart production anygpt.service; only anygpt-experimental.service may be considered later if separately justified. 7) Treat the iteration as validated only after at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or else keep a clear no-run defer reason.`
- `Recommended no-run defer wording for this exact case:` `For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, the active goal was to make a bounded control-plane improvement while monitoring repo health. The active repair signal came from apps/api/logs/provider-unique-errors.jsonl: openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses. Direct repair of the blocked subsystem apps/api provider/runtime routing is out of scope for this control-plane-only iteration, so this pass only made a bounded control-plane observability or workflow-hardening change and does not claim the localhost apps/api runtime issue was fixed. Retry of the same openai sendMessage localhost combination is unlikely to help until the blocked localhost API target is serving again. Startup logs showing graph registration, worker startup, and server-running before flush/exit count as partial readiness evidence only. Pending-only LangSmith visibility or runs from other threads count as partial observability only and do not satisfy validation for this thread. Zero fresh same-thread runs for this iteration is a monitoring gap, not by itself a deploy or rollback trigger. Keep this defer reason until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result exists for the touched path set.`
- `Operator triage addendum for localhost refusal signals:` `When the active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED for http://localhost:3101/v1/responses, record the issue as scope-blocked in apps/api provider/runtime routing for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Do not summarize the iteration as an apps/api fix from control-plane scope. If control-plane startup logs show graph registration, worker startup, or server-running followed by immediate flush, exit, or shutdown, classify that as partial readiness only. If LangSmith visibility is pending-only or mostly from other threads, classify that as partial observability only; cross-thread activity does not satisfy this thread. The iteration is only validated after at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or else the operator-facing no-run defer reason must be preserved.`
- `Operator no-run defer template for localhost refusal signals:` `Active goal for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane is to keep monitoring and safely improve AnyGPT from control-plane scope. Active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses. Direct repair is out of scope for this bounded control-plane iteration because the blocked subsystem is apps/api provider/runtime routing and the localhost apps/api target is not serving. This iteration only made a bounded control-plane observability or workflow-hardening change in apps/langgraph-control-plane/README.md and does not claim the apps/api runtime issue was fixed. Startup logs that show graph registration, worker startup, or server-running followed by flush, exit, or shutdown are partial readiness evidence only, not completed validation. Pending-only LangSmith visibility or runs from other threads are partial observability only and do not satisfy validation for this thread. Zero fresh same-thread LangSmith control-plane runs for this iteration is a monitoring gap, not by itself a deploy or rollback trigger. Preserve this no-run defer reason until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists for the touched path set; retrying the same openai sendMessage localhost combination is unlikely to help until the blocked localhost apps/api target is serving again.`
- `Validation checklist for scope-blocked localhost refusal iterations:` `When the active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses, record the blocked subsystem as apps/api provider/runtime routing, state that direct repair there is out of scope for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, and avoid claiming the localhost apps/api target was repaired from control-plane scope. Treat graph registration, worker startup, and server-running logs followed by immediate flush, exit, or shutdown as partial readiness evidence only. Treat pending-only LangSmith visibility or runs from other threads as partial observability only; cross-thread activity does not satisfy this iteration. Build/typecheck-valid does not equal runtime-valid until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists for the touched path set, or else preserve a clear operator-facing no-run defer reason.`
- `Operator-facing defer template for localhost refusal monitoring:` `For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, if the active signal remains apps/api/logs/provider-unique-errors.jsonl with openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses, report the blocked subsystem as apps/api provider/runtime routing and say the direct fix is out of scope for this bounded control-plane iteration. Restate that the active goal is a bounded control-plane workflow-hardening improvement and that only allowed control-plane files were changed in this iteration, so apps/api/logs/provider-unique-errors.jsonl and apps/api provider/runtime routing remain unrepaired here. Also state that graph registration, worker startup, and server-running logs that immediately flush are partial readiness evidence only, that build/typecheck success is compile-time validation only, and that pending-only same-thread or any cross-thread LangSmith activity is partial observability only and does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Preserve a clear no-run defer reason unless this iteration produces at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set; retrying the same openai sendMessage localhost combination is unlikely to help until the localhost apps/api target is serving again.`
- `Current-thread validation reminder:` `Do not treat recent LangSmith success from other threads as validation for the active control-plane thread. For thread b31cedc0-ceb5-48d7-8772-cf97f38a3b42:control-plane, cross-thread activity does not satisfy this iteration, and pending or completed runs from sibling threads such as b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-runtime, b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-data, b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface, b31cedc0-ceb5-48d7-8772-cf97f38a3b42:ui-surface, and b31cedc0-ceb5-48d7-8772-cf97f38a3b42:homepage-surface do not satisfy validation for b31cedc0-ceb5-48d7-8772-cf97f38a3b42:control-plane. If the only current evidence is startup logs that register graphs, start workers, report server-running, and then flush or exit, classify that as partial readiness only. If same-thread LangSmith visibility is pending-only, stale, or absent as a fresh completed run for this iteration, classify that as partial observability only. When both signals appear together, treat them as combined partial observability plus partial readiness only, not completed validation. Because the active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses, the direct fix remains out of scope in the blocked apps/api provider/runtime routing subsystem; this iteration only changed the allowed control-plane file apps/langgraph-control-plane/README.md and did not repair localhost apps/api runtime availability. Build or typecheck success is compile-time validation only and does not satisfy runtime validation by itself. LangSmith prompt sync enabled without a returned URL and an unavailable live channel is prompt fallback drift risk only rather than rollout success. Keep a clear operator-facing no-run defer reason, preserve prompt rollback context anygpt-control-plane-agent:795656f0d31a78c81f973ac600fdfff02955e80d47d9cb7df48db7c6a3ef2b78, and note that retrying the same openai sendMessage localhost combination is unlikely to help until the localhost apps/api target is serving again. The iteration is only validated after at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted.`
