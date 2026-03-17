# AnyGPT LangGraph Control Plane

This workspace is a standalone orchestration service for planning and optionally executing build, test, and deploy jobs against this repository.

It now includes:

- multiple cooperating planner/execution agents inside a single LangGraph workflow
- direct MCP stdio server inspection from [`/.roo/mcp.json`](../../.roo/mcp.json)
- separate build, quality, and deploy planning stages
- experimental-safe defaults for AnyGPT API build, test, and deploy flows
- deterministic LangSmith-backed evaluation/regression gating for autonomous edits and execution

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

# Execute with an explicit deploy command
bun run dev -- --goal="Release API" --scopes=api --execute --allow-deploy --deploy-command="sudo systemctl restart anygpt-experimental"
```

## Current Scope Map

The built-in workflow currently understands these scopes:

- `repo`
- `api`
- `api-experimental`

Additional scopes can be added by extending the target map in [`src/workflow.ts`](src/workflow.ts).

## Agent Layout

The workflow is split into cooperating nodes in [`src/workflow.ts`](src/workflow.ts):

- `inspectMcp` — loads MCP server metadata
- `plannerAgent` — normalizes scopes and planning notes
- `buildAgent` — generates build jobs
- `qualityAgent` — generates test jobs
- `deployAgent` — generates deploy jobs
- `mergePlan` — combines all agent output into the final job plan
- `approvalGate` — pauses for approval before risky operations when execution is enabled
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

When LangSmith runtime integration is enabled, the inspection stage syncs the local prompt bundle to the configured sync channel and can optionally promote the selected bundle back to another bounded tag on the same prompt identifier. This keeps prompt automation limited to the control-plane prompt bundle instead of expanding into broader workspace or admin automation.

Current LangSmith integration in the control plane now covers:

- workspace discovery/selection
- accessible workspace inventory plus sampled workspace role introspection
- project creation/upsert and project inspection
- current-project description/metadata inspection for governance/admin state
- bounded current-project governance description/metadata sync hooks
- recent run inspection
- dataset creation and run-to-dataset seeding
- seed dataset creation for control-plane experiments
- prompt listing and prompt commit discovery
- prompt selection precedence for control-plane AI nodes
- prompt push/sync hooks for the control-plane prompt bundle
- bounded prompt promotion/version tagging hooks on the same prompt identifier
- annotation queue listing plus bounded queue detail/item sampling
- recent feedback inspection tied to sampled runs/queue items
- client helpers for controlled feedback creation against runs/examples
- evaluation experiment execution against the seed dataset
- deterministic evaluation/regression gate calculation from LangSmith evaluator output
- deterministic governance/admin flags for workspace pinning, project metadata alignment, run health, review backlog, and feedback signal presence
- summary/status surfacing of workspace/project/dataset/prompt/run/annotation/feedback/governance information

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

# CLI equivalents
bun run dev -- --goal="Regression gate smoke" --scopes=api-experimental --execute \
  --eval-gate-mode=enforce \
  --eval-gate-target=both \
  --eval-gate-require-evaluation=true \
  --eval-gate-min-results=1 \
  --eval-gate-metric=contains_goal_context \
  --eval-gate-min-score=1
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

# Bounded autonomous run for smoke testing
bun run dev -- --goal="Autonomous smoke run" --scopes=api-experimental --autonomous --interval-ms=5000 --max-iterations=2
```

When `--interval-ms` is omitted, continuous and autonomous loops now default to `10000ms`. Override that default with `CONTROL_PLANE_INTERVAL_MS` when you want a different steady-state cadence.

Continuous/autonomous status is persisted to [`apps/langgraph-control-plane/.control-plane/runner-status.json`](.control-plane/runner-status.json), including:

- current iteration
- running phase (`starting`, `streaming`, `sleeping`, `paused`, `completed`, `failed`)
- thread ID
- checkpoint path
- requested/selected prompt bundle refs plus sync/promotion outcomes
- last summary
- proposed/applied autonomous edit counts
- last applied edit paths
- current autonomous lane (`repair` vs `improvement`)
- post-repair validation/backtest outcomes
- experimental restart status and reason
- sampled LangSmith workspace names/count and current project admin metadata
- governance flag counts, actionable governance flags, and governance mutation statuses
- evaluation gate mode/status/reason and blocked actions
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

# Customize write scope and action count
bun run dev -- --goal="Control-plane self-heal" --scopes=control-plane --execute --autonomous-edits --edit-allowlist=apps/langgraph-control-plane,apps/api --max-edit-actions=2
```

Autonomous code edits are enforced through the allowlist/denylist logic, session manifests, touched-file snapshots, and rollback helpers in [`apps/langgraph-control-plane/src/autonomousEdits.ts`](src/autonomousEdits.ts).

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

Rollback is automatic when a touched repair fails smoke validation, when the evaluation gate blocks promotion after repair evaluation, or when post-repair validation fails after a promoted API change. Rollback restores previous contents for changed files and removes newly created files based on the recorded session manifest.

Runtime speed/aggression controls are now environment-driven:

```bash
CONTROL_PLANE_INTERVAL_MS=10000
CONTROL_PLANE_MCP_INSPECTION_TIMEOUT_MS=8000
CONTROL_PLANE_AI_AGENT_TIMEOUT_MS=25000
CONTROL_PLANE_REPAIR_SMOKE_TIMEOUT_MS=120000
CONTROL_PLANE_POST_REPAIR_VALIDATION_TIMEOUT_MS=600000
CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL=true
```

The runner status file at [`apps/langgraph-control-plane/.control-plane/runner-status.json`](.control-plane/runner-status.json) now surfaces the repair-loop status, intent summary, smoke result counts, promoted paths, rollback paths, and repair session metadata.

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
- autonomous post-repair restarts are reserved for `anygpt-experimental` and only occur on autonomous runs after validation passes
- production restarts targeting the `anygpt.service` alias or [`apps/api/anygpt-api.service`](../../apps/api/anygpt-api.service) are intentionally blocked by the workflow guardrails
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
- Live autonomous smoke validation should prefer bounded documentation-only edits within this README.
- Live autonomous smoke validation should prefer bounded documentation-only edits within this README.
- Live autonomous smoke validation should prefer bounded documentation-only edits within this README.
- Live autonomous smoke validation should prefer bounded documentation-only edits within this README.
- Live autonomous smoke validation should prefer bounded documentation-only edits within this README.
- Live autonomous smoke validation should prefer bounded documentation-only edits within this README.
