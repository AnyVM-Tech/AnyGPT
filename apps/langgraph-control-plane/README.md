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
