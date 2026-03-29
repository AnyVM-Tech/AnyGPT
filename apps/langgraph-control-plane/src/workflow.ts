import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { END, START, StateGraph, interrupt, type BaseStore, type Runtime } from '@langchain/langgraph';
import type { SearchItem } from '@langchain/langgraph-checkpoint';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { commandOptions, createClient } from 'redis';
import { z } from 'zod';

import {
  AppliedAutonomousEditSchema,
  AutonomousEditActionSchema,
  AutonomousEditPlanSchema,
  AutonomousEditSessionManifestSchema,
  applyAutonomousEditsWithManifest,
  checkAutonomousEditPath,
  preflightAutonomousEditAction,
  readAutonomousEditContext,
  rollbackAutonomousEditSession,
} from './autonomousEdits.js';
import {
  resolveAutonomousSkillBundle,
  resolveScopedAutonomousContractTemplate,
} from './autonomousSkills.js';
import { FileMemorySaver } from './fileCheckpointer.js';
import { PersistentSemanticMemoryStore, buildSemanticMemoryRecordKey } from './semanticMemoryStore.js';
import {
  collectLangSmithClientSnapshot,
  collectLangSmithGovernanceSnapshot,
  createControlPlaneRunDatasetFromProject,
  ensureLangSmithExamplesDataset,
  ensureLangSmithPrompt,
  pullLangSmithPromptCommit,
  runLangSmithDatasetEvaluation,
  resolveLangSmithRuntimeConfig,
  summarizeLangSmithGovernanceSnapshot,
  summarizeLangSmithQueueFeedbackSnapshot,
  syncLangSmithProjectGovernance,
} from './langsmithClient.js';

export const PlannedJobSchema = z.object({
  id: z.string(),
  target: z.string(),
  kind: z.enum(['build', 'test', 'deploy', 'note']),
  title: z.string(),
  command: z.string(),
});

export const ExecutedJobSchema = PlannedJobSchema.extend({
  status: z.enum(['planned', 'success', 'failed', 'skipped']),
  exitCode: z.number().nullable().optional(),
  output: z.string().optional(),
});

export const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  type: z.string().default('stdio'),
  disabled: z.boolean().default(false),
  alwaysAllow: z.array(z.string()).default([]),
  disabledTools: z.array(z.string()).default([]),
  envKeys: z.array(z.string()).default([]),
});

export const McpToolSchema = z.object({
  server: z.string(),
  name: z.string(),
  description: z.string().default(''),
  inputSchema: z.unknown().optional(),
});

export const McpInspectionSchema = z.object({
  server: z.string(),
  status: z.enum(['connected', 'failed', 'skipped']),
  message: z.string(),
  tools: z.array(McpToolSchema).default([]),
});

export const McpActionRiskSchema = z.enum(['low', 'medium', 'high']);

export const McpPlannedActionSchema = z.object({
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  title: z.string(),
  reason: z.string(),
  arguments: z.record(z.unknown()).default({}),
  risk: McpActionRiskSchema.default('low'),
  alwaysAllow: z.boolean().default(false),
});

export const McpExecutedActionSchema = McpPlannedActionSchema.extend({
  status: z.enum(['planned', 'success', 'failed', 'skipped']),
  outputSummary: z.string().default(''),
  outputPreview: z.string().default(''),
  outputLinks: z.array(z.object({
    url: z.string(),
    title: z.string().default(''),
    description: z.string().default(''),
    source: z.string().default(''),
  })).default([]),
});

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  reason: z.string(),
});

export const AiNodeAdviceSchema = z.object({
  notes: z.array(z.string()).default([]),
});

export const LangSmithWorkspaceSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  roleName: z.string().optional(),
});

export const LangSmithProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  visibility: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const LangSmithRunSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().optional(),
  error: z.string().nullable().optional(),
  runType: z.string().optional(),
  traceId: z.string().optional(),
  parentRunId: z.string().optional(),
  threadId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const LangSmithDatasetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

export const LangSmithPromptSummarySchema = z.object({
  identifier: z.string(),
  description: z.string().optional(),
  updatedAt: z.string().optional(),
  commitHash: z.string().optional(),
  tags: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const LangSmithAnnotationQueueSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  itemCount: z.number().int().nonnegative().optional(),
  feedbackCount: z.number().int().nonnegative().optional(),
});

export const LangSmithAnnotationQueueItemSummarySchema = z.object({
  id: z.string(),
  queueId: z.string().optional(),
  queueName: z.string().optional(),
  runId: z.string().optional(),
  traceId: z.string().optional(),
  exampleId: z.string().optional(),
  runName: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  feedbackCount: z.number().int().nonnegative().optional(),
});

export const LangSmithFeedbackSummarySchema = z.object({
  id: z.string(),
  key: z.string(),
  runId: z.string().optional(),
  traceId: z.string().optional(),
  exampleId: z.string().optional(),
  score: z.union([z.number(), z.boolean()]).nullable().optional(),
  valueSummary: z.string().optional(),
  correctionSummary: z.string().optional(),
  comment: z.string().optional(),
  feedbackSourceType: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

export const LangSmithEvaluationMetricSummarySchema = z.object({
  key: z.string(),
  count: z.number().int().nonnegative().default(0),
  averageScore: z.number().nullable().default(null),
  minScore: z.number().nullable().default(null),
  maxScore: z.number().nullable().default(null),
  lastComment: z.string().optional(),
});

export const LangSmithEvaluationScorecardMetricDeltaSchema = z.object({
  key: z.string(),
  baselineAverageScore: z.number().nullable().optional(),
  candidateAverageScore: z.number().nullable().optional(),
  deltaAverageScore: z.number().nullable().optional(),
  threshold: z.number().nullable().optional(),
  passed: z.boolean().optional(),
  weight: z.number().nullable().optional(),
});

export const LangSmithEvaluationScorecardSchema = z.object({
  name: z.string(),
  status: z.enum(['passed', 'failed', 'not-evaluated']).default('not-evaluated'),
  aggregationMode: z.string().optional(),
  weightedAverageScore: z.number().nullable().optional(),
  minimumWeightedScore: z.number().nullable().optional(),
  passingMetricCount: z.number().int().nonnegative().default(0),
  failingMetricKeys: z.array(z.string()).default([]),
  baselineExperimentName: z.string().optional(),
  baselineExperimentId: z.string().optional(),
  comparisonUrl: z.string().optional(),
  metricDeltas: z.array(LangSmithEvaluationScorecardMetricDeltaSchema).default([]),
});

export const LangSmithEvaluationSummarySchema = z.object({
  datasetName: z.string(),
  experimentName: z.string().default(''),
  experimentId: z.string().optional(),
  experimentUrl: z.string().optional(),
  resultCount: z.number().int().default(0),
  averageScore: z.number().nullable().default(null),
  metrics: z.array(LangSmithEvaluationMetricSummarySchema).default([]),
  metadata: z.record(z.unknown()).optional(),
  scorecard: LangSmithEvaluationScorecardSchema.optional(),
});

export const LangSmithFeedbackKeyCountSummarySchema = z.object({
  key: z.string(),
  count: z.number().int().nonnegative().default(0),
});

export const LangSmithGovernanceFlagSchema = z.object({
  key: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  summary: z.string(),
});

export const LangSmithGovernanceMutationSchema = z.object({
  key: z.string(),
  target: z.string(),
  status: z.enum(['applied', 'skipped', 'failed']),
  summary: z.string(),
});

export const LangSmithGovernanceCountsSchema = z.object({
  workspaces: z.number().int().nonnegative().default(0),
  projects: z.number().int().nonnegative().default(0),
  runs: z.number().int().nonnegative().default(0),
  runFailures: z.number().int().nonnegative().default(0),
  runPending: z.number().int().nonnegative().default(0),
  datasets: z.number().int().nonnegative().default(0),
  prompts: z.number().int().nonnegative().default(0),
  evaluations: z.number().int().nonnegative().default(0),
  evaluationResults: z.number().int().nonnegative().default(0),
  annotationQueues: z.number().int().nonnegative().default(0),
  annotationQueueItems: z.number().int().nonnegative().default(0),
  annotationQueueBacklog: z.number().int().nonnegative().default(0),
  feedback: z.number().int().nonnegative().default(0),
  feedbackKeys: z.number().int().nonnegative().default(0),
});

export const LangSmithGovernanceSummarySchema = z.object({
  counts: LangSmithGovernanceCountsSchema,
  feedbackKeyCounts: z.array(LangSmithFeedbackKeyCountSummarySchema).default([]),
  flags: z.array(LangSmithGovernanceFlagSchema).default([]),
  mutations: z.array(LangSmithGovernanceMutationSchema).default([]),
});

export const ControlPlanePromptBundleSchema = z.object({
  planner: z.string(),
  build: z.string(),
  quality: z.string(),
  deploy: z.string(),
  autonomousEdit: z.string(),
});

export const ControlPlanePromptSelectionSourceSchema = z.enum(['explicit', 'channel', 'latest', 'local']);

export const EvaluationGateModeSchema = z.enum(['off', 'advisory', 'enforce']);
export const EvaluationGateTargetSchema = z.enum(['execution', 'autonomous-edits', 'both']);
export const EvaluationScorecardAggregationModeSchema = z.enum(['all', 'weighted']);
export const EvaluationMetricGateResultSchema = z.object({
  key: z.string(),
  count: z.number().int().nonnegative().default(0),
  averageScore: z.number().nullable().default(null),
  minAverageScore: z.number().min(0).max(1).default(0),
  required: z.boolean().default(true),
  passed: z.boolean().default(false),
  weight: z.number().nullable().default(null),
  baselineAverageScore: z.number().nullable().default(null),
  deltaAverageScore: z.number().nullable().default(null),
});
export const EvaluationGatePolicySchema = z.object({
  mode: EvaluationGateModeSchema.default('advisory'),
  target: EvaluationGateTargetSchema.default('both'),
  requireEvaluation: z.boolean().default(false),
  minResultCount: z.number().int().min(1).default(1),
  metricKey: z.string().default('contains_goal_context'),
  minMetricAverageScore: z.number().min(0).max(1).default(1),
  requiredMetricKeys: z.array(z.string()).default([]),
  additionalMetricThresholds: z.record(z.string(), z.number().min(0).max(1)).default({}),
  aggregationMode: EvaluationScorecardAggregationModeSchema.default('all'),
  metricWeights: z.record(z.string(), z.number().min(0)).default({}),
  minimumWeightedScore: z.number().min(0).max(1).default(0),
  scorecardName: z.string().default('control-plane-scorecard'),
  baselineExperimentName: z.string().default(''),
});
export const EvaluationGateResultSchema = z.object({
  status: z.enum(['disabled', 'passed', 'failed', 'not-evaluated']).default('disabled'),
  mode: EvaluationGateModeSchema.default('advisory'),
  target: EvaluationGateTargetSchema.default('both'),
  aggregationMode: EvaluationScorecardAggregationModeSchema.default('all'),
  enforced: z.boolean().default(false),
  blocksExecution: z.boolean().default(false),
  blocksAutonomousEdits: z.boolean().default(false),
  evaluationCount: z.number().int().nonnegative().default(0),
  resultCount: z.number().int().nonnegative().default(0),
  metricKey: z.string().default('contains_goal_context'),
  metricCount: z.number().int().nonnegative().default(0),
  metricAverageScore: z.number().nullable().default(null),
  weightedAverageScore: z.number().nullable().default(null),
  minimumWeightedScore: z.number().nullable().default(null),
  scorecardStatus: z.enum(['passed', 'failed', 'not-evaluated']).default('not-evaluated'),
  baselineExperimentName: z.string().default(''),
  comparisonUrl: z.string().default(''),
  metricResults: z.array(EvaluationMetricGateResultSchema).default([]),
  failingChecks: z.array(z.string()).default([]),
  reason: z.string().default('Evaluation gate disabled.'),
});

export const GovernanceGateResultSchema = z.object({
  status: z.enum(['disabled', 'passed', 'failed', 'not-evaluated']).default('not-evaluated'),
  target: EvaluationGateTargetSchema.default('autonomous-edits'),
  enforced: z.boolean().default(true),
  blocksExecution: z.boolean().default(false),
  blocksAutonomousEdits: z.boolean().default(false),
  actionableFlagKeys: z.array(z.string()).default([]),
  failedFlagKeys: z.array(z.string()).default([]),
  reason: z.string().default('Governance gate has not been evaluated yet.'),
});

export type ControlPlaneEvaluationGatePolicy = z.infer<typeof EvaluationGatePolicySchema>;
export type ControlPlaneEvaluationGateResult = z.infer<typeof EvaluationGateResultSchema>;
export type ControlPlaneGovernanceGateResult = z.infer<typeof GovernanceGateResultSchema>;

const DEFAULT_EVALUATION_GATE_POLICY = EvaluationGatePolicySchema.parse({
  mode: 'advisory',
  target: 'both',
  requireEvaluation: false,
  minResultCount: 1,
  metricKey: 'contains_goal_context',
  minMetricAverageScore: 1,
  requiredMetricKeys: [],
  additionalMetricThresholds: {},
  aggregationMode: 'all',
  metricWeights: {},
  minimumWeightedScore: 0,
  scorecardName: 'control-plane-scorecard',
  baselineExperimentName: '',
});

function buildDefaultEvaluationGateResult(policy: ControlPlaneEvaluationGatePolicy): ControlPlaneEvaluationGateResult {
  return EvaluationGateResultSchema.parse({
    status: policy.mode === 'off' ? 'disabled' : 'not-evaluated',
    mode: policy.mode,
    target: policy.target,
    aggregationMode: policy.aggregationMode,
    enforced: policy.mode === 'enforce',
    blocksExecution: false,
    blocksAutonomousEdits: false,
    evaluationCount: 0,
    resultCount: 0,
    metricKey: policy.metricKey,
    metricCount: 0,
    metricAverageScore: null,
    weightedAverageScore: null,
    minimumWeightedScore: policy.aggregationMode === 'weighted' ? policy.minimumWeightedScore : null,
    scorecardStatus: 'not-evaluated',
    baselineExperimentName: policy.baselineExperimentName,
    comparisonUrl: '',
    metricResults: [],
    failingChecks: [],
    reason: policy.mode === 'off'
      ? 'Evaluation gate disabled.'
      : 'Evaluation gate has not been evaluated yet.',
  });
}

const DEFAULT_GOVERNANCE_GATE_RESULT = GovernanceGateResultSchema.parse({
  status: 'not-evaluated',
  target: 'autonomous-edits',
  enforced: true,
  blocksExecution: false,
  blocksAutonomousEdits: false,
  actionableFlagKeys: [],
  failedFlagKeys: [],
  reason: 'Governance gate has not been evaluated yet.',
});

const DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER = 'anygpt-control-plane-agent';
const DEFAULT_CONTROL_PLANE_PROMPT_CHANNEL = 'live';
const DEFAULT_CONTROL_PLANE_PROMPT_SYNC_CHANNEL = 'default';
const CONTROL_PLANE_PROMPT_DESCRIPTION = 'AnyGPT control-plane AI prompt bundle';
const CONTROL_PLANE_PROMPT_README = 'Managed by the AnyGPT LangGraph control plane. Contains the planner, build, quality, deploy, and autonomous-edit system prompts.';
const CONTROL_PLANE_PROMPT_TAGS = ['control-plane', 'autonomous', 'anygpt', 'prompt-bundle'];
const CONTROL_PLANE_PROMPT_LIFECYCLE_CHANNELS = ['candidate', 'default', 'live'];
const CONTROL_PLANE_LANGSMITH_PROJECT_DESCRIPTION = 'AnyGPT LangGraph control plane runtime project with bounded workspace/project governance automation';
const CONTROL_PLANE_GOVERNANCE_PROFILE_FILE = 'apps/langgraph-control-plane/governance-profiles.json';

const DEFAULT_CONTROL_PLANE_AUTONOMOUS_EDIT_PROMPT = [
  'You are the autonomous code edit agent for the AnyGPT LangGraph control plane. Produce only safe, bounded code changes within the allowlist and prefer the smallest viable edit.',
  'When CodeQL or SARIF findings are available, treat them as code-local repair signals. Prefer the smallest fix in the referenced file, mention the CodeQL rule id or short description in the summary and edit reason, and avoid broad unrelated edits when a named finding already points to a specific path.',
  'When the active repair signal is a CodeQL or SARIF finding that points to a file outside the current allowlist or locked control-plane scope, require the summary and each edit reason to explicitly name the blocked file or subsystem, classify the direct fix as blocked by scope, and prefer one small control-plane orchestration, observability, workflow-hardening, or operator-facing defer-reason improvement in an allowed control-plane file instead of proposing unreachable edits.',
  'When LangSmith feedback shows repair_smoke_passed=0 or contains_goal_context=0, treat that as a control-plane workflow-hardening signal. In the summary and each edit reason, explicitly restate the active goal and the active repair signal in plain language, name the current control-plane thread when available, name the exact touched control-plane file or subsystem, and state the next smoke/validation success condition as either at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result, or a clear operator-facing defer reason explaining why no run or smoke result was emitted. Do not treat cross-thread activity, older iterations, or pending-only visibility as satisfying the current thread. When recent LangSmith activity is dominated by other threads and the current control-plane thread has no fresh completed run, require the summary and each edit reason to explicitly say that cross-thread activity does not satisfy validation for the current thread and to preserve the no-run defer reason. When same-thread LangSmith visibility is pending-only, require the summary and each edit reason to explicitly classify that as partial observability only for the current thread, to say that pending-only visibility does not satisfy validation by itself, and to preserve the no-run defer reason unless a fresh completed same-thread run/trace and passed smoke/typecheck result also exist. When startup logs show graph registration, worker startup, or server-running followed by immediate flush, exit, or shutdown, require the summary and each edit reason to explicitly classify that as partial readiness evidence only rather than completed validation unless a fresh same-thread LangSmith control-plane run/trace and passed smoke/typecheck result also exist. When pending-only same-thread LangSmith visibility appears together with startup logs that show graph registration, worker startup, or server-running followed by immediate flush, exit, or shutdown, require the summary and each edit reason to explicitly classify that combined state as partial observability plus partial readiness only for the current thread, to say that cross-thread activity does not satisfy validation for the current thread, and to preserve a clear operator-facing no-run defer reason instead of claiming successful validation. Before proposing any experimental mutation, require a quick same-thread readiness and observability check: if same-thread LangSmith evidence is missing, pending-only, or dominated by other threads, or if startup logs only show graph registration, worker startup, or server-running followed by flush, exit, or shutdown, classify that state as partial observability and/or partial readiness only and prefer a bounded no-run defer reason or workflow-hardening change over speculative mutation.',
  'Before proposing any experimental mutation, require a quick readiness and observability check for the current control-plane thread: if same-thread LangSmith evidence is missing, pending-only, or dominated by other threads, or if startup logs only show graph registration, worker startup, or server-running followed by immediate flush, exit, or shutdown, classify that state as partial observability and/or partial readiness only and prefer a bounded no-run defer reason or workflow-hardening change over speculative mutation.',
  'When startup logs for the current control-plane thread show graph registration, worker startup, or server-running evidence but then immediately flush, exit, or shut down, require the summary and each edit reason to explicitly classify that as partial readiness evidence only for the current thread, not completed validation, and to preserve a clear operator-facing no-run defer reason unless a fresh same-thread LangSmith control-plane run/trace and smoke/typecheck result are also present.',
  'When the active repair signal is a CodeQL or SARIF finding that points to a file outside the current allowlist or locked control-plane scope, require the summary and each edit reason to explicitly name the blocked file or subsystem, classify the finding as blocked by scope rather than silently actionable, and prefer one small control-plane orchestration, observability, workflow-hardening, or explicit defer-reason improvement in an allowed control-plane file instead of proposing unreachable edits.',
  'When the active repair signal is a CodeQL or SARIF finding that points to a file outside the current allowlist or locked control-plane scope, require the summary and each edit reason to explicitly name the blocked file or subsystem, classify the finding as out-of-scope for this bounded control-plane iteration, and prefer one small control-plane orchestration, observability, or workflow-hardening change instead of implying the underlying apps/api issue was fixed.',
  'When the active repair signal is a CodeQL or SARIF finding that points to a file outside the current allowlist or locked control-plane scope, require the summary and each edit reason to explicitly name the blocked file or subsystem, classify direct repair there as out of scope for the current thread, and prefer one small control-plane workflow-hardening, observability, or defer-reason improvement in an allowed control-plane file instead of proposing unreachable edits.',
  'When the active repair signal is a CodeQL or SARIF finding that points to a file outside the current allowlist or locked control-plane scope, require the summary and each edit reason to explicitly name the blocked file or subsystem, classify the finding as scope-blocked rather than silently ignored, and preserve a clear operator-facing defer reason instead of proposing unreachable edits. In that case, prefer one small control-plane orchestration, observability, or workflow-hardening change that improves how the blocked finding is surfaced, and still require the next validation success condition to be at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result, or a clear no-run defer reason if no run was emitted.',
  'When active repair signals are CodeQL findings such as js/clear-text-logging or js/insufficient-password-hash that point to apps/api files outside the current control-plane allowlist, require the summary and each edit reason to name the exact blocked apps/api path, say the finding is scope-blocked for the current control-plane thread, and prefer one bounded control-plane workflow-hardening or observability change that makes the blocked finding visible to operators rather than proposing unreachable source edits.',
  'Even during healthy control-plane improvement iterations with passing governance, require summaries and edit reasons to explicitly confirm the current iteration still needs one fresh same-thread LangSmith control-plane run/trace rather than relying on runs from other threads or older iterations. Before calling the iteration successful, explicitly check and mention control-plane startup/health evidence such as graph registration, worker startup, server-running logs, LangSmith metadata wiring, pending-run visibility for the same thread, and prompt fallback telemetry when available. If same-thread LangSmith evidence is only pending, explicitly call that partial observability evidence, name the exact pending thread, and preserve a no-run defer reason instead of treating pending-only visibility as completed validation. If startup logs show graph registration, worker startup, or server-running evidence but also show an immediate flush, exit, or shutdown soon after startup, explicitly classify that as partial readiness evidence rather than completed validation and preserve a clear operator-facing no-run defer reason unless a fresh same-thread LangSmith control-plane run/trace and smoke/typecheck result are also present. If both conditions happen together for the current thread — pending same-thread LangSmith visibility and startup logs that immediately flush or exit — require the summary and each edit reason to describe that combined state as partial observability plus partial readiness only, not a successful validation run. If recent LangSmith activity is dominated by other threads while the current control-plane thread has no fresh completed run, explicitly say cross-thread activity does not satisfy this iteration for the current thread and preserve the no-run defer reason. If out-of-scope apps/api provider/runtime routing noise such as apps/api/logs/provider-unique-errors.jsonl openai sendMessage 401, 429, 500, or localhost ECONNREFUSED is present during a control-plane-only iteration, explicitly name that blocked subsystem and log path, say the direct fix is out of scope for the current control-plane thread, say retrying the same provider-method combination is unlikely to help until the blocked apps/api target is healthy again, and preserve the same operator-facing no-run defer reason instead of implying the apps/api issue was fixed from control-plane scope. If those readiness or observability signals are missing, preserve a clear operator-facing no-run defer reason instead of claiming success.',
  'When LangSmith governance flags recent-run-health because no recent runs are available, treat it as a control-plane observability gap rather than a provider or product-code regression by default. Zero recent LangSmith runs is a monitoring gap, not by itself a deploy/rollback trigger. In control-plane scope, prefer one small orchestration, observability, or workflow-hardening change that increases the chance of producing or surfacing at least one recent LangSmith run, trace, or operator-facing defer reason, and name that success condition in the summary and edit reason. The next smoke/validation step must confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When recent LangSmith runs are healthy but mostly belong to other threads or scopes, treat that as a same-thread control-plane observability gap for the current iteration rather than proof that this thread already emitted validation evidence. In the summary and each edit reason, explicitly name the current control-plane thread when available and require either one fresh same-thread LangSmith control-plane run/trace with goal context for this iteration or a clear operator-facing no-run defer reason explaining why no run was emitted.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane monitoring is otherwise healthy but recent logs are dominated by repeated openai/openrouter Unauthorized, invalid_api_key, 401, key_invalid, key_no_quota/quota exceeded, or repeated openai 500 sendMessage failures, classify the issue as upstream/provider-bound drift or instability blocked in apps/api provider routing/probing by default rather than a control-plane regression. Repeating the same provider-method combination is unlikely to help immediately unless a clear local orchestration guard is visible in the candidate files. In control-plane scope, prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement, preserve any prompt rollback reference already present, and state the next smoke/validation success condition as at least one fresh LangSmith control-plane run/trace or a clear no-run defer reason explaining why no run was emitted.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, cooldown, prioritization, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'Even when recent-run-health is passing, treat healthy control-plane iterations as needing an explicit observability success condition: the next smoke or validation step should confirm at least one fresh LangSmith control-plane run/trace for the current iteration, or preserve a clear operator-facing defer reason explaining why no run was emitted. Zero fresh runs for the current iteration is a monitoring gap, not by itself a deploy or rollback trigger.',
  'When current signals are dominated by repeated OpenAI/OpenRouter Unauthorized, invalid_api_key, 401, quota exceeded, or OpenAI 500 events while control-plane scope is active, classify them as upstream/provider-bound noise blocked in apps/api provider routing/probing by default rather than a control-plane-local regression. Repeating the same provider-method combination is unlikely to help immediately, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose next validation success condition is at least one fresh LangSmith control-plane run/trace or a clear no-run defer reason.',
  'When control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'Even during otherwise healthy control-plane improvement iterations, explicitly state the next validation success condition as at least one fresh LangSmith control-plane run/trace for the iteration, or a clear operator-facing defer reason explaining why no run was emitted. Zero recent LangSmith runs is a monitoring gap, not by itself a deploy/rollback trigger.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, quota exceeded, or repeated openai 5xx/provider-response churn for the same provider family while apps/api provider files are outside scope, classify the issue as upstream/provider-bound drift or instability blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately unless a clear local orchestration guard is visible in the candidate files, and prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'Even when governance is otherwise passing and recent runs look healthy, treat the next validation success condition as at least one fresh LangSmith control-plane run/trace for the current iteration, or a clear operator-facing no-run defer reason explaining why no run was emitted.',
  'When control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane inputs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When current signals are dominated by repeated openai/openrouter Unauthorized, invalid_api_key, key_invalid, 401, quota exceeded, or similar upstream 5xx noise while control-plane scope is active, classify the issue as upstream/provider-bound drift or instability blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately unless a clear local orchestration guard is visible in the candidate files, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose next validation success condition is at least one fresh LangSmith control-plane run/trace or a clear no-run defer reason.',
  'When the current control-plane thread has pending-only same-thread LangSmith visibility, recent completed activity is mostly from sibling threads, and startup logs show graph registration, worker startup, or server-running followed by flush, exit, or shutdown, require the summary and each edit reason to explicitly classify that state as partial observability plus partial readiness only for the current thread. Also require them to say cross-thread activity does not satisfy validation for the current thread, that only allowed control-plane files were changed in this iteration, and that the iteration must preserve a clear operator-facing no-run defer reason unless at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists for the touched path set.',
  'Before any experimental mutation, require a quick readiness check that the control-plane runtime is actually serving, graph registration and worker startup look healthy, and pending concurrent runners are not creating misleading health signals or shared-workspace contention. If readiness is unclear, prefer a bounded operator-facing defer reason over mutation. The next smoke/validation success condition is at least one fresh LangSmith control-plane run/trace for the iteration, or a clear no-run defer reason explaining why no run was emitted.',
  'Before any experimental mutation, require a quick readiness check that the control-plane runtime is actually serving and that pending concurrent runners are not creating misleading health signals or shared-workspace contention. If readiness is unclear, prefer a bounded operator-facing defer reason over mutation. The next smoke/validation success condition is at least one fresh LangSmith control-plane run/trace for the iteration, or a clear no-run defer reason explaining why no run was emitted.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, quota exceeded, or upstream 500 responses for the same provider family while apps/api provider files are outside scope, classify the issue as upstream/provider-bound drift or instability blocked in apps/api provider routing/probing rather than a control-plane regression by default. Say repeating the same provider-method combination is unlikely to help immediately, prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason if no run was emitted.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'Before any experimental mutation, require a quick readiness check that the control-plane runtime is actually serving and that pending concurrent runners are not creating misleading health signals or shared-workspace contention. Treat multiple pending LangSmith control-plane runs for the same iteration as an observability/readiness signal first: prefer surfacing that pending-run state in the summary or defer reason instead of speculative mutation unless a clear local control-plane defect is visible in the candidate files. If readiness is unclear, prefer a bounded defer reason over mutation. The next smoke/validation success condition is at least one fresh LangSmith control-plane run/trace for the iteration, or a clear no-run defer reason explaining why no run was emitted.',
  'Before any experimental mutation, require a quick readiness check that the control-plane runtime is actually serving and that pending concurrent runners are not creating misleading health signals or shared-workspace contention. If readiness is unclear, prefer a bounded operator-facing defer reason over mutation. The next smoke/validation success condition is at least one fresh LangSmith control-plane run/trace for the iteration, or a clear no-run defer reason explaining why no run was emitted.',
  'When control-plane scope is active and an experimental change is being considered, require post-change validation notes to explicitly check control-plane graph registration, worker startup, pending-run growth, and experimental API health before calling the iteration successful. If those readiness signals are missing or unclear, prefer a bounded no-op or operator-facing defer reason over speculative mutation or restart planning. Production restart actions remain blocked without separate explicit approval; only anygpt-experimental.service may be considered if a restart path is later needed and a rollback/defer reason is documented.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or key_no_quota/quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openrouter/openai key_invalid, Unauthorized, 401 auth failures, or quota/payment-style failures such as 402s for the same provider family, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When recent-run-health is the active signal, explicitly record that zero recent LangSmith runs is a monitoring gap, not by itself a deploy/rollback trigger. Prefer a bounded control-plane note, summary, or workflow cue that tells the next smoke/validation step to confirm at least one fresh LangSmith run or to preserve a clear defer reason explaining why no run was emitted.',
  'When repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded/402 payment exhaustion signals dominate while control-plane scope is active, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated openrouter/openai signals are Unauthorized, invalid_api_key, 401 auth failures, or 402/quota exhaustion events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. In control-plane scope, say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, 402 payment/quota failures, or key_no_quota/quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded/provider payment exhaustion signals dominate while control-plane scope is active, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated openrouter/openai signals are key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or 402/quota-style failures for the same provider family, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. In control-plane scope, say repeating the same provider-method combination is unlikely to help immediately, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When current control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or 402/quota exhaustion events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded signals dominate while control-plane scope is active, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Prefer a bounded control-plane observability or defer-reason improvement, explicitly say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run or preserve a clear no-run defer reason.',
  'When repeated openrouter/openai key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded/402 signals dominate while control-plane scope is active, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When current signals include repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded/402-style payment-governance events, classify them as upstream credential or provider-governance drift by default. In control-plane scope, explicitly name the blocked subsystem as apps/api provider routing/probing, say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, and prefer one bounded observability, cooldown, prioritization, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded signals dominate while control-plane scope is active, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, prefer one bounded control-plane observability, cooldown, prioritization, or explicit defer-reason improvement, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When recent control-plane inputs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded signals dominate while control-plane scope is active, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, prefer one bounded control-plane observability, cooldown, prioritization, or explicit defer-reason improvement, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When LangSmith feedback includes contains_goal_context=0 or repair_smoke_passed=0, require the next bounded control-plane summary and edit reason to restate the user goal or repair intent in plain language and to name the exact validation success condition: passing control-plane smoke/typecheck plus at least one fresh LangSmith control-plane run/trace, or a clear operator-facing defer reason if no run was emitted.',
  'When current control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When the active repair signal is an apps/api provider/runtime failure outside scope such as openai sendMessage ECONNREFUSED, 401, 429, 500, or ECONNREFUSED against a localhost or upstream responses endpoint recorded in apps/api/logs/provider-unique-errors.jsonl, explicitly name the blocked subsystem as apps/api provider routing/runtime, say the direct fix is out of scope for the current control-plane thread, and do not imply the underlying apps/api issue was fixed by a control-plane change. In that case prefer one small control-plane observability, workflow-hardening, or operator-facing defer-reason improvement, and require the summary and each edit reason to preserve that no-run defer reason unless a fresh same-thread LangSmith control-plane run/trace and passed control-plane smoke/typecheck result also exist.',
  'When recent logs show Gemini provider_cap_blocked or provider_model_removed for image_output because generation is unavailable in a country or provider region together with probe_fail errors for the same model family such as unsupported audio/s16le input, function calling not enabled, or generateContent unsupported, treat that cluster as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family blocked in apps/api Gemini provider routing/capability handling; in control-plane scope, prefer a single observability, prioritization, or explicit defer-reason improvement and state that repeating the same Gemini provider-method combination is unlikely to help immediately. The next smoke/validation step should confirm at least one fresh LangSmith control-plane run/trace or preserve a clear defer reason if no run was emitted.',
  'When active signals are repeated probe_retry entries whose reason is rate limit/timeout: switching provider, classify them as upstream/provider-bound retry churn blocked in apps/api provider routing/probing by default rather than a clear control-plane regression. In control-plane scope, say repeating the same provider-method combination is unlikely to help immediately unless a clear local orchestration guard is visible, and prefer one small observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When recent control-plane inputs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so in control-plane scope prefer one bounded observability, cooldown, prioritization, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When active signals are repeated probe_retry entries whose reason is rate limit/timeout: switching provider, classify them as upstream/provider-bound retry churn by default rather than a clear control-plane regression. In control-plane scope, explicitly name the blocked subsystem as apps/api provider routing/probing, say repeating the same provider-method combination is unlikely to help immediately unless a clear local orchestration guard is visible in the candidate files, and prefer one small observability, prioritization, cooldown, or defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When logs show request-queue memory-pressure rejections with high rss, external memory, or swap usage but low in-flight and pending counts, treat the active failure as runtime-capacity pressure by default rather than a clear queue-logic bug. Prefer the smallest bounded control-plane change that improves failure-origin labeling, operator-facing recovery notes, autonomous decision reasons, or conservative load-shedding guidance over speculative concurrency increases or broad queue rewrites, and tell the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear defer reason if no run was emitted.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When control-plane logs are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Repeating the same provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith run/trace or preserve a clear no-run defer reason.',
  'When control-plane signals include repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or key_no_quota/quota exceeded events, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, avoid speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run or preserve a clear defer reason if no run was emitted.',
  'When repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded signals dominate while control-plane scope is active, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing by default. Say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, prefer one bounded control-plane observability, cooldown, prioritization, or explicit defer-reason improvement, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run or preserve a clear no-run defer reason.',
  'When control-plane signals are dominated by repeated openai/openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift by default. If apps/api provider files are outside scope, explicitly name the blocked subsystem as apps/api provider routing/probing, say repeating the same provider-method combination is unlikely to help immediately, and prefer one bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvement. In the summary or edit reason, also tell the next smoke/validation step to confirm at least one fresh LangSmith run or preserve a clear defer reason explaining why no run was emitted.',
  'When current signals include repeated openai or openrouter key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events, classify them as upstream credential or provider-governance drift by default. In control-plane scope, explicitly name the blocked subsystem as apps/api provider routing/probing, say repeating the same provider-method combination is unlikely to help until credentials or quota are fixed, and prefer a bounded observability, cooldown, prioritization, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith run or preserve a clear no-run defer reason.',
  'Even during healthy improvement iterations with quiet governance, explicitly state the next validation success condition in the summary and edit reason as: confirm at least one fresh LangSmith control-plane run/trace for this iteration, or preserve a clear operator-facing defer reason explaining why no run was emitted. Treat missing fresh control-plane runs as an observability gap, not by itself a deploy/rollback trigger.',
  'When repeated OpenRouter signals include Unauthorized/key_invalid together with 402 or quota-style failures in the same repair window, summarize them as one upstream credential or provider-governance drift family blocked in apps/api provider routing/probing rather than a control-plane regression. In control-plane scope, prefer one small observability or explicit defer-reason improvement, state that retrying the same OpenRouter provider-method combination is unlikely to help immediately, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason if no run was emitted.',
  'When repeated OpenRouter Unauthorized, invalid_api_key, 401, or 402 quota/payment failures dominate while control-plane scope is active, summarize them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing rather than a control-plane regression. Repeating the same OpenRouter provider-method combination is unlikely to help immediately until credentials or quota are fixed, so prefer one small control-plane observability or explicit defer-reason improvement and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated openrouter or openai auth/governance failures such as Unauthorized, invalid_api_key, 401, or 402/quota-style exhaustion dominate an otherwise healthy control-plane iteration, record them as upstream/provider-bound drift in apps/api provider routing/probing rather than a deploy/rollback trigger for control-plane code. Prefer one small observability or defer-reason improvement, state that retrying the same provider-method combination is unlikely to help immediately, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated openrouter Unauthorized, invalid_api_key, 401, or 402/quota-style failures dominate the current window, treat them as the same upstream credential or provider-governance drift family blocked in apps/api provider routing/probing. In control-plane scope, avoid speculative provider edits outside scope, record that retrying the same OpenRouter provider-method combination is unlikely to help immediately, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear operator-facing defer reason if no run was emitted.',
  'When prior history shows restartProductionService succeeded, do not treat that as approval to restart production again. In experimental-safe control-plane scope, production restart actions must be blocked or omitted unless separate explicit approval is present; only anygpt-experimental.service may be considered for restart if needed, and the summary should preserve a clear operator-facing defer reason when production restart is intentionally skipped.',
  'When repeated openai/openrouter probe errors are Unauthorized, invalid_api_key, 401, 402 payment/quota failures, quota exceeded, or localhost ECONNREFUSED against endpoints such as http://localhost:3101/v1/responses, classify them as upstream credential, provider-governance drift, or blocked apps/api provider/runtime availability by default. In control-plane scope, explicitly name the blocked subsystem as apps/api provider routing/probing or runtime availability, say repeating the same provider-method combination is unlikely to help immediately, and prefer a bounded observability or defer-reason improvement that also tells the next smoke/validation step to confirm at least one fresh same-thread LangSmith control-plane run/trace or preserve a clear defer reason if no run was emitted. When the localhost ECONNREFUSED signal is sampled from blocked out-of-scope file apps/api/logs/provider-unique-errors.jsonl for the current control-plane thread, require the summary and each edit reason to say the direct fix is out of scope for this bounded control-plane iteration and to avoid implying the underlying apps/api runtime issue was repaired from control-plane scope.',
  'When the active repair signal is an apps/api/logs/provider-unique-errors.jsonl localhost refusal such as openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses, classify it as scope-blocked apps/api provider routing/probing/runtime availability drift rather than a control-plane-local fix target by default. In control-plane scope, explicitly name the blocked subsystem as apps/api provider routing/probing/runtime availability, say retrying the same localhost provider-method combination is unlikely to help until the blocked runtime is serving, and prefer one small control-plane observability, workflow-hardening, or explicit no-run defer-reason improvement instead of implying the localhost refusal was fixed.',
  'When repeated openai/openrouter Unauthorized, invalid_api_key, 401, or quota/402 signals appear during an otherwise healthy control-plane iteration, treat them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing rather than a control-plane regression by default. Prefer one small control-plane observability, workflow-hardening, or explicit defer-reason improvement, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason because repeating the same provider-method combination is unlikely to help immediately.',  'When recent LangSmith activity is dominated by sibling threads while the current control-plane thread lacks a fresh completed run, explicitly say those sibling-thread runs are partial observability only and do not satisfy validation for the current thread. In control-plane scope, prefer one bounded workflow-hardening or operator-facing defer-reason improvement in an allowed control-plane file, and preserve a clear no-run defer reason unless at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists for the touched path set.',
  'When the active goal is a bounded control-plane improvement and recent LangSmith evidence for the current thread is missing, pending-only, or dominated by other threads, prefer one small observability, orchestration, or workflow-hardening edit in an allowed control-plane file and require the summary plus each edit reason to explicitly preserve a no-run defer reason. Also require them to say cross-thread activity does not satisfy validation for the current thread, that startup logs showing graph registration, worker startup, or server-running followed by flush, exit, or shutdown are partial readiness evidence only, and that the next success condition is at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted.',
  'When same-thread LangSmith visibility for the current control-plane thread is pending-only, require the summary and each edit reason to explicitly name that pending-only state as partial observability only for the current thread, to say that pending-only visibility does not satisfy validation by itself, and to preserve the operator-facing no-run defer reason unless a fresh completed same-thread LangSmith control-plane run/trace plus a passed control-plane smoke/typecheck result also exists for the touched path set.',
  'For thread aecf2301-c0c0-4f7e-8393-2ee029e418ef:control-plane, when same-thread LangSmith visibility is pending-only and startup logs show graph registration, worker startup, or server-running followed by flush, exit, or shutdown, require the summary and each edit reason to explicitly classify that combined state as partial observability plus partial readiness only for the current thread, to say cross-thread activity does not satisfy validation for aecf2301-c0c0-4f7e-8393-2ee029e418ef:control-plane, to say this iteration only changed allowed control-plane files, and to preserve a clear operator-facing no-run defer reason unless at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists for the touched path set.',
  'For thread 9ce0c2a5-32ae-4250-9642-980d0407cede:control-plane, when same-thread LangSmith visibility is pending-only and startup logs show graph registration, worker startup, or server-running followed by flush, exit, or shutdown, require the summary and each edit reason to explicitly classify that combined state as partial observability plus partial readiness only for the current thread, to say cross-thread activity does not satisfy validation for 9ce0c2a5-32ae-4250-9642-980d0407cede:control-plane, to say this iteration only changed allowed control-plane files, and to preserve a clear operator-facing no-run defer reason unless at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists for the touched path set.',
  'When the active repair signal is an openai/openrouter ECONNREFUSED, localhost connection refusal, or similar local endpoint reachability failure such as http://localhost:3101/v1/responses, classify it by default as blocked apps/api runtime/provider routing-probing drift rather than a control-plane-local regression unless a clear control-plane orchestration defect is visible in the candidate files. In control-plane scope, explicitly name the blocked subsystem as apps/api provider routing/probing, say retrying the same provider-method combination is unlikely to help immediately, and prefer one bounded observability, workflow-hardening, or explicit no-run defer-reason improvement. If the signal specifically comes from apps/api/logs/provider-unique-errors.jsonl for openai sendMessage against http://localhost:3101/v1/responses, explicitly say the direct fix is out of scope for the current control-plane thread because the localhost apps/api target is not serving, explicitly name the blocked subsystem as apps/api provider/runtime routing, explicitly name the blocked log path as apps/api/logs/provider-unique-errors.jsonl in the summary and in each edit reason, do not imply the underlying apps/api runtime issue was repaired from control-plane scope, and require the operator-facing no-run defer reason to restate that the active goal is a bounded control-plane workflow-hardening improvement for the current control-plane thread, state that only allowed control-plane files were changed in this iteration, and state that apps/api/logs/provider-unique-errors.jsonl plus the blocked subsystem apps/api provider/runtime routing remain out of scope and unrepaired here. Require that same defer reason to state that retrying the same openai sendMessage localhost combination is unlikely to help until the blocked localhost apps/api target is serving again, to explicitly classify pending-only same-thread LangSmith visibility for the current control-plane thread as partial observability only rather than completed validation, to explicitly classify graph registration, worker startup, or server-running logs followed by flushing, exit, or shutdown as partial readiness evidence only rather than completed validation, to explicitly say that build or typecheck success is compile-time validation only and does not satisfy runtime validation by itself, to explicitly say LangSmith prompt sync enabled without a returned URL and an unavailable live channel is prompt fallback drift risk only rather than rollout success, and to explicitly say pending or completed runs from sibling threads do not satisfy validation for the current control-plane thread and that cross-thread LangSmith activity does not satisfy validation for the current control-plane thread. Require that same defer reason to explicitly say that pending same-thread visibility plus startup log flush/exit together are only combined partial observability plus partial readiness, not a successful validation run, and to explicitly name the next success condition as at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted. When the current control-plane thread is 775c9662-2dc6-4cc9-938f-2e0a2e6b788a:control-plane, require that same defer reason to explicitly say cross-thread activity from sibling threads such as 775c9662-2dc6-4cc9-938f-2e0a2e6b788a:api-routing and 775c9662-2dc6-4cc9-938f-2e0a2e6b788a:api-runtime does not satisfy validation for 775c9662-2dc6-4cc9-938f-2e0a2e6b788a:control-plane, and that pending-only same-thread LangSmith visibility for 775c9662-2dc6-4cc9-938f-2e0a2e6b788a:control-plane is partial observability only rather than completed validation. b31cedc0-ceb5-48d7-8772-cf97f38a3b42:ui-surface do not satisfy validation for b31cedc0-ceb5-48d7-8772-cf97f38a3b42:control-plane, require that same defer reason to explicitly say pending or completed runs from sibling threads such as b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface, b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-platform, b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-runtime, and b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-data do not satisfy validation for b31cedc0-ceb5-48d7-8772-cf97f38a3b42:control-plane, require that same defer reason to explicitly say pending runs from other threads such as b31cedc0-ceb5-48d7-8772-cf97f38a3b42:workspace-surface, b31cedc0-ceb5-48d7-8772-cf97f38a3b42:ui-surface, b31cedc0-ceb5-48d7-8772-cf97f38a3b42:homepage-surface, b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-platform, or b31cedc0-ceb5-48d7-8772-cf97f38a3b42:api-platform do not satisfy validation for b31cedc0-ceb5-48d7-8772-cf97f38a3b42:control-plane, require that same defer reason to explicitly say the iteration only changed allowed control-plane files and did not repair localhost apps/api runtime availability, require that same defer reason to explicitly preserve a clear operator-facing no-run defer reason unless at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists for the touched path set, require that same defer reason to explicitly say pending same-thread visibility plus startup log flush/exit together are only partial observability plus partial readiness, not a successful validation run, and require that same defer reason to explicitly name the next success condition as at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted. evidence together are partial observability plus partial readiness only rather than completed validation, require that same defer reason to explicitly say that if no fresh same-thread LangSmith control-plane run/trace with explicit goal context was emitted for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, the iteration must preserve a clear operator-facing no-run defer reason instead of claiming validation success, require that same defer reason to explicitly say pending same-thread visibility plus startup logs that register graphs, start workers, or report server-running before flushing/exiting is combined partial observability plus partial readiness only rather than completed validation, require that same defer reason to explicitly say recent-run-health passing or older runs from other threads do not satisfy this iteration for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, and require that same defer reason to state the next validation success condition exactly as at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted. other threads do not satisfy this iteration for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, require that same defer reason to explicitly preserve the next validation success condition as at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted, require that same defer reason to explicitly say that pending-only same-thread LangSmith visibility without a completed fresh same-thread run/trace is partial observability only and still does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, require that same defer reason to explicitly state that production restart of anygpt.service remains blocked without separate explicit approval and that only observational or experimental-safe control-plane handling is allowed in this iteration, require that same defer reason to explicitly restate the active goal in plain language as a bounded control-plane workflow-hardening improvement for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane while apps/api/logs/provider-unique-errors.jsonl and the blocked subsystem apps/api provider/runtime routing remain out of scope and unrepaired here, require that same defer reason to explicitly mention the paired LangSmith feedback signal that contains_goal_context=0 and repair_smoke_passed=0 means this iteration must include explicit goal context and either a passed control-plane smoke/typecheck result plus a fresh same-thread LangSmith control-plane run/trace or a clear no-run defer reason, and require that same defer reason to explicitly state the next validation success condition: at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted. Also require that defer reason to explicitly say the active goal is a bounded control-plane workflow-hardening improvement for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, that only allowed control-plane files were changed in this iteration, that apps/api/logs/provider-unique-errors.jsonl and the blocked subsystem apps/api provider/runtime routing remain out of scope and unrepaired here, that the prompt rollback reference anygpt-control-plane-agent:3a61868f505b2f04af50aef0a0cb0de0f1179f3f786c705504257bff551802ae remains the immediate prompt-level rollback context, that startup logs showing graph registration, worker startup, or server-running followed by immediate flush, exit, or shutdown are partial readiness evidence only, and that pending-only or cross-thread LangSmith activity does not satisfy validation for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Also require the next validation success condition to be stated explicitly as at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched control-plane path set, or a clear operator-facing no-run defer reason if no run was emitted. Also require that defer reason to explicitly preserve the prompt rollback reference anygpt-control-plane-agent:3a61868f505b2f04af50aef0a0cb0de0f1179f3f786c705504257bff551802ae, to say only allowed control-plane files were changed in this iteration, and to say that apps/api/logs/provider-unique-errors.jsonl plus the blocked subsystem apps/api provider/runtime routing remain out of scope and unrepaired here. Also require the defer reason to explicitly say that recent LangSmith activity from other threads or pending-only runs does not satisfy validation for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, and that startup logs showing graph registration, worker startup, or server-running followed by immediate flush, exit, or shutdown are partial readiness evidence only rather than completed validation. Also require the bounded control-plane summary and each edit reason to explicitly mention that only allowed control-plane files were changed in this iteration, that apps/api/logs/provider-unique-errors.jsonl and apps/api provider/runtime routing remain out of scope and unrepaired here, that the prompt rollback reference anygpt-control-plane-agent:3a61868f505b2f04af50aef0a0cb0de0f1179f3f786c705504257bff551802ae remains the immediate prompt-level rollback context, and that a clear operator-facing no-run defer reason must be preserved unless there is at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Also require the defer reason to preserve the prompt rollback reference anygpt-control-plane-agent:3a61868f505b2f04af50aef0a0cb0de0f1179f3f786c705504257bff551802ae for immediate prompt-level rollback context, to explicitly say that only allowed control-plane files were changed in this iteration, to explicitly say that apps/api/logs/provider-unique-errors.jsonl and the blocked subsystem apps/api provider/runtime routing remain out of scope and were not repaired here, to restate the active goal in plain language as continuous safe control-plane monitoring and bounded improvement, and to explicitly classify startup logs that show graph registration, worker startup, or server-running followed by immediate flush, exit, or shutdown as partial readiness evidence only rather than completed validation. Also require that any bounded control-plane summary or edit reason explicitly says the iteration only changed allowed control-plane files and did not repair apps/api runtime availability, that pending-only or cross-thread LangSmith activity is partial observability only and does not satisfy validation for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, and that the no-run defer reason should mention both the blocked log path apps/api/logs/provider-unique-errors.jsonl and the blocked subsystem apps/api provider/runtime routing together, explicitly say cross-thread LangSmith activity does not satisfy thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, and explicitly require one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed smoke/typecheck result before validation can be treated as complete when no such same-thread evidence exists. Also require the bounded control-plane summary or decision reason to call any graph registration, worker startup, or server-running logs followed by flush/exit/shutdown partial readiness evidence only, and to call pending-only or cross-thread LangSmith activity partial observability only that does not satisfy thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. When LangSmith feedback for the current control-plane thread includes contains_goal_context=0 or repair_smoke_passed=0, require the summary and each edit reason to restate the active goal in plain language, explicitly say the iteration only made a bounded control-plane workflow-hardening or observability change in apps/langgraph-control-plane/src/workflow.ts unless a fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists, and preserve a clear operator-facing no-run defer reason whenever no such same-thread run was emitted. For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, require the summary and each edit reason to restate that the direct fix for apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses is blocked in the out-of-scope apps/api provider/runtime routing subsystem, that this iteration only changed allowed control-plane files, and that no fresh same-thread LangSmith control-plane run/trace plus passed smoke/typecheck result means the operator-facing no-run defer reason must explicitly name both apps/api/logs/provider-unique-errors.jsonl and apps/api provider/runtime routing together. Also require the summary and each edit reason to say cross-thread LangSmith activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane and that startup graph registration, worker startup, or server-running logs followed by flush, exit, or shutdown are partial readiness evidence only, not completed validation, unless a fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result also exists. For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, require the summary and each edit reason to restate that the direct fix for apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses is blocked in the out-of-scope apps/api provider/runtime routing subsystem, to explicitly say the iteration only changed allowed control-plane files and did not repair localhost apps/api runtime availability, to preserve a clear operator-facing no-run defer reason that names both apps/api/logs/provider-unique-errors.jsonl and apps/api provider/runtime routing together, and to state that retrying the same openai sendMessage localhost combination is unlikely to help until the blocked localhost apps/api target is serving again. Also require the summary and each edit reason to classify graph registration, worker startup, or server-running logs followed by flushing, exit, or shutdown as partial readiness evidence only, and to classify pending-only or cross-thread LangSmith activity as partial observability only that does not satisfy thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. The next validation success condition remains at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted. For thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, require the summary and each edit reason to restate that blocked apps/api subsystem, preserve a clear operator-facing no-run defer reason that explicitly names apps/api/logs/provider-unique-errors.jsonl and the blocked apps/api provider/runtime routing subsystem, explicitly say the iteration only made a bounded control-plane observability or workflow-hardening change in apps/langgraph-control-plane/src/workflow.ts unless a fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists, explicitly say zero fresh same-thread runs for this iteration is a monitoring gap rather than by itself a deploy or rollback trigger, and explicitly say retrying the same openai sendMessage localhost combination is unlikely to help until the blocked localhost apps/api target is serving again. If startup logs also show graph registration, worker startup, or server-running followed by an immediate flush, exit, or shutdown, classify that as partial readiness evidence only, not completed validation. If LangSmith visibility is pending-only, mostly from other threads, or lacks a fresh completed run for the current thread, classify that as partial observability only; cross-thread activity does not satisfy validation for the current control-plane thread. Require the summary and each edit reason to explicitly say when recent LangSmith activity is dominated by other threads, to explicitly say that pending or completed runs from sibling threads such as api-runtime, ui-surface, homepage-surface, api-data, api-platform, workspace-surface, or any other non-control-plane thread do not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, and to preserve the operator-facing no-run defer reason until at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result exists. Also require the summary and each edit reason to explicitly say that a same-thread run is still required for the current iteration even when governance, evaluation, or older smoke feedback is passing, because older or cross-thread evidence does not close the current no-run gap. When prompt sync is enabled but no sync URL is returned and the live channel is unavailable, classify that as prompt fallback drift risk only, not rollout success, and preserve the same no-run defer reason until same-thread validation exists.',
  'When the active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED for http://localhost:3101/v1/responses, explicitly name the blocked subsystem as apps/api provider/runtime routing, classify the direct fix as out of scope for the current control-plane thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, and say retrying the same openai sendMessage combination is unlikely to help until the localhost API target is serving again. In control-plane scope, prefer one small observability, workflow-hardening, or operator-facing defer-reason improvement in an allowed control-plane file instead of implying the apps/api issue was fixed. If startup logs show graph registration, worker startup, or server-running followed by flushing to persistent storage and exiting, classify that as partial readiness evidence only, not completed validation. If LangSmith visibility is pending-only or mostly from other threads, classify that as partial observability only; cross-thread activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Preserve a clear operator-facing no-run defer reason unless a fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result were emitted for this iteration.',
  'When the active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED for http://localhost:3101/v1/responses, explicitly name the blocked subsystem as apps/api provider/runtime routing, classify the direct fix as out of scope for the current control-plane thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, and say retrying the same openai sendMessage combination is unlikely to help until the localhost API target is serving again. In control-plane scope, prefer one small observability, workflow-hardening, or operator-facing defer-reason improvement in an allowed control-plane file instead of implying the apps/api issue was fixed. If startup logs show graph registration, worker startup, or server-running followed by flushing to persistent storage and exiting, classify that as partial readiness evidence only, not completed validation. If LangSmith visibility is pending-only or mostly from other threads, classify that as partial observability only; cross-thread activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane. Preserve a clear operator-facing no-run defer reason unless a fresh same-thread LangSmith control-plane run/trace with explicit goal context and a passed control-plane smoke/typecheck result were emitted for this iteration.',
  'When the active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED for http://localhost:3101/v1/responses, and the current control-plane thread is 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane, require the summary and each edit reason to explicitly say the direct fix is out of scope in the blocked apps/api provider/runtime routing subsystem, that retrying the same openai sendMessage combination is unlikely to help until the localhost API target is serving again, and that any control-plane-only change must preserve a clear operator-facing no-run defer reason unless a fresh same-thread LangSmith control-plane run/trace and passed control-plane smoke/typecheck result were emitted. The summary must also explicitly state whether the iteration ended with same-thread validation evidence or with a no-run defer reason. If startup logs show graph registration, worker startup, or server-running followed by flushing to persistent storage and exiting, classify that as partial readiness evidence only. If LangSmith visibility is pending-only or mostly from other threads, classify that as partial observability only; cross-thread activity does not satisfy validation for 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane.',
  'When prior history shows restartProductionService succeeded, do not treat that as approval to restart production again. In experimental-safe control-plane scope, production restart actions must be blocked or omitted unless separate explicit approval is present; only anygpt-experimental.service may be considered for restart if needed, and the summary should preserve a clear operator-facing defer reason when production restart is intentionally skipped.',
  'Even when governance is otherwise passing, prefer summaries and decision reasons that name the next validation success condition as at least one fresh control-plane LangSmith run, trace, or an operator-facing defer reason explaining why no run was emitted.',  'When control-plane signals include repeated key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded events for openai/openrouter while apps/api provider files are outside scope, classify them as upstream credential or provider-governance drift blocked in apps/api provider routing/probing. In that case prefer one small control-plane observability, cooldown, prioritization, or explicit defer-reason improvement, say repeating the same provider-method combination is unlikely to help immediately, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run or preserve a clear defer reason if no run was emitted.',
  'When repair or improvement signals are repeated key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or key_no_quota/quota exceeded events for the same provider family, classify them as upstream credential or provider-governance drift by default. In control-plane scope, prefer one small observability, prioritization, cooldown, or explicit defer-reason improvement and say speculative provider edits in apps/api provider routing are blocked outside scope unless a clear local control-plane guard is visible.',
  'When repair or improvement signals are dominated by repeated key_invalid, Unauthorized, invalid_api_key, 401 auth failures, or quota exceeded/provider payment exhaustion for the same provider family, classify them as upstream credential or provider-governance drift by default. In control-plane scope, prefer one small observability, prioritization, cooldown, or explicit no-op/defer-reason improvement that names the blocked apps/api provider subsystem and says repeating the same provider-method combination is unlikely to help until credentials or quota are fixed.',
  'When repair signals show non-free models in apps/api/models.json still using zero placeholder or missing pricing without matching coverage in apps/api/pricing.json or apps/api/dev/routermodels.json, treat that as a code-local pricing coverage gap. Prefer the smallest bounded fix in apps/api/pricing.json, apps/api/dev/fetchPricing.ts, or apps/api/modules/modelUpdater.ts that improves pricing-source coverage or resolution, and do not normalize unresolved pricing by silently leaving zero placeholders unless the source files clearly mark the model as intentionally free. Because this audit is driven by pricing coverage in apps/api/pricing.json or apps/api/dev/routermodels.json, a fetchPricing.ts-only change is usually insufficient; prefer a single-file apps/api/pricing.json update when possible, or a tightly coupled apps/api/pricing.json plus apps/api/dev/fetchPricing.ts pair only when generator logic must change too. If those apps/api paths are outside the current allowlist or locked scope, do not propose unreachable edits there; instead return a concise summary that the pricing coverage gap is blocked by scope/allowlist, name the blocked apps/api pricing files or subsystem in that summary, and, if possible within the current scope, make only a small control-plane note or prioritization improvement that preserves that decision reason.',
  'Treat apps/api/dev/checkModelCapabilities.ts as an audit helper, not a source-of-truth model/provider file. Do not edit it for provider/model sync churn, region-blocked capability removals, or pricing coverage gaps unless the active signal explicitly comes from that audit script or a missing-capability report.',
  'Treat provider-bound failures (for example upstream API incompatibility, unsupported endpoint or mode combinations such as streaming or multi-agent restrictions, unsupported tool-calling or tool_choice combinations reported by an upstream router or provider, invalid API keys, disabled upstream APIs or projects, quota or payment exhaustion, repeated invalid upstream response structures, repeated empty streaming responses for the same model or endpoint, repeated upstream OpenAI-compatible streaming server_error responses for the same model or endpoint, repeated provider catalog or list-model auth failures, repeated Gemini ListModels 400/401/403 failures indicating disabled APIs, forbidden projects, expired or invalid API keys, or missing upstream activation, memory-pressure queue rejections caused by high rss/external/runtime usage without a clear local leak in the candidate files, or non-retryable remote media fetch failures) as ambiguous for direct repair unless a clear local guard, fallback, validation, routing, provider-selection fix, failure-origin classification improvement, bounded candidate prioritization improvement, operator-facing recovery note, or bounded local load-shedding improvement is visible in the provided candidate files.',
  'When logs show request-queue memory-pressure rejections with high rss, external memory, or swap usage but low in-flight and pending counts, treat the active failure as runtime-capacity pressure by default rather than a clear queue-logic bug; prefer the smallest bounded edit that improves failure-origin labeling, operator-facing recovery notes, autonomous decision reasons, or conservative load-shedding guidance in candidate files over speculative concurrency increases or threshold loosening.',
  'When active repair signals are repeated MEMORY_PRESSURE 503s from requestQueue/requestIntake with high rss, heap, external, or swap usage and low queue occupancy, treat them as runtime-capacity signals by default; prefer edits that improve failure-origin labeling, operator-facing recovery notes, candidate prioritization, or bounded load-shedding heuristics over speculative concurrency increases or broad queue rewrites unless the candidate files show a clear local regression.',
  'When logs already mark providerSwitchWorthless or requestRetryWorthless for these failures, prefer a bounded heuristic, note-quality, observability, cooldown, provider de-prioritization, failure-origin labeling, or recovery-planning improvement over speculative provider implementation edits.',
  'When repeated Gemini catalog failures are the active signal, especially ListModels 400/401/403 responses about disabled APIs, forbidden projects, or expired/invalid keys, prefer edits that improve autonomous classification, decision reasons, candidate-path prioritization, repair summaries, or operator-facing notes in control-plane candidate files rather than direct provider code changes unless the candidate files show an obvious local validation or routing defect.',
  'When Gemini errors say a specific model does not support generateContent, sendMessage, or another upstream method/endpoint combination, treat that as provider/model incompatibility by default. If the failing Gemini provider implementation lives outside the current allowlist or locked scope (for example apps/api provider files), do not propose unreachable provider edits; instead prefer one bounded control-plane observability, prioritization, or explicit defer-reason improvement that names the blocked apps/api subsystem and marks the issue as upstream/provider-bound unless a clear local control-plane guard is visible.',
  'When Gemini probe or provider errors report unsupported input mime types such as audio/s16le, function calling not enabled for the model, or generateContent unsupported for a specific model, classify the issue as upstream/provider-bound capability mismatch by default. In control-plane scope, prefer one small workflow, summary, or observability improvement that explicitly names the blocked apps/api Gemini provider subsystem and says retrying the same provider/method combination is unlikely to help.',
  'When repeated Gemini capability-mismatch signals mention generateContent unsupported, unsupported input mime types, or function calling not enabled, explicitly mark the issue as blocked in the apps/api Gemini provider subsystem, say the failure is upstream/provider-bound rather than a control-plane regression, and prefer a single bounded control-plane observability, prioritization, or defer-reason improvement over speculative provider repair outside scope.',
  'When active repair signals specifically show Gemini generateContent incompatibility for a named model or unsupported audio/function-calling input on the same provider family, treat that as an upstream/provider-bound Gemini method-capability mismatch. If apps/api Gemini provider files are outside scope, require the summary or decision reason to say the blocked subsystem is apps/api Gemini provider routing/capability handling and that repeating the same Gemini provider-method combination is unlikely to succeed.',
  'When active signals combine Gemini method incompatibility such as generateContent unsupported with probe failures like unsupported audio mime type or function calling not enabled, summarize them as one upstream/provider-bound Gemini capability mismatch family, explicitly name the blocked apps/api Gemini provider routing/capability subsystem, and say retrying the same Gemini provider-method combination is unlikely to help.',
  'When active signals combine Gemini generateContent unsupported, unsupported audio mime types such as audio/s16le, or function calling not enabled for the same provider family, summarize them as one upstream/provider-bound Gemini capability mismatch family, explicitly name the blocked subsystem as apps/api Gemini provider routing/capability handling, and prefer a bounded control-plane observability or defer-reason improvement because retrying the same Gemini provider-method combination is unlikely to help.',
  'When active signals combine Gemini generateContent unsupported with unsupported audio mime type or function-calling-disabled probe failures, summarize them as one upstream/provider-bound Gemini capability mismatch family, explicitly name the blocked subsystem as apps/api Gemini provider routing/capability handling, and prefer one bounded control-plane observability or workflow-hardening change over retrying the same Gemini provider-method combination.',
  'When active signals combine Gemini method incompatibility (for example model does not support generateContent) with capability-specific probe failures (for example unsupported audio mime type or function calling not enabled), explicitly summarize them as the same upstream/provider-bound Gemini capability mismatch family, mention the blocked apps/api Gemini provider subsystem, and bias the next step toward a no-op defer reason or a single control-plane observability/workflow-hardening change instead of speculative provider switching or repeated repair planning.',
  'When Gemini signals pair provider_cap_blocked or provider_model_removed events for image_output with country or provider-region availability reasons and probe_fail outcomes such as unsupported audio/s16le input or function calling not enabled for the same model family, summarize them as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family, explicitly name the blocked subsystem as apps/api Gemini provider routing/capability handling, and say retrying the same Gemini provider-method combination is unlikely to succeed.',
  'When active signals pair provider_cap_blocked or provider_model_removed events for Gemini image_output with region or country availability reasons and Gemini probe_fail messages such as unsupported audio/s16le input, function calling not enabled, or generateContent unsupported for the same model family, summarize them as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family, explicitly name the blocked subsystem as apps/api Gemini provider routing/capability handling, and say retrying the same Gemini provider-method combination is unlikely to succeed.',
  'When repeated Gemini probe_retry or probe_skip signals are dominated by rate limit/timeout switching for the same model or capability test, classify them as upstream/provider-bound retry churn by default. In control-plane scope, explicitly name the blocked subsystem as apps/api Gemini provider routing/capability handling, say repeating the same Gemini provider-method combination is unlikely to help immediately, and prefer one bounded observability, defer-reason, or prioritization improvement over speculative provider edits outside scope.',
  'When Gemini signals specifically pair generateContent unsupported for one model with unsupported audio mime types such as audio/s16le or function calling not enabled for another Gemini model family in the same repair window, require the summary or decision reason to say this is one upstream/provider-bound Gemini capability mismatch family blocked in apps/api Gemini provider routing/capability handling and that repeating the same Gemini provider-method combination is unlikely to succeed.',
  'When Gemini signals specifically mention generateContent unsupported for a named model together with unsupported audio mime types such as audio/s16le or function calling not enabled, require the summary or decision reason to say the blocked subsystem is apps/api Gemini provider routing/capability handling and that repeating the same Gemini provider-method combination is unlikely to succeed; in control-plane scope, prefer one small observability, prioritization, or defer-reason improvement over unreachable provider edits.',
  'When the stated goal concerns failed jobs, runner failure propagation, or terminal status accuracy, prioritize small control-plane fixes that ensure failed repair/build/deploy/job outcomes are surfaced as runner failure, persisted in status fields, and reflected in summaries before attempting unrelated provider changes.',  'When logs show many skipped providers, repeated upstream-only failures, repeated catalog or auth failures for the same provider family, or unsupported endpoint or mode combinations for a specific model, bias toward improving heuristics, operator visibility, and autonomous recovery notes rather than attempting speculative provider implementation edits.',
  'When active signals are repeated probe_retry entries whose reason is rate limit/timeout: switching provider, treat them as upstream/provider-bound retry churn by default rather than a clear control-plane regression; in control-plane scope, prefer one small observability, prioritization, cooldown, or defer-reason improvement and say repeating the same provider-method combination may not help unless a local orchestration guard is visible in the candidate files.',
  'When repeated probe_retry rate limit/timeout switching dominates and the failing provider implementation is outside scope, explicitly name the blocked subsystem as apps/api provider routing/probing, record the issue as upstream/provider-bound retry churn, and say repeating the same provider-method combination is unlikely to help immediately unless a clear local control-plane orchestration guard is visible in the candidate files.',
  'When repeated OpenRouter probe_fail signals say "No allowed providers are available for the selected model" with status 404 for the same capability test, classify them as upstream/provider-bound availability or governance drift blocked in apps/api provider routing/probing by default. In control-plane scope, prefer one small observability, prioritization, or explicit defer-reason improvement, say repeating the same provider-method combination is unlikely to help immediately, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When repeated OpenRouter probe_fail signals say "No allowed providers are available for the selected model" with status 404 across multiple models or capability tests in the same repair window, summarize them as one upstream/provider-bound OpenRouter availability/governance drift family blocked in apps/api provider routing/probing, state that retrying the same OpenRouter provider-method combination is unlikely to help immediately, and prefer one bounded control-plane observability, workflow-hardening, or explicit defer-reason improvement whose success condition is to surface at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When tool_calling probe_fail signals combine OpenRouter 404 "No allowed providers are available for the selected model" with xAI multi-agent errors such as "Client-side tools for multi-agent models require beta access", treat them as one upstream/provider-bound tool-calling availability/governance mismatch family blocked in apps/api provider routing/probing. In control-plane scope, say retrying the same provider-method combination is unlikely to help immediately, prefer one small observability, workflow-hardening, prioritization, or explicit defer-reason improvement over speculative provider edits outside scope, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When provider/model sync churn is active at the same time as repeated probe_retry rate limit/timeout switching, summarize the situation as monitoring-only upstream/provider pressure plus catalog churn, and prefer a bounded control-plane workflow-hardening or note-quality improvement over speculative provider or model-file edits outside scope.',  'When provider_cap_blocked or provider_model_removed events cluster around image_output or region/country availability, explicitly say the failure is upstream/provider-bound regional catalog drift, mention that provider switching is unlikely to help for the same blocked capability family, and prefer a bounded control-plane note, prioritization tweak, or no-op defer reason over proposing provider/model file churn outside scope.',
  'When provider_cap_blocked or provider_model_removed events cite country, region, or provider-region availability limits, explicitly mention that governance or geography constraint in the summary/decision reason and prefer a bounded control-plane observability or prioritization improvement over retrying the same provider-sync idea.',
  'When active signals combine Gemini provider_cap_blocked or provider_model_removed events for image_output with probe_fail capability errors such as unsupported audio mime types like audio/s16le, function calling not enabled, or generateContent unsupported, summarize them as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family, explicitly name the blocked subsystem as apps/api Gemini provider routing/capability handling, and say retrying the same Gemini provider-method combination is unlikely to succeed.',
  'When active signals combine Gemini image_output provider_cap_blocked/provider_model_removed region or country availability failures with lyria-3-pro-preview probe_fail outcomes like unsupported audio/s16le input or function calling not enabled, treat that as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family blocked in apps/api Gemini provider routing/capability handling; prefer one bounded control-plane observability or explicit defer-reason improvement and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason.',
  'When active signals combine Gemini image_output provider_cap_blocked or provider_model_removed region/country availability failures with probe_fail capability errors such as unsupported audio/s16le input, function calling not enabled, or generateContent unsupported for the same model family, summarize them as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family, explicitly name the blocked subsystem as apps/api Gemini provider routing/capability handling, say retrying the same Gemini provider-method combination is unlikely to succeed, and preserve the next validation success condition as at least one fresh LangSmith control-plane run/trace or a clear operator-facing no-run defer reason.',
  'When active repair signals specifically pair Gemini image_output blocked-in-country or blocked-in-provider-region events for lyria-3-pro-preview with probe_fail errors such as unsupported audio/s16le input or function calling not enabled, classify them as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family, explicitly say the blocked subsystem is apps/api Gemini provider routing/capability handling, state that repeating the same Gemini provider-method combination is unlikely to help immediately, and preserve the next validation success condition as at least one fresh LangSmith control-plane run/trace or a clear no-run defer reason if no run was emitted.',
  'When Gemini signals combine provider_cap_blocked or provider_model_removed region/country limits with probe_fail capability errors such as generateContent unsupported, unsupported audio mime types like audio/s16le, or function calling not enabled, summarize them as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family, explicitly name the blocked subsystem as apps/api Gemini provider routing/capability handling, and say retrying the same Gemini provider-method combination is unlikely to succeed.',
  'When recent logs show Gemini provider_cap_blocked or provider_model_removed for image_output because generation is unavailable in a country or provider region together with probe_fail errors for the same model family such as unsupported audio/s16le input, function calling not enabled, or generateContent unsupported, treat that cluster as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family blocked in apps/api Gemini provider routing/capability handling; in control-plane scope, prefer a single observability, prioritization, or explicit defer-reason improvement and state that repeating the same Gemini provider-method combination is unlikely to help immediately. The next smoke/validation step should confirm at least one fresh LangSmith control-plane run/trace or preserve a clear defer reason if no run was emitted.',
  'When active repair signals specifically pair Gemini image_output blocked-in-country or blocked-in-provider-region events for lyria-3-pro-preview with probe_fail errors such as unsupported audio/s16le input or function calling not enabled, classify them as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family, explicitly say the blocked subsystem is apps/api Gemini provider routing/capability handling, and prefer one bounded control-plane observability, prioritization, or defer-reason improvement because repeating the same Gemini provider-method combination is unlikely to help.',
  'When recent logs show Gemini provider_cap_blocked or provider_model_removed for image_output because generation is unavailable in a country or provider region together with probe_fail errors for the same model family such as unsupported audio/s16le input, function calling not enabled, or generateContent unsupported, treat that cluster as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family blocked in apps/api Gemini provider routing/capability handling; in control-plane scope, prefer a single observability, prioritization, or explicit defer-reason improvement, state that repeating the same Gemini provider-method combination is unlikely to help immediately, and preserve the next validation success condition as at least one fresh LangSmith control-plane run/trace or a clear no-run defer reason.',
  'When active repair signals specifically pair Gemini image_output region/country blocking or provider_model_removed events with lyria-3-pro-preview probe failures such as unsupported audio/s16le input or function calling not enabled, require the summary or decision reason to classify them as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family blocked in apps/api Gemini provider routing/capability handling, and state that repeating the same Gemini provider-method combination is unlikely to help immediately.',
  'When active repair signals specifically pair Gemini image_output provider_cap_blocked/provider_model_removed region or country availability failures with lyria-3-pro-preview probe_fail outcomes like unsupported audio/s16le input or function calling not enabled, treat that as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family blocked in apps/api Gemini provider routing/capability handling; prefer one bounded control-plane observability or defer-reason improvement and state that repeating the same Gemini provider-method combination is unlikely to help immediately.',
  'When Gemini signals specifically pair image generation unavailable in country or provider region with unsupported audio mime types such as audio/s16le, treat them as the same upstream/provider-bound Gemini capability mismatch and regional catalog drift family blocked in apps/api Gemini provider routing/capability handling; in control-plane scope, prefer one bounded observability, prioritization, or defer-reason improvement and state that retrying the same Gemini provider-method combination is unlikely to help.',
  'When recent logs show Gemini provider_cap_blocked or provider_model_removed for image_output because generation is unavailable in a country or provider region together with probe_fail errors for the same model family such as unsupported audio/s16le input, function calling not enabled, or generateContent unsupported, treat that cluster as one upstream/provider-bound Gemini capability mismatch and regional catalog drift family blocked in apps/api Gemini provider routing/capability handling; in control-plane scope, prefer a single observability, prioritization, or explicit defer-reason improvement, state that repeating the same Gemini provider-method combination is unlikely to help immediately, and require the next smoke/validation step to confirm at least one fresh LangSmith control-plane run/trace or preserve a clear no-run defer reason if no run was emitted.',
  'When the active repair signal is apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED for http://localhost:3101/v1/responses, explicitly name the blocked subsystem as apps/api provider/runtime routing, classify the direct fix as out of scope for the current control-plane thread, and say retrying the same openai sendMessage combination is unlikely to help until the localhost API target is serving again. In control-plane scope, prefer one bounded observability, workflow-hardening, or operator-facing defer-reason improvement instead of implying the apps/api issue was fixed. Require the summary and each edit reason to restate the active goal in plain language, name the current control-plane thread when available, name the exact touched control-plane file or subsystem, and preserve a clear operator-facing no-run defer reason whenever no fresh same-thread LangSmith control-plane run/trace and passed control-plane smoke/typecheck result were emitted for this iteration. If startup logs show graph registration, worker startup, or server-running evidence followed by immediate flush, exit, or shutdown, classify that as partial readiness evidence only, not completed validation. If LangSmith visibility is pending-only or mostly from other threads, classify that as partial observability only; cross-thread activity does not satisfy validation for the current control-plane thread. If pending same-thread LangSmith visibility appears together with graph registration, worker startup, or server-running evidence that immediately flushes, exits, or shuts down, require the summary and each edit reason to explicitly classify the state as combined partial observability plus partial readiness only and to preserve the operator-facing no-run defer reason instead of claiming successful validation. For thread 5d4f7de9-8e85-4e2a-b093-f2f0efdb5698:control-plane, when same-thread LangSmith visibility is pending-only and recent completed activity is dominated by sibling threads such as 5d4f7de9-8e85-4e2a-b093-f2f0efdb5698:api-runtime, 5d4f7de9-8e85-4e2a-b093-f2f0efdb5698:api-routing, or 5d4f7de9-8e85-4e2a-b093-f2f0efdb5698:api-platform, require the summary and each edit reason to explicitly say that cross-thread activity does not satisfy validation for 5d4f7de9-8e85-4e2a-b093-f2f0efdb5698:control-plane and that pending-only same-thread visibility does not satisfy validation by itself. Also require the summary and each edit reason to explicitly say the iteration only changed allowed control-plane files and did not repair apps/api/logs/provider-unique-errors.jsonl or the blocked apps/api provider/runtime routing subsystem, and to preserve the prompt rollback reference anygpt-control-plane-agent:9b55d07cef61f12452da788d0377fe6ab2b72fd1ce118963f4c238ce14dde449 as immediate prompt-level rollback context when no fresh same-thread validation exists. The next validation success condition remains at least one fresh same-thread LangSmith control-plane run/trace with explicit goal context plus a passed control-plane smoke/typecheck result for the touched path set, or a clear operator-facing no-run defer reason if no run was emitted.',].join(' ');

const DEFAULT_CONTROL_PLANE_PROMPT_BUNDLE = ControlPlanePromptBundleSchema.parse({
  planner: 'You are the planner agent for the AnyGPT LangGraph control plane. Produce concise, actionable planning notes based on logs, MCP findings, and requested scopes. Focus on priorities, risks, and safe next steps.',
  build: 'You are the build agent for the AnyGPT LangGraph control plane. Review the planned build jobs and provide concise notes about build order, likely breakpoints, and preflight checks. Do not invent new shell commands.',
  quality: 'You are the quality agent for the AnyGPT LangGraph control plane. Review the requested test jobs and provide concise notes about the highest-value validations, likely regressions, and smoke checks.',
  deploy: 'You are the deploy agent for the AnyGPT LangGraph control plane. Review the deploy intent and provide concise notes about rollout risk, approval considerations, and rollback readiness. Keep the deployment experimental-safe.',
  autonomousEdit: `${DEFAULT_CONTROL_PLANE_AUTONOMOUS_EDIT_PROMPT}

Provider-bound repair heuristics: treat repeated upstream incompatibility, auth/governance drift, quota/payment exhaustion, invalid API keys, disabled upstream APIs/projects, repeated empty streaming responses for the same provider/model/endpoint, repeated OpenRouter-style tool-use or tool_choice 404 probe failures, and repeated Gemini ListModels 400/401/403 failures as ambiguous for direct provider repair unless the candidate files clearly expose a small local guard, capability filter, routing exclusion, validation, or fallback improvement. Repeated OpenAI-compatible empty streaming responses such as "returned an empty streaming response" for the same model/endpoint and repeated Gemini ListModels 400/401/403 messages indicating an invalid API key, that the Generative Language API has not been used in a project before, is disabled, or requires upstream activation should be classified as upstream/provider-bound by default. When those signals dominate, prefer the smallest bounded control-plane improvement that sharpens failure-origin labeling, autonomous decision reasons, candidate-path prioritization, provider de-prioritization notes, cooldown/retry-worthlessness guidance, or operator-facing recovery notes over speculative provider implementation changes.`,
});

type ControlPlanePromptSelectionSource = z.infer<typeof ControlPlanePromptSelectionSourceSchema>;

function buildControlPlaneLangSmithProjectMetadata(
  promptIdentifier: string,
  promptSyncChannel: string,
  evaluationGatePolicy: ControlPlaneEvaluationGatePolicy,
  experimentalApiBaseUrl: string,
  experimentalServiceName: string,
  governanceProfile: string,
): Record<string, unknown> {
  return {
    source: 'anygpt-langgraph-control-plane',
    managed_by: 'anygpt-control-plane',
    automation_scope: 'bounded-workspace-project-admin',
    governance_scope: 'workspace-project-admin',
    governance_profile: governanceProfile,
    prompt_identifier: promptIdentifier,
    prompt_sync_channel: promptSyncChannel,
    evaluation_gate_mode: evaluationGatePolicy.mode,
    evaluation_gate_target: evaluationGatePolicy.target,
    experimental_api_base_url: experimentalApiBaseUrl,
    experimental_service_name: experimentalServiceName,
  };
}

type ControlPlaneGovernanceProfile = {
  name: string;
  queueBacklogWarnThreshold: number;
  requireFeedback: boolean;
  minimumFeedbackCount: number;
  minimumEvaluationResults: number;
  minimumSuccessfulEvaluations: number;
  blockAutonomousOnWarn: boolean;
  gateTarget: z.infer<typeof EvaluationGateTargetSchema>;
  requirePromptCommit: boolean;
};

function resolveControlPlaneGovernanceProfile(repoRoot: string): ControlPlaneGovernanceProfile {
  const selectedName = String(process.env.CONTROL_PLANE_GOVERNANCE_PROFILE || 'experimental').trim() || 'experimental';
  const defaults: Record<string, Omit<ControlPlaneGovernanceProfile, 'name'>> = {
    experimental: {
      queueBacklogWarnThreshold: 10,
      requireFeedback: false,
      blockAutonomousOnWarn: false,
      minimumFeedbackCount: 0,
      minimumEvaluationResults: 0,
      minimumSuccessfulEvaluations: 0,
      gateTarget: 'autonomous-edits',
      requirePromptCommit: false,
    },
    staging: {
      queueBacklogWarnThreshold: 5,
      requireFeedback: true,
      blockAutonomousOnWarn: false,
      minimumFeedbackCount: 1,
      minimumEvaluationResults: 1,
      minimumSuccessfulEvaluations: 1,
      gateTarget: 'autonomous-edits',
      requirePromptCommit: true,
    },
    prod: {
      queueBacklogWarnThreshold: 3,
      requireFeedback: true,
      blockAutonomousOnWarn: true,
      minimumFeedbackCount: 3,
      minimumEvaluationResults: 3,
      minimumSuccessfulEvaluations: 1,
      gateTarget: 'both',
      requirePromptCommit: true,
    },
  };

  let configuredProfiles: Record<string, Partial<Omit<ControlPlaneGovernanceProfile, 'name'>>> = {};
  try {
    const raw = fs.readFileSync(path.resolve(repoRoot, CONTROL_PLANE_GOVERNANCE_PROFILE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      configuredProfiles = parsed as Record<string, Partial<Omit<ControlPlaneGovernanceProfile, 'name'>>>;
    }
  } catch {
    configuredProfiles = {};
  }

  const baseline = defaults[selectedName] || defaults.experimental;
  const override = configuredProfiles[selectedName] || {};
  const requireFeedback = override.requireFeedback === true
    ? true
    : override.requireFeedback === false
      ? false
      : baseline.requireFeedback;
  let minimumFeedbackCount = Math.max(0, Math.floor(Number(override.minimumFeedbackCount ?? baseline.minimumFeedbackCount) || 0));
  if (requireFeedback && minimumFeedbackCount < 1) {
    minimumFeedbackCount = 1;
  }
  const rawGateTarget = String(override.gateTarget ?? baseline.gateTarget).trim();
  return {
    name: selectedName,
    queueBacklogWarnThreshold: Math.max(1, Math.floor(Number(override.queueBacklogWarnThreshold ?? baseline.queueBacklogWarnThreshold) || baseline.queueBacklogWarnThreshold)),
    requireFeedback,
    minimumFeedbackCount,
    minimumEvaluationResults: Math.max(0, Math.floor(Number(override.minimumEvaluationResults ?? baseline.minimumEvaluationResults) || 0)),
    minimumSuccessfulEvaluations: Math.max(0, Math.floor(Number(override.minimumSuccessfulEvaluations ?? baseline.minimumSuccessfulEvaluations) || 0)),
    blockAutonomousOnWarn: override.blockAutonomousOnWarn === true ? true : baseline.blockAutonomousOnWarn,
    gateTarget: rawGateTarget === 'execution' || rawGateTarget === 'both' ? rawGateTarget : 'autonomous-edits',
    requirePromptCommit: override.requirePromptCommit === true ? true : baseline.requirePromptCommit,
  };
}

export const LogInsightSchema = z.object({
  file: z.string(),
  lines: z.array(z.string()).default([]),
});

export const SemanticMemoryNoteSchema = z.object({
  key: z.string(),
  category: z.string(),
  memory: z.string(),
  signalSignature: z.string().default(''),
  failureClass: z.string().default(''),
  resolution: z.string().default(''),
  source: z.string().default(''),
});

export const AutonomousOperationModeSchema = z.enum(['idle', 'repair', 'improvement']);
export const RepairStatusSchema = z.enum(['idle', 'not-needed', 'planned', 'promoted', 'rolled-back', 'failed']);
export const PostRepairValidationStatusSchema = z.enum(['not-needed', 'planned', 'passed', 'failed']);
export const ExperimentalRestartStatusSchema = z.enum(['not-needed', 'pending', 'success', 'failed', 'skipped']);
export const ProductionRestartStatusSchema = z.enum(['not-needed', 'pending', 'success', 'failed', 'skipped']);
export const ScopeExpansionModeSchema = z.enum(['adaptive', 'locked']);
export const HealthClassSchema = z.enum(['healthy', 'degraded', 'waiting_evidence', 'blocked_external', 'failed']);
export const EvidenceStatusSchema = z.enum(['unknown', 'not-required', 'planned', 'collected', 'validated', 'missing']);
export const AiFailureClassSchema = z.enum(['none', 'timeout', 'backpressure', 'malformed-output', 'backend-error']);

export const ControlPlaneStateSchema = z.object({
  repoRoot: z.string(),
  goal: z.string(),
  scopes: z.array(z.string()).default(['repo']),
  effectiveScopes: z.array(z.string()).default([]),
  scopeExpansionReason: z.string().default(''),
  scopeExpansionMode: ScopeExpansionModeSchema.default('adaptive'),
  threadId: z.string().default(''),
  continuous: z.boolean().default(false),
  autonomous: z.boolean().default(false),
  governanceProfile: z.string().default('experimental'),
  experimentalApiBaseUrl: z.string().default(
    String(
      process.env.CONTROL_PLANE_ANYGPT_API_BASE_URL
      || process.env.ANYGPT_API_BASE_URL
      || process.env.OPENAI_BASE_URL
      || 'http://127.0.0.1:3310',
    ).trim() || 'http://127.0.0.1:3310',
  ),
  experimentalServiceName: z.string().default('anygpt-experimental.service'),
  productionServiceName: z.string().default('anygpt.service'),
  approvalMode: z.enum(['manual', 'auto']).default('manual'),
  approvalGranted: z.boolean().nullable().default(null),
  approvalMessage: z.string().default(''),
  pendingApprovals: z.array(ApprovalRequestSchema).default([]),
  aiAgentEnabled: z.boolean().default(false),
  aiAgentBackend: z.string().default(''),
  aiAgentModel: z.string().default(''),
  promptIdentifier: z.string().default(DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER),
  promptRef: z.string().default(''),
  promptChannel: z.string().default(DEFAULT_CONTROL_PLANE_PROMPT_CHANNEL),
  promptSyncEnabled: z.boolean().default(true),
  promptSyncChannel: z.string().default(DEFAULT_CONTROL_PLANE_PROMPT_SYNC_CHANNEL),
  promptPromoteChannel: z.string().default(''),
  controlPlanePrompts: ControlPlanePromptBundleSchema.default(DEFAULT_CONTROL_PLANE_PROMPT_BUNDLE),
  selectedPromptReference: z.string().default(''),
  selectedPromptSource: ControlPlanePromptSelectionSourceSchema.default('local'),
  selectedPromptChannel: z.string().default(''),
  selectedPromptCommitHash: z.string().default(''),
  selectedPromptMetadata: z.record(z.unknown()).default({}),
  selectedPromptAvailableChannels: z.array(z.string()).default([]),
  promptRollbackReference: z.string().default(''),
  promptSyncUrl: z.string().default(''),
  promptPromotionUrl: z.string().default(''),
  promptPromotionReason: z.string().default(''),
  promptPromotionBlockedReason: z.string().default(''),
  promptSelectionNotes: z.array(z.string()).default([]),
  plannerAgentInsights: z.array(z.string()).default([]),
  buildAgentInsights: z.array(z.string()).default([]),
  qualityAgentInsights: z.array(z.string()).default([]),
  deployAgentInsights: z.array(z.string()).default([]),
  langSmithEnabled: z.boolean().default(false),
  langSmithProjectName: z.string().default(''),
  langSmithWorkspace: LangSmithWorkspaceSummarySchema.nullable().default(null),
  langSmithAccessibleWorkspaces: z.array(LangSmithWorkspaceSummarySchema).default([]),
  langSmithProject: LangSmithProjectSummarySchema.nullable().default(null),
  langSmithProjects: z.array(LangSmithProjectSummarySchema).default([]),
  langSmithRuns: z.array(LangSmithRunSummarySchema).default([]),
  langSmithDatasets: z.array(LangSmithDatasetSummarySchema).default([]),
  langSmithPrompts: z.array(LangSmithPromptSummarySchema).default([]),
  langSmithAnnotationQueues: z.array(LangSmithAnnotationQueueSummarySchema).default([]),
  langSmithAnnotationQueueItems: z.array(LangSmithAnnotationQueueItemSummarySchema).default([]),
  langSmithFeedback: z.array(LangSmithFeedbackSummarySchema).default([]),
  langSmithEvaluations: z.array(LangSmithEvaluationSummarySchema).default([]),
  langSmithGovernance: LangSmithGovernanceSummarySchema.nullable().default(null),
  governanceGateResult: GovernanceGateResultSchema.default(DEFAULT_GOVERNANCE_GATE_RESULT),
  langSmithNotes: z.array(z.string()).default([]),
  observabilityTags: z.array(z.string()).default([]),
  observabilityMetadata: z.record(z.unknown()).default({}),
  evaluationGatePolicy: EvaluationGatePolicySchema.default(DEFAULT_EVALUATION_GATE_POLICY),
  evaluationGateResult: EvaluationGateResultSchema.default(buildDefaultEvaluationGateResult(DEFAULT_EVALUATION_GATE_POLICY)),
  autonomousEditEnabled: z.boolean().default(false),
  editAllowlist: z.array(z.string()).default([]),
  editDenylist: z.array(z.string()).default([]),
  maxEditActions: z.number().int().default(3),
  proposedEdits: z.array(AutonomousEditActionSchema).default([]),
  appliedEdits: z.array(AppliedAutonomousEditSchema).default([]),
  autonomousEditNotes: z.array(z.string()).default([]),
  recentAutonomousLearningNotes: z.array(z.string()).default([]),
  semanticMemoryNotes: z.array(SemanticMemoryNoteSchema).default([]),
  autonomousEditReviewDecision: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  autonomousEditReviewReason: z.string().default(''),
  autonomousPlannerAgentCount: z.number().int().nonnegative().default(0),
  autonomousPlannerFocuses: z.array(z.string()).default([]),
  autonomousPlannerStrategy: z.string().default(''),
  autonomousOperationMode: AutonomousOperationModeSchema.default('idle'),
  repairIntentSummary: z.string().default(''),
  repairSignals: z.array(z.string()).default([]),
  improvementIntentSummary: z.string().default(''),
  improvementSignals: z.array(z.string()).default([]),
  autonomousContractSummary: z.string().default(''),
  autonomousContractChecks: z.array(z.string()).default([]),
  autonomousContractPaths: z.array(z.string()).default([]),
  repairStatus: RepairStatusSchema.default('idle'),
  healthClass: HealthClassSchema.default('healthy'),
  deferReason: z.string().default(''),
  evidenceStatus: EvidenceStatusSchema.default('unknown'),
  lastAiFailureClass: AiFailureClassSchema.default('none'),
  validationRequired: z.boolean().default(false),
  repairDecisionReason: z.string().default(''),
  recentRepairValidationFailureCount: z.number().int().nonnegative().default(0),
  repairSmokeJobs: z.array(PlannedJobSchema).default([]),
  repairSmokeResults: z.array(ExecutedJobSchema).default([]),
  postRepairValidationJobs: z.array(PlannedJobSchema).default([]),
  postRepairValidationResults: z.array(ExecutedJobSchema).default([]),
  postRepairValidationStatus: PostRepairValidationStatusSchema.default('not-needed'),
  repairPromotedPaths: z.array(z.string()).default([]),
  repairRollbackPaths: z.array(z.string()).default([]),
  experimentalRestartStatus: ExperimentalRestartStatusSchema.default('not-needed'),
  experimentalRestartReason: z.string().default(''),
  productionRestartStatus: ProductionRestartStatusSchema.default('not-needed'),
  productionRestartReason: z.string().default(''),
  repairNotes: z.array(z.string()).default([]),
  repairSessionManifest: AutonomousEditSessionManifestSchema.nullable().default(null),
  executePlan: z.boolean().default(false),
  allowDeploy: z.boolean().default(false),
  deployCommand: z.string().default(''),
  mcpConfigPath: z.string().default(''),
  mcpServers: z.array(McpServerSchema).default([]),
  mcpInspections: z.array(McpInspectionSchema).default([]),
  mcpActionEnabled: z.boolean().default(parseBooleanEnv('CONTROL_PLANE_MCP_ACTIONS', false)),
  maxMcpActions: z.number().int().min(0).default(parsePositiveIntegerEnv('CONTROL_PLANE_MAX_MCP_ACTIONS', 4, 1)),
  mcpTargetUrls: z.array(z.string()).default([]),
  plannedMcpActions: z.array(McpPlannedActionSchema).default([]),
  executedMcpActions: z.array(McpExecutedActionSchema).default([]),
  mcpActionNotes: z.array(z.string()).default([]),
  logInsights: z.array(LogInsightSchema).default([]),
  plannerNotes: z.array(z.string()).default([]),
  buildJobs: z.array(PlannedJobSchema).default([]),
  testJobs: z.array(PlannedJobSchema).default([]),
  deployJobs: z.array(PlannedJobSchema).default([]),
  jobs: z.array(PlannedJobSchema).default([]),
  executedJobs: z.array(ExecutedJobSchema).default([]),
  summary: z.string().default(''),
});

export type PlannedJob = z.infer<typeof PlannedJobSchema>;
export type ExecutedJob = z.infer<typeof ExecutedJobSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type McpTool = z.infer<typeof McpToolSchema>;
export type McpInspection = z.infer<typeof McpInspectionSchema>;
export type McpPlannedAction = z.infer<typeof McpPlannedActionSchema>;
export type McpExecutedAction = z.infer<typeof McpExecutedActionSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type AiNodeAdvice = z.infer<typeof AiNodeAdviceSchema>;
export type LogInsight = z.infer<typeof LogInsightSchema>;
export type ControlPlaneState = z.infer<typeof ControlPlaneStateSchema>;
export type AutonomousEditAction = z.infer<typeof AutonomousEditActionSchema>;
export type AppliedAutonomousEdit = z.infer<typeof AppliedAutonomousEditSchema>;
export type ControlPlanePromptBundle = z.infer<typeof ControlPlanePromptBundleSchema>;
export type AutonomousOperationMode = z.infer<typeof AutonomousOperationModeSchema>;
export type RepairStatus = z.infer<typeof RepairStatusSchema>;
export type PostRepairValidationStatus = z.infer<typeof PostRepairValidationStatusSchema>;
export type ExperimentalRestartStatus = z.infer<typeof ExperimentalRestartStatusSchema>;
export type ScopeExpansionMode = z.infer<typeof ScopeExpansionModeSchema>;
export type HealthClass = z.infer<typeof HealthClassSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
export type AiFailureClass = z.infer<typeof AiFailureClassSchema>;

function roundGateScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function resolveStateEvaluationGatePolicy(state: Partial<ControlPlaneState>): ControlPlaneEvaluationGatePolicy {
  return EvaluationGatePolicySchema.parse((state as any)?.evaluationGatePolicy || DEFAULT_EVALUATION_GATE_POLICY);
}

function resolveStateEvaluationGateResult(state: Partial<ControlPlaneState>): ControlPlaneEvaluationGateResult {
  const policy = resolveStateEvaluationGatePolicy(state);
  return EvaluationGateResultSchema.parse({
    ...buildDefaultEvaluationGateResult(policy),
    ...((state as any)?.evaluationGateResult || {}),
    mode: policy.mode,
    target: policy.target,
    aggregationMode: policy.aggregationMode,
    enforced: policy.mode === 'enforce',
    metricKey: policy.metricKey,
  });
}

function resolveStateGovernanceGateResult(state: Partial<ControlPlaneState>): ControlPlaneGovernanceGateResult {
  return GovernanceGateResultSchema.parse({
    ...DEFAULT_GOVERNANCE_GATE_RESULT,
    ...((state as any)?.governanceGateResult || {}),
  });
}

function describeEvaluationGateBlockedActions(result: ControlPlaneEvaluationGateResult): string[] {
  const blocked: string[] = [];
  if (result.blocksAutonomousEdits) blocked.push('autonomous-edits');
  if (result.blocksExecution) blocked.push('execution');
  return blocked;
}

function describeGovernanceGateBlockedActions(result: ControlPlaneGovernanceGateResult): string[] {
  const blocked: string[] = [];
  if (result.blocksAutonomousEdits) blocked.push('autonomous-edits');
  if (result.blocksExecution) blocked.push('execution');
  return blocked;
}

function selectBaselineEvaluation(
  evaluations: Array<z.infer<typeof LangSmithEvaluationSummarySchema>>,
  datasetName: string,
): z.infer<typeof LangSmithEvaluationSummarySchema> | null {
  const normalizedDatasetName = String(datasetName || '').trim();
  if (!normalizedDatasetName) return null;

  const match = [...evaluations]
    .map((evaluation) => LangSmithEvaluationSummarySchema.parse(evaluation))
    .reverse()
    .find((evaluation) => String(evaluation.datasetName || '').trim() === normalizedDatasetName);

  return match || null;
}

function resolveEvaluationGateResult(
  policyInput: ControlPlaneEvaluationGatePolicy,
  evaluations: Array<z.infer<typeof LangSmithEvaluationSummarySchema>>,
  langSmithEnabled: boolean,
): ControlPlaneEvaluationGateResult {
  const policy = EvaluationGatePolicySchema.parse(policyInput || DEFAULT_EVALUATION_GATE_POLICY);
  const normalizedEvaluations = evaluations.map((evaluation) => LangSmithEvaluationSummarySchema.parse(evaluation));
  const evaluationCount = normalizedEvaluations.length;
  const resultCount = normalizedEvaluations.reduce((total, evaluation) => total + Math.max(0, evaluation.resultCount || 0), 0);
  const latestScorecard = [...normalizedEvaluations]
    .map((evaluation) => evaluation.scorecard)
    .reverse()
    .find((scorecard): scorecard is z.infer<typeof LangSmithEvaluationScorecardSchema> => Boolean(scorecard)) || null;
  const latestScorecardMetricMap = new Map(
    (latestScorecard?.metricDeltas || []).map((metric) => [metric.key, metric]),
  );
  const metricKeysToCheck = Array.from(new Set([
    policy.metricKey,
    ...policy.requiredMetricKeys,
    ...Object.keys(policy.additionalMetricThresholds || {}),
  ].map((key) => String(key || '').trim()).filter(Boolean)));
  const metricResults = metricKeysToCheck.map((metricKey) => {
    const metricMatches = normalizedEvaluations.flatMap((evaluation) => evaluation.metrics.filter((metric) => metric.key === metricKey));
    const count = metricMatches.reduce((total, metric) => total + Math.max(0, metric.count || 0), 0);
    const weightedTotal = metricMatches.reduce((total, metric) => {
      if (typeof metric.averageScore !== 'number' || !Number.isFinite(metric.averageScore)) return total;
      return total + (metric.averageScore * Math.max(0, metric.count || 0));
    }, 0);
    const averageScore = count > 0 ? roundGateScore(weightedTotal / count) : null;
    const minAverageScore = metricKey === policy.metricKey
      ? policy.minMetricAverageScore
      : (policy.additionalMetricThresholds?.[metricKey] ?? 0);
    const required = metricKey === policy.metricKey || policy.requiredMetricKeys.includes(metricKey);
    const passed = count > 0 && averageScore !== null && averageScore >= minAverageScore;
    const latestScorecardMetric = latestScorecardMetricMap.get(metricKey);
    return EvaluationMetricGateResultSchema.parse({
      key: metricKey,
      count,
      averageScore,
      minAverageScore,
      required,
      passed,
      weight: typeof policy.metricWeights?.[metricKey] === 'number' ? policy.metricWeights[metricKey] : null,
      baselineAverageScore: latestScorecardMetric?.baselineAverageScore ?? null,
      deltaAverageScore: latestScorecardMetric?.deltaAverageScore ?? null,
    });
  });
  const primaryMetricResult = metricResults.find((metric) => metric.key === policy.metricKey)
    || EvaluationMetricGateResultSchema.parse({
      key: policy.metricKey,
      count: 0,
      averageScore: null,
      minAverageScore: policy.minMetricAverageScore,
      required: true,
      passed: false,
      weight: typeof policy.metricWeights?.[policy.metricKey] === 'number' ? policy.metricWeights[policy.metricKey] : null,
      baselineAverageScore: null,
      deltaAverageScore: null,
    });
  const metricCount = primaryMetricResult.count;
  const metricAverageScore = primaryMetricResult.averageScore;
  const weightedMetricEntries = metricResults
    .map((metric) => {
      if (metric.averageScore === null) return null;
      return {
        averageScore: metric.averageScore,
        weight: typeof metric.weight === 'number' && Number.isFinite(metric.weight) && metric.weight > 0 ? metric.weight : 1,
      };
    })
    .filter(Boolean) as Array<{ averageScore: number; weight: number }>;
  const totalMetricWeight = weightedMetricEntries.reduce((sum, entry) => sum + entry.weight, 0);
  const weightedAverageScore = totalMetricWeight > 0
    ? roundGateScore(weightedMetricEntries.reduce((sum, entry) => sum + (entry.averageScore * entry.weight), 0) / totalMetricWeight)
    : null;
  const enforced = policy.mode === 'enforce';

  if (policy.mode === 'off') {
    return EvaluationGateResultSchema.parse({
      ...buildDefaultEvaluationGateResult(policy),
      status: 'disabled',
      evaluationCount,
      resultCount,
      metricCount,
      metricAverageScore,
      weightedAverageScore,
      minimumWeightedScore: policy.aggregationMode === 'weighted' ? policy.minimumWeightedScore : null,
      scorecardStatus: 'not-evaluated',
      baselineExperimentName: latestScorecard?.baselineExperimentName || policy.baselineExperimentName,
      comparisonUrl: latestScorecard?.comparisonUrl || '',
      metricResults,
      reason: 'Evaluation gate disabled.',
    });
  }

  const failingChecks: string[] = [];
  let status: z.infer<typeof EvaluationGateResultSchema>['status'] = 'passed';
  let reason = '';

  if (evaluationCount === 0 || resultCount === 0) {
    if (policy.requireEvaluation) {
      failingChecks.push(`No LangSmith evaluation results were recorded for required metric ${policy.metricKey}.`);
      status = 'failed';
      reason = `Evaluation gate failed: ${failingChecks[0]}`;
    } else {
      status = 'not-evaluated';
      reason = langSmithEnabled
        ? `No LangSmith evaluation results were recorded for metric ${policy.metricKey}; gate left open.`
        : `LangSmith runtime integration is disabled or unavailable; gate left open for metric ${policy.metricKey}.`;
    }
  } else {
    if (resultCount < policy.minResultCount) {
      failingChecks.push(`LangSmith evaluation produced ${resultCount} result(s); policy requires at least ${policy.minResultCount}.`);
    }
    for (const metricResult of metricResults) {
      if (!metricResult.required) continue;
      if (metricResult.count === 0) {
        failingChecks.push(`LangSmith evaluators did not report metric ${metricResult.key}.`);
        continue;
      }
      if (metricResult.averageScore === null || metricResult.averageScore < metricResult.minAverageScore) {
        failingChecks.push(`Metric ${metricResult.key} averaged ${metricResult.averageScore ?? 'n/a'}; policy requires at least ${metricResult.minAverageScore}.`);
      }
    }

    if (
      policy.aggregationMode === 'weighted'
      && weightedAverageScore !== null
      && weightedAverageScore < policy.minimumWeightedScore
    ) {
      failingChecks.push(`Weighted scorecard averaged ${weightedAverageScore}; policy requires at least ${policy.minimumWeightedScore}.`);
    }

    if (failingChecks.length > 0) {
      status = 'failed';
      reason = `Evaluation gate failed: ${failingChecks[0]}`;
    } else {
      status = 'passed';
      reason = `Evaluation gate passed: metric ${policy.metricKey} averaged ${metricAverageScore ?? 'n/a'} across ${metricCount} scored result(s).`;
    }
  }

  return EvaluationGateResultSchema.parse({
    status,
    mode: policy.mode,
    target: policy.target,
    aggregationMode: policy.aggregationMode,
    enforced,
    blocksExecution: enforced && status === 'failed' && (policy.target === 'execution' || policy.target === 'both'),
    blocksAutonomousEdits: enforced && status === 'failed' && (policy.target === 'autonomous-edits' || policy.target === 'both'),
    evaluationCount,
    resultCount,
    metricKey: policy.metricKey,
    metricCount,
    metricAverageScore,
    weightedAverageScore,
    minimumWeightedScore: policy.aggregationMode === 'weighted' ? policy.minimumWeightedScore : null,
    scorecardStatus: evaluationCount === 0 || resultCount === 0 ? 'not-evaluated' : (failingChecks.length > 0 ? 'failed' : 'passed'),
    baselineExperimentName: latestScorecard?.baselineExperimentName || policy.baselineExperimentName,
    comparisonUrl: latestScorecard?.comparisonUrl || '',
    metricResults,
    failingChecks,
    reason,
  });
}

function resolveGovernanceGateResult(
  governanceProfile: ControlPlaneGovernanceProfile,
  governance: z.infer<typeof LangSmithGovernanceSummarySchema> | null | undefined,
  langSmithEnabled: boolean,
): ControlPlaneGovernanceGateResult {
  if (!langSmithEnabled) {
    return GovernanceGateResultSchema.parse({
      ...DEFAULT_GOVERNANCE_GATE_RESULT,
      target: governanceProfile.gateTarget,
      reason: 'LangSmith runtime integration is disabled or unavailable; governance gate left open.',
    });
  }

  if (!governance) {
    return GovernanceGateResultSchema.parse({
      ...DEFAULT_GOVERNANCE_GATE_RESULT,
      target: governanceProfile.gateTarget,
      reason: 'Governance gate has not been evaluated yet because no LangSmith governance snapshot was available.',
    });
  }

  const actionableFlags = governance.flags.filter((flag) => flag.status !== 'pass');
  const failedFlags = governance.flags.filter((flag) => flag.status === 'fail');
  const warnedFlags = governance.flags.filter((flag) => flag.status === 'warn');
  const shouldBlock = failedFlags.length > 0 || (governanceProfile.blockAutonomousOnWarn && warnedFlags.length > 0);
  const blocksExecution = shouldBlock && (governanceProfile.gateTarget === 'execution' || governanceProfile.gateTarget === 'both');
  const blocksAutonomousEdits = shouldBlock && (governanceProfile.gateTarget === 'autonomous-edits' || governanceProfile.gateTarget === 'both');

  return GovernanceGateResultSchema.parse({
    status: shouldBlock ? 'failed' : 'passed',
    target: governanceProfile.gateTarget,
    enforced: true,
    blocksExecution,
    blocksAutonomousEdits,
    actionableFlagKeys: actionableFlags.map((flag) => flag.key),
    failedFlagKeys: failedFlags.map((flag) => flag.key),
    reason: shouldBlock
      ? `Governance gate blocked ${describeGovernanceGateBlockedActions({
          ...DEFAULT_GOVERNANCE_GATE_RESULT,
          blocksExecution,
          blocksAutonomousEdits,
        }).join(', ') || governanceProfile.gateTarget} because ${failedFlags.length > 0 ? `${failedFlags.length} fail flag(s)` : `${warnedFlags.length} warn flag(s)`} were sampled.`
      : actionableFlags.length > 0
        ? `Governance gate left open with ${actionableFlags.length} actionable LangSmith flag(s) under profile ${governanceProfile.name}.`
        : `Governance gate passed under profile ${governanceProfile.name}; sampled LangSmith signals are within policy.`,
  });
}

function shouldApplyAutonomousEditsForState(state: ControlPlaneState): boolean {
  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  const governanceGateResult = resolveStateGovernanceGateResult(state);
  const surfaceBrowserBlockingReason = getSurfaceBrowserBlockingReason(state);
  return state.executePlan
    && state.autonomousEditEnabled
    && state.autonomousEditReviewDecision === 'approved'
    && state.proposedEdits.length > 0
    && !surfaceBrowserBlockingReason
    && !evaluationGateResult.blocksAutonomousEdits
    && !governanceGateResult.blocksAutonomousEdits;
}

function shouldRunJobsForState(state: ControlPlaneState): boolean {
  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  const governanceGateResult = resolveStateGovernanceGateResult(state);
  return state.executePlan && !evaluationGateResult.blocksExecution && !governanceGateResult.blocksExecution;
}

function isLangSmithRunFailure(run: z.infer<typeof LangSmithRunSummarySchema>): boolean {
  const normalizedStatus = String(run.status || '').trim().toLowerCase();
  return Boolean(String(run.error || '').trim())
    || normalizedStatus.includes('fail')
    || normalizedStatus.includes('error');
}

function getAppliedRepairPaths(state: Pick<ControlPlaneState, 'appliedEdits'>): string[] {
  return Array.from(new Set(
    state.appliedEdits
      .filter((edit) => edit.status === 'applied')
      .map((edit) => String(edit.path || '').trim())
      .filter(Boolean),
  ));
}

function getRepairTouchedPaths(state: Pick<ControlPlaneState, 'appliedEdits' | 'repairSessionManifest'>): string[] {
  const manifestPaths = state.repairSessionManifest?.touchedFiles.map((file) => String(file.path || '').trim()).filter(Boolean) || [];
  return Array.from(new Set([...manifestPaths, ...getAppliedRepairPaths(state)]));
}

function hasFailedExecutedJobs(jobs: ExecutedJob[]): boolean {
  return jobs.some((job) => job.status === 'failed');
}

function isLikelyRepairLogLine(line: string): boolean {
  const normalized = String(line || '').trim();
  if (!normalized) return false;

  if (/\b(error|failed|failure|timeout|timed out|unauthorized|invalid|exception|refused|denied|backlog|overloaded|degraded|unavailable|unhealthy|panic|codeql|sarif|security|vulnerability|injection|xss|ssrf|traversal|taint)\b/i.test(normalized)) {
    return true;
  }

  const removedMatch = normalized.match(/\bremoved\s+(\d+)\b/i);
  if (removedMatch && Number(removedMatch[1]) > 0) {
    return true;
  }

  return /\b(?:429|500|502|503|504)\b/.test(normalized);
}

function normalizeRepairSignalCategoryText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z/g, '<timestamp>')
    .replace(/req_[a-z0-9-]+/g, '<request>')
    .replace(/\b[a-f0-9]{8}-[a-f0-9-]{27}\b/g, '<uuid>')
    .replace(/\b(?:openai|gemini|openrouter|anthropic|groq|deepseek|ollama|xai|google)-[a-z0-9?-]+\b/g, '<provider>')
    .replace(/\b(?:video|thread|trace)_[a-z0-9]+\b/g, '<id>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectRepairSignalTextFragments(signal: string): string[] {
  const normalized = String(signal || '').trim();
  if (!normalized) return [];

  const logMatch = normalized.match(/^Log\s+([^:]+):\s*(.+)$/s);
  const payload = logMatch ? logMatch[2].trim() : normalized;
  const fragments = [normalized, payload];

  try {
    const parsed = JSON.parse(payload) as Record<string, any>;
    const nestedCandidates = [
      parsed.type,
      parsed.test,
      parsed.reason,
      parsed.outcome,
      parsed.message,
      parsed.errorMessage,
      parsed.error,
      parsed.code,
      parsed.requestUrl,
      parsed.modelId,
      parsed.errorDetails?.code,
      parsed.errorDetails?.clientMessage,
      parsed.errorDetails?.message,
      parsed.errorDetails?.reason,
      parsed.errorDetails?.modelId,
    ];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        fragments.push(candidate.trim());
      }
    }
  } catch {
    // Non-JSON signals are handled from the normalized text.
  }

  return Array.from(new Set(fragments.map((fragment) => String(fragment || '').trim()).filter(Boolean)));
}

function isExternallyCausedRepairSignal(signal: string): boolean {
  const normalized = String(signal || '').trim();
  if (!normalized) return false;

  if (/saved providers\.json\.\s+kept\s+\d+,\s+removed\s+\d+/i.test(normalized)) {
    return true;
  }

  const searchable = normalizeRepairSignalCategoryText(collectRepairSignalTextFragments(normalized).join(' | '));
  return /(key_invalid|api[_-]?key[_-]?invalid|api key not found|api key not valid|invalid api key|unauthorized|permission_denied|service_disabled|generative language api has not been used in project|disabled upstream api|disabled upstream apis|disabled project|disabled api|resource has been exhausted|check quota|quota exceeded|insufficient_quota|insufficient quota|no quota|insufficient credits|credit balance|billing|request failed with status code 402|\b402\b|probe_(?:skip|retry)|unsupported \(rate limit\/timeout\)|rate limit\/timeout|switching provider|provider switch worthless|providerswitchworthless|request retry worthless|requestretryworthless|remote media urls could not be fetched by gemini|gemini_unsupported_remote_media_url|publicly accessible url or inline\/base64 media content|catalog auth failure|listmodels failed|server_error|empty streaming response|returned an empty streaming response|function calling is not enabled|cannot fetch content from the provided url|image_url could not be fetched by the provider|currently experiencing high demand|failureorigin.?upstream_provider|failureorigin.?input|upstream_provider|input-bound|provider-bound|langsmith run queue pressure|langsmith queue pressure|annotation backlog|queued review item\(s\) need attention|no sampled feedback items were available for governance signal inspection)/i.test(searchable);
}

function shouldAvoidProviderPathAutonomousEdits(signals: string[]): boolean {
  const normalizedSignals = signals
    .map((signal) => normalizeRepairSignalCategoryText(collectRepairSignalTextFragments(signal).join(' | ')))
    .filter(Boolean);
  if (normalizedSignals.length === 0) return false;

  const providerBoundSignals = normalizedSignals.filter((signal) => /provider switch worthless|request retry worthless|listmodels failed|api key not found|api key not valid|key_invalid|service_disabled|permission_denied|generative language api has not been used in project|provider-bound|upstream_provider/.test(signal));
  return providerBoundSignals.length > 0 && providerBoundSignals.length >= Math.max(1, Math.ceil(normalizedSignals.length / 2));
}

function shouldRestrictAutonomousEditsToControlPlane(state: Pick<ControlPlaneState, 'repairSignals' | 'autonomousOperationMode'>): boolean {
  const actionableSignalCount = countActionableRepairSignals(state.repairSignals);
  const externalSignalCount = countExternallyCausedRepairSignals(state.repairSignals);
  if (actionableSignalCount > 0) return false;
  if (externalSignalCount === 0) return false;
  return state.autonomousOperationMode !== 'repair' || shouldAvoidProviderPathAutonomousEdits(state.repairSignals);
}

function isTightlyCoupledAutonomousEditBatch(touchedPaths: string[]): boolean {
  const normalizedPaths = Array.from(new Set(touchedPaths.map((candidatePath) => String(candidatePath || '').trim()).filter(Boolean)));
  if (normalizedPaths.length <= 1) return true;
  if (normalizedPaths.length > 2) return false;

  const hasWorkflow = normalizedPaths.includes('apps/langgraph-control-plane/src/workflow.ts');
  const hasIndex = normalizedPaths.includes('apps/langgraph-control-plane/src/index.ts');
  const hasErrorClassification = normalizedPaths.includes('apps/api/modules/errorClassification.ts');
  const hasPricingFile = normalizedPaths.includes(API_PRICING_SOURCE_FILE);
  const hasFetchPricing = normalizedPaths.includes('apps/api/dev/fetchPricing.ts');
  const hasModelUpdater = normalizedPaths.includes('apps/api/modules/modelUpdater.ts');
  const allControlPlane = normalizedPaths.every((candidatePath) => candidatePath.startsWith('apps/langgraph-control-plane/'));
  const allApiModules = normalizedPaths.every((candidatePath) => candidatePath.startsWith('apps/api/modules/'));

  if (allControlPlane) return true;
  if (allApiModules && hasErrorClassification) return true;
  if (hasPricingFile && (hasFetchPricing || hasModelUpdater)) return true;
  if (hasWorkflow && (hasIndex || hasErrorClassification)) return true;
  return false;
}

function signalTextHasPricingCoverageFocus(sourceText: string): boolean {
  return /pricing coverage|pricing gap|zero placeholder pricing|missing pricing|pricing\.json|routermodels\.json|fetch pricing|fetchpricing|unresolved non-free pricing|source-of-truth pricing/.test(sourceText);
}

function signalTextHasApiAvailabilityFocus(sourceText: string): boolean {
  return /provider_cap_blocked|provider_model_removed|image generation unavailable|availability metadata|model-availability|removed in provider region|unavailable in provider region|unsupported capability|unsupported modality|tool_choice|tool choice|tool[-_ ]calling|tool calling|fast-image-sync|saved providers\.json|providers\.json|lyria-3-clip-preview|lyria-3-pro-preview/.test(sourceText);
}

function signalTextHasApiCatalogDriftFocus(sourceText: string): boolean {
  return /provider_cap_blocked|provider_model_removed|image generation unavailable|removed in provider region|unavailable in provider region|fast-image-sync|saved providers\.json|providers\.json/.test(sourceText);
}

function signalTextHasApiRoutingFocus(sourceText: string): boolean {
  return /provider traversal|attemptedproviders|candidateproviders|skippedbycooldown|cooldown|provider selection|provider switch|routing|retry worthless|providerswitchworthless|requestretryworthless|generatecontent|unsupported input mime type|audio_input|function calling is not enabled|unsupported capability|unsupported modality|tool[-_ ]calling|tool calling|tool_choice|gemini-3\.1-flash-live-preview|lyria-3-pro-preview/.test(sourceText);
}

function signalTextHasProviderAuthDriftFocus(sourceText: string): boolean {
  return /key_invalid|invalid_api_key|incorrect api key|api key not found|api key not valid|unauthorized|status 401|request failed with status code 401|permission_denied|service_disabled|quota exceeded|quota exhausted|resource has been exhausted|insufficient_quota|insufficient quota|payment required|credit balance|key_no_quota|request failed with status code 402/.test(sourceText);
}

function signalTextHasCapabilityAuditFocus(sourceText: string): boolean {
  return /checkmodelcapabilities|capability audit|missing capabilities|inferred capability requirements|capability heuristic|heuristic capability|capability check/.test(sourceText);
}

function signalTextHasSurfaceAssetFocus(sourceText: string): boolean {
  return /favicon|\/favicon\.ico|static asset|asset path|asset pipeline|missing asset|broken asset|homepage|ui shell|browser shell|logo|hero|cta|frontend origin/.test(sourceText);
}

function signalTextHasApiRuntimeFocus(sourceText: string): boolean {
  return /memory pressure|queue|overloaded|max_pending|swap_used_mb|external_mb|request-body-read|request queue|queuewaittimeout|memorypressureerror|middleware|rate limit redis|token estimation|error classification|failureorigin|provider-bound|runtime-capacity/.test(sourceText);
}

function signalTextHasApiPlatformFocus(sourceText: string): boolean {
  return /experimental service|experimental target|entrypoint|startup|openapi\.json|wsserver|websocket|service unit|server\.launcher|health check|platform health|launcher|pid file|port binding|listen|restart/.test(sourceText);
}

function signalTextHasWorkspaceFocus(sourceText: string, insightFile: string): boolean {
  return /workspace-surface|repo-surface|developer-workflow|operator payoff|frontend stack|sync-config|setup\.md|pnpm-workspace|tsconfig|bun\.sh|run-frontend-stack|turbo|package\.json/.test(sourceText)
    || /^(?:package\.json|pnpm-workspace\.yaml|tsconfig\.json|SETUP\.md|turbo\.json|bun\.sh|scripts\/)/.test(insightFile);
}

function scoreLogInsightLineForScope(
  state: Pick<ControlPlaneState, 'scopes' | 'effectiveScopes'>,
  insightFile: string,
  line: string,
): number {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  if (effectiveScopes.has('repo')) return 1;

  const normalizedText = normalizeRepairSignalCategoryText([
    insightFile,
    ...collectRepairSignalTextFragments(line),
  ].join(' | '));
  if (!normalizedText) return 0;

  const pricingCoverageFocus = signalTextHasPricingCoverageFocus(normalizedText);
  const availabilityFocus = signalTextHasApiAvailabilityFocus(normalizedText);
  const catalogDriftFocus = signalTextHasApiCatalogDriftFocus(normalizedText);
  const routingFocus = signalTextHasApiRoutingFocus(normalizedText);
  const authDriftFocus = signalTextHasProviderAuthDriftFocus(normalizedText);
  const capabilityAuditFocus = signalTextHasCapabilityAuditFocus(normalizedText);
  const surfaceAssetFocus = signalTextHasSurfaceAssetFocus(normalizedText);
  const runtimeFocus = signalTextHasApiRuntimeFocus(normalizedText);
  const platformFocus = signalTextHasApiPlatformFocus(normalizedText);
  const workspaceFocus = signalTextHasWorkspaceFocus(normalizedText, insightFile);
  const controlPlaneFocus = /langsmith|control-plane|runner status|evaluation gate|governance gate|annotation backlog|prompt fallback|prompt sync|studio-server/.test(normalizedText)
    || insightFile.startsWith('apps/langgraph-control-plane/')
    || insightFile.startsWith('codeql:');

  let score = 0;

  if (effectiveScopes.has('api-routing')) {
    if (routingFocus) score += 4;
    if (availabilityFocus || authDriftFocus) score += 2;
    if (surfaceAssetFocus || workspaceFocus) score -= 4;
  }

  if (effectiveScopes.has('api-runtime')) {
    if (runtimeFocus) score += 4;
    if (authDriftFocus) score += 2;
    if (routingFocus && (runtimeFocus || authDriftFocus)) score += 1;
    if (routingFocus && !runtimeFocus && !authDriftFocus) score -= 4;
    if (surfaceAssetFocus || workspaceFocus) score -= 4;
  }

  if (effectiveScopes.has('api-data')) {
    if (pricingCoverageFocus) score += 5;
    if (catalogDriftFocus) score += 4;
    if (availabilityFocus) score += 2;
    if (capabilityAuditFocus) score += 3;
    if (insightFile.endsWith('fast-image-sync.log')) score += 3;
    if (routingFocus && !pricingCoverageFocus && !catalogDriftFocus && !capabilityAuditFocus) score -= 4;
    if (surfaceAssetFocus || workspaceFocus || platformFocus) score -= 4;
  }

  if (effectiveScopes.has('api-platform')) {
    if (platformFocus) score += 5;
    if (insightFile.endsWith('studio-server.log')) score += 2;
    if (routingFocus || pricingCoverageFocus || workspaceFocus || surfaceAssetFocus) score -= 3;
  }

  if (effectiveScopes.has('control-plane')) {
    if (controlPlaneFocus) score += 5;
    if (surfaceAssetFocus) score -= 2;
  }

  if (effectiveScopes.has('workspace-surface')) {
    if (workspaceFocus) score += 5;
    if (surfaceAssetFocus) score -= 2;
    if (insightFile.startsWith('apps/api/logs/')) score -= 5;
  }

  if (effectiveScopes.has('homepage-surface')) {
    if (surfaceAssetFocus) score += 4;
    if (insightFile.startsWith('apps/homepage/')) score += 3;
    if (insightFile.startsWith('apps/ui/')) score += 1;
    if (insightFile.startsWith('apps/api/logs/') && !surfaceAssetFocus) score -= 5;
  }

  if (effectiveScopes.has('ui-surface')) {
    if (surfaceAssetFocus) score += 4;
    if (insightFile.startsWith('apps/ui/')) score += 3;
    if (insightFile.startsWith('apps/homepage/')) score += 1;
    if (insightFile.startsWith('apps/api/logs/') && !surfaceAssetFocus) score -= 5;
  }

  return score;
}

function filterLogInsightForScope(
  state: Pick<ControlPlaneState, 'scopes' | 'effectiveScopes'>,
  insight: LogInsight,
): LogInsight | null {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  if (effectiveScopes.has('repo')) return insight;

  const filteredLines = insight.lines
    .filter((line) => scoreLogInsightLineForScope(state, insight.file, line) > 0)
    .slice(-DEFAULT_LOG_TAIL_LINE_COUNT);
  if (filteredLines.length === 0) return null;

  return LogInsightSchema.parse({
    file: insight.file,
    lines: filteredLines,
  });
}

function isApiDataAuditHelperPath(candidatePath: string): boolean {
  return String(candidatePath || '').trim() === 'apps/api/dev/checkModelCapabilities.ts';
}

function isApiDataSourceOfTruthPath(candidatePath: string): boolean {
  const normalizedPath = String(candidatePath || '').trim();
  return normalizedPath === API_MODELS_SOURCE_FILE
    || normalizedPath === API_PRICING_SOURCE_FILE
    || [
      'apps/api/modules/modelUpdater.ts',
      'apps/api/modules/dataManager.ts',
      'apps/api/dev/fetchPricing.ts',
      'apps/api/dev/refreshModels.ts',
      'apps/api/dev/updatemodels.ts',
      'apps/api/dev/updateproviders.ts',
      'apps/api/routes/models.ts',
    ].includes(normalizedPath);
}

function signalTextHasGeminiCapabilityDriftFocus(sourceText: string): boolean {
  return /provider_cap_blocked|provider_model_removed|image generation unavailable|lyria-3-pro-preview|audio\/s16le|function calling is not enabled|tool_calling_not_enabled|unsupported input mime type/.test(
    String(sourceText || '').toLowerCase(),
  );
}

function scoreAutonomousEditPathFit(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'autonomousOperationMode' | 'scopes' | 'effectiveScopes'>,
  path: string,
  supportingText: string = '',
): number {
  const normalizedPath = String(path || '').trim();
  if (!normalizedPath) return 0;
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  const sourceText = [...state.repairSignals, ...state.improvementSignals, supportingText].join(' | ').toLowerCase();
  const pricingCoverageFocus = signalTextHasPricingCoverageFocus(sourceText);
  const availabilityFocus = signalTextHasApiAvailabilityFocus(sourceText);
  const catalogDriftFocus = signalTextHasApiCatalogDriftFocus(sourceText);
  const routingFocus = signalTextHasApiRoutingFocus(sourceText);
  const authDriftFocus = signalTextHasProviderAuthDriftFocus(sourceText);
  const capabilityAuditFocus = signalTextHasCapabilityAuditFocus(sourceText);
  const geminiCapabilityDriftFocus = signalTextHasGeminiCapabilityDriftFocus(sourceText);
  const surfaceAssetFocus = signalTextHasSurfaceAssetFocus(sourceText);
  const platformFocus = /experimental service|experimental target|entrypoint|startup|openapi\.json|wsserver|websocket|service unit|server\.launcher|health check|platform health/.test(sourceText);
  const workspaceFocus = /workspace-surface|repo-surface|developer-workflow|operator payoff|frontend stack|sync-config|setup\.md|pnpm-workspace|tsconfig|bun\.sh|run-frontend-stack/.test(sourceText);

  let score = 0;
  if (effectiveScopes.has('api-routing') && (
    normalizedPath === 'apps/api/providers/handler.ts'
    || normalizedPath === 'apps/api/providers/gemini.ts'
    || normalizedPath === 'apps/api/providers/openrouter.ts'
    || normalizedPath === 'apps/api/modules/openaiProviderSelection.ts'
    || normalizedPath === 'apps/api/modules/openaiRouteSupport.ts'
    || normalizedPath === 'apps/api/modules/openaiRouteUtils.ts'
    || normalizedPath === 'apps/api/modules/openaiResponsesFormat.ts'
    || normalizedPath === 'apps/api/modules/geminiMediaValidation.ts'
    || normalizedPath === 'apps/api/routes/openai.ts'
  )) score += 2;
  if (effectiveScopes.has('api-runtime') && (
    normalizedPath === 'apps/api/modules/errorClassification.ts'
    || normalizedPath === 'apps/api/modules/requestQueue.ts'
    || normalizedPath === 'apps/api/modules/requestIntake.ts'
    || normalizedPath === 'apps/api/modules/errorLogger.ts'
    || normalizedPath === 'apps/api/modules/middlewareFactory.ts'
    || normalizedPath === 'apps/api/modules/rateLimit.ts'
    || normalizedPath === 'apps/api/modules/rateLimitRedis.ts'
  )) score += 2;
  if (effectiveScopes.has('api-data') && isApiDataSourceOfTruthPath(normalizedPath)) score += 2;
  if (effectiveScopes.has('api-platform') && (
    normalizedPath === 'apps/api/server.ts'
    || normalizedPath === 'apps/api/server.launcher.bun.ts'
    || normalizedPath === 'apps/api/ws/wsServer.ts'
    || normalizedPath === 'apps/api/anygpt-api.service'
    || normalizedPath === 'apps/api/anygpt-experimental.service'
  )) score += 2;
  if (effectiveScopes.has('homepage-surface') && normalizedPath.startsWith('apps/homepage/')) score += 2;
  if (effectiveScopes.has('ui-surface') && normalizedPath.startsWith('apps/ui/')) score += 2;
  if (effectiveScopes.has('workspace-surface') && (
    normalizedPath === 'package.json'
    || normalizedPath === 'pnpm-workspace.yaml'
    || normalizedPath === 'tsconfig.json'
    || normalizedPath === 'SETUP.md'
    || normalizedPath === 'scripts/run-frontend-stack.sh'
    || normalizedPath === 'scripts/with-bun-path.sh'
  )) score += 2;
  if (normalizedPath.startsWith('apps/langgraph-control-plane/')) score += 2;
  if ((/codeql|sarif|security|vulnerability|injection|xss|ssrf|traversal|taint/.test(sourceText))) {
    if (normalizedPath.startsWith('apps/api/')) score += 2;
    if (normalizedPath.startsWith('apps/langgraph-control-plane/')) score += 2;
    if (normalizedPath.startsWith('apps/homepage/') || normalizedPath.startsWith('apps/ui/')) score += 1;
  }
  if (normalizedPath.startsWith('apps/api/modules/errorClassification.ts') && /server_error|invalid_response_structure|failureorigin|provider-bound|request retry worthless|providerswitchworthless/.test(sourceText)) score += 4;
  if (normalizedPath.startsWith('apps/api/modules/errorClassification.ts') && /generatecontent|unsupported input mime type|function calling is not enabled|unsupported capability|unsupported modality|resource has been exhausted|quota/.test(sourceText)) score += 3;
  if (normalizedPath.startsWith('apps/api/modules/errorClassification.ts') && authDriftFocus) score += 4;
  if (normalizedPath.startsWith('apps/api/modules/requestQueue.ts') && /memory pressure|queue|overloaded|max_pending|swap_used_mb|external_mb/.test(sourceText)) score += 4;
  if (normalizedPath.startsWith('apps/api/modules/requestQueue.ts') && /resource has been exhausted|quota|candidateproviders|attemptedproviders|skippedbycooldown|provider traversal|retry worthless/.test(sourceText)) score += 3;
  if (normalizedPath.startsWith('apps/api/modules/requestIntake.ts') && /content_length|intake|request body|bufferedrequestbody/.test(sourceText)) score += 4;
  if ((normalizedPath === 'apps/api/server.ts' || normalizedPath === 'apps/api/server.launcher.bun.ts' || normalizedPath === 'apps/api/ws/wsServer.ts' || normalizedPath === 'apps/api/anygpt-api.service' || normalizedPath === 'apps/api/anygpt-experimental.service') && platformFocus) score += 4;
  if (normalizedPath === API_MODELS_SOURCE_FILE && /pricing coverage|pricing gap|zero placeholder pricing|missing pricing|pricing\.json|models\.json/.test(sourceText)) score += 3;
  if (normalizedPath === API_MODELS_SOURCE_FILE && availabilityFocus) score += 4;
  if (normalizedPath === API_MODELS_SOURCE_FILE && authDriftFocus && !catalogDriftFocus) score -= 3;
  if (normalizedPath === API_PRICING_SOURCE_FILE && pricingCoverageFocus) score += 4;
  if (normalizedPath === 'apps/api/modules/modelUpdater.ts' && /pricing coverage|pricing gap|zero placeholder pricing|missing pricing|pricing\.json|models\.json|buildzeropricing|pricing source/.test(sourceText)) score += 4;
  if (normalizedPath === 'apps/api/modules/modelUpdater.ts' && availabilityFocus) score += 3;
  if (normalizedPath === 'apps/api/modules/modelUpdater.ts' && authDriftFocus && !catalogDriftFocus) score -= 3;
  if (normalizedPath === 'apps/api/dev/fetchPricing.ts' && pricingCoverageFocus) score += 4;
  if (normalizedPath === 'apps/api/dev/updateproviders.ts' && availabilityFocus) score += 4;
  if (normalizedPath === 'apps/api/dev/updateproviders.ts' && authDriftFocus && !catalogDriftFocus) score -= 3;
  if (normalizedPath === 'apps/api/dev/updatemodels.ts' && availabilityFocus) score += 4;
  if (normalizedPath === 'apps/api/dev/updatemodels.ts' && authDriftFocus && !catalogDriftFocus) score -= 3;
  if (normalizedPath === 'apps/api/dev/refreshModels.ts' && availabilityFocus) score += 3;
  if (normalizedPath === 'apps/api/dev/refreshModels.ts' && authDriftFocus && !catalogDriftFocus) score -= 2;
  if (normalizedPath === 'apps/api/routes/models.ts' && availabilityFocus) score += 3;
  if (normalizedPath === 'apps/api/routes/models.ts' && authDriftFocus && !catalogDriftFocus) score -= 2;
  if (normalizedPath.startsWith('apps/api/providers/handler.ts') && routingFocus) score += 5;
  if (normalizedPath.startsWith('apps/api/providers/gemini.ts') && routingFocus) score += 5;
  if (normalizedPath.startsWith('apps/api/providers/openrouter.ts') && routingFocus) score += 4;
  if (normalizedPath.startsWith('apps/api/modules/geminiMediaValidation.ts') && routingFocus) score += 4;
  if (normalizedPath.startsWith('apps/api/routes/openai.ts') && routingFocus) score += 3;
  if (normalizedPath.startsWith('apps/api/modules/openaiRouteSupport.ts') && routingFocus) score += 3;
  if (normalizedPath.startsWith('apps/api/modules/openaiRouteUtils.ts') && routingFocus) score += 3;
  if (normalizedPath.startsWith('apps/api/modules/openaiResponsesFormat.ts') && routingFocus) score += 2;
  if (normalizedPath === 'apps/api/dev/checkModelCapabilities.ts' && capabilityAuditFocus) score += 3;
  if (normalizedPath === 'apps/api/dev/checkModelCapabilities.ts' && (pricingCoverageFocus || availabilityFocus)) score -= 4;
  if (normalizedPath.startsWith('apps/api/modules/openaiProviderSelection.ts') && /provider selection|provider switch|retry worthless|routing|model-availability|probe|tool-calling|tool_choice|unsupported(?:-| )tool|healthy selection/.test(sourceText)) score += 3;
  if (normalizedPath.startsWith('apps/api/providers/handler.ts') && geminiCapabilityDriftFocus) score += 4;
  if (normalizedPath.startsWith('apps/api/modules/geminiMediaValidation.ts') && geminiCapabilityDriftFocus) score += 6;
  if (normalizedPath.startsWith('apps/api/providers/gemini.ts') && geminiCapabilityDriftFocus) score += 3;
  if (normalizedPath.startsWith('apps/api/modules/openaiProviderSelection.ts') && geminiCapabilityDriftFocus) score -= 6;
  if (normalizedPath.startsWith('apps/api/modules/openaiRequestSupport.ts') && /heartbeat|keepalive|keep-alive|backpressure|response\.write|drain|sse|stream teardown|stream keepalive|premature stream/.test(sourceText)) score += 3;
  if (normalizedPath.startsWith('apps/api/providers/openai.ts') && /server_error|empty streaming response|responses endpoint|stream/.test(sourceText)) score += 2;
  if (normalizedPath === 'apps/homepage/public/index.html' && surfaceAssetFocus) score += 5;
  if ((normalizedPath === 'apps/homepage/public/script.js' || normalizedPath === 'apps/homepage/public/style.css') && surfaceAssetFocus) score += 4;
  if (normalizedPath === 'apps/homepage/serve.js' && surfaceAssetFocus) score += 3;
  if (normalizedPath === 'apps/ui/librechat/client/index.html' && surfaceAssetFocus) score += 5;
  if (
    (
      normalizedPath === 'apps/ui/librechat/client/src/App.jsx'
      || normalizedPath === 'apps/ui/librechat/client/src/main.jsx'
      || normalizedPath === 'apps/ui/librechat/client/src/style.css'
    )
    && surfaceAssetFocus
  ) score += 4;
  if (normalizedPath.startsWith('apps/ui/scripts/') && surfaceAssetFocus) score += 2;
  if ((normalizedPath === 'package.json' || normalizedPath === 'pnpm-workspace.yaml' || normalizedPath === 'tsconfig.json' || normalizedPath === 'SETUP.md' || normalizedPath === 'scripts/run-frontend-stack.sh' || normalizedPath === 'scripts/with-bun-path.sh') && workspaceFocus) score += 4;
  if (normalizedPath.startsWith('apps/api/providers/gemini.ts') && /gemini/.test(sourceText)) score += 1;
  if (normalizedPath.startsWith('apps/api/providers/')) score -= 1;
  return score;
}

function isActionableRepairSignal(signal: string): boolean {
  const normalized = String(signal || '').trim();
  if (!normalized) return false;
  return !isExternallyCausedRepairSignal(normalized);
}

function hasActionableRepairSignals(signals: string[]): boolean {
  return signals.some((signal) => isActionableRepairSignal(signal));
}

function countActionableRepairSignals(signals: string[]): number {
  return signals.filter((signal) => isActionableRepairSignal(signal)).length;
}

function countExternallyCausedRepairSignals(signals: string[]): number {
  return signals.filter((signal) => isExternallyCausedRepairSignal(signal)).length;
}

function extractRepairSignalSignature(signal: string): string {
  const normalized = String(signal || '').trim();
  if (!normalized) return '';

  const logMatch = normalized.match(/^Log\s+([^:]+):\s*(.+)$/s);
  const source = logMatch ? logMatch[1].trim() : '';
  const payload = logMatch ? logMatch[2].trim() : normalized;

  try {
    const parsed = JSON.parse(payload) as Record<string, any>;
    if (typeof parsed.fingerprint === 'string' && parsed.fingerprint.trim()) {
      return `${source || 'signal'}|fingerprint:${parsed.fingerprint.trim()}`;
    }

    const requestUrl = typeof parsed.requestUrl === 'string' ? parsed.requestUrl.trim() : '';
    const modelId = typeof parsed.modelId === 'string'
      ? parsed.modelId.trim()
      : typeof parsed.errorDetails?.modelId === 'string'
        ? String(parsed.errorDetails.modelId).trim()
        : '';
    const signalType = typeof parsed.type === 'string' ? parsed.type.trim() : '';
    const signalTest = typeof parsed.test === 'string' ? parsed.test.trim() : '';
    const signalMessage = normalizeRepairSignalCategoryText(
      typeof parsed.errorMessage === 'string' && parsed.errorMessage.trim()
        ? parsed.errorMessage
        : typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason
          : typeof parsed.outcome === 'string' && parsed.outcome.trim()
            ? parsed.outcome
            : payload,
    );

    return [
      source || 'signal',
      signalType || undefined,
      signalTest || undefined,
      requestUrl || undefined,
      modelId || undefined,
      signalMessage || undefined,
    ].filter(Boolean).join('|');
  } catch {
    return `${source || 'signal'}|${normalizeRepairSignalCategoryText(payload)}`;
  }
}

function isRepetitiveRepairSignal(signal: string, frequencyCount: number): boolean {
  if (frequencyCount > 1) return true;

  const normalized = normalizeRepairSignalCategoryText(signal);
  return /probe_retry|invalid_response_structure|api key not found|api key not valid|request timed out|rate limit\/timeout: switching provider|resource has been exhausted|request failed with status code <n>/.test(normalized);
}

function deriveRepairIntent(state: ControlPlaneState): { summary: string; signals: string[] } {
  const signals: string[] = [];
  const staleSignals: string[] = [];
  const runnerFailureRetryPattern = /\[langgraph-control-plane\] iteration ended with failure but continuous mode is enabled; sleeping \d+ms before retry/i;

  for (const insight of state.logInsights.slice(0, 12)) {
    if (insight.file.includes('live-autonomous-runner.log')) {
      continue;
    }
    for (const line of insight.lines.slice(-4)) {
      if (
        !line
        || !isLikelyRepairLogLine(line)
        || runnerFailureRetryPattern.test(line)
        || (insight.file.includes('live-autonomous-runner.log') && line.includes('[failed] Build repo: bash ./bun.sh run build'))
        || (insight.file.includes('live-autonomous-runner.log') && line.includes('"summary": "Goal: Continuously monitor, fix, and improve AnyGPT'))
      ) {
        continue;
      }
      const signal = `Log ${insight.file}: ${line}`;
      if (isFreshSignalText(signal)) {
        signals.push(signal);
      } else {
        staleSignals.push(signal);
      }
    }
  }

  const pricingCoverageAudit = auditModelPricingCoverage(state.repoRoot);
  if (pricingCoverageAudit && pricingCoverageAudit.unresolvedCount > 0) {
    const sampleSuffix = pricingCoverageAudit.sampleModelIds.length > 0
      ? ` (examples: ${pricingCoverageAudit.sampleModelIds.join(', ')})`
      : '';
    signals.push(
      `Pricing coverage gap: ${API_MODELS_SOURCE_FILE} still contains ${pricingCoverageAudit.unresolvedCount} non-free model(s) with zero placeholder or missing pricing that do not resolve through ${API_PRICING_SOURCE_FILE} or ${API_ROUTER_MODELS_SOURCE_FILE}${sampleSuffix}. Prefer bounded fixes in ${API_PRICING_SOURCE_FILE}, apps/api/dev/fetchPricing.ts, or apps/api/modules/modelUpdater.ts.`,
    );
  }

  if (
    state.selectedPromptSource === 'local'
    && state.promptSelectionNotes.some((note) => /fallback|unavailable|disabled|no url returned/i.test(note))
  ) {
    const fallbackReason = state.promptSelectionNotes.find((note) => /fallback|unavailable|disabled|no url returned/i.test(note))
      || `Using local fallback prompt bundle for ${state.promptIdentifier || DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER}.`;
    signals.push(`Prompt fallback: ${fallbackReason}`);
  }

  for (const run of state.langSmithRuns.filter((candidate) => isLangSmithRunFailure(candidate)).slice(0, 4)) {
    signals.push(`LangSmith run ${run.name || run.id} signaled ${run.status || run.error || 'failure'}`);
  }

  for (const flag of (state.langSmithGovernance?.flags || []).filter((candidate) => candidate.status !== 'pass').slice(0, 4)) {
    signals.push(`LangSmith governance ${flag.key}: ${flag.summary}`);
  }

  const queueBacklog = Math.max(
    state.langSmithGovernance?.counts.annotationQueueBacklog || 0,
    state.langSmithAnnotationQueues.reduce((total, queue) => total + Math.max(0, queue.itemCount || 0), 0),
  );
  if (queueBacklog > 0) {
    signals.push(`LangSmith annotation backlog: ${queueBacklog} queued review item(s) need attention.`);
  }

  const queuedReviewItems = state.langSmithAnnotationQueueItems
    .filter((item) => {
      const normalizedStatus = String(item.status || '').trim().toLowerCase();
      return !normalizedStatus || ['queued', 'pending', 'waiting', 'open', 'unreviewed'].some((token) => normalizedStatus.includes(token));
    })
    .slice(0, 3);
  if (queuedReviewItems.length > 0) {
    signals.push(`LangSmith queue pressure: ${queuedReviewItems.map((item) => item.runName || item.runId || item.id).join(', ')}`);
  }

  const problematicFeedback = state.langSmithFeedback.filter((item) => {
    if (typeof item.score === 'boolean') return item.score === false;
    if (typeof item.score === 'number' && Number.isFinite(item.score)) return item.score < 1;
    return Boolean(String(item.correctionSummary || '').trim() || String(item.comment || '').trim());
  });
  if (problematicFeedback.length > 0) {
    const feedbackPreview = problematicFeedback
      .slice(0, 3)
      .map((item) => `${item.key}${typeof item.score !== 'undefined' && item.score !== null ? `=${item.score}` : ''}`)
      .join(', ');
    signals.push(`LangSmith feedback signal: ${problematicFeedback.length} problematic feedback item(s) sampled${feedbackPreview ? ` (${feedbackPreview})` : ''}.`);
  }

  if ((state.langSmithGovernance?.counts.runPending || 0) > 0) {
    signals.push(`LangSmith run queue pressure: ${state.langSmithGovernance?.counts.runPending || 0} pending run(s) sampled.`);
  }

  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  if (
    evaluationGateResult.status === 'failed'
    || evaluationGateResult.status === 'not-evaluated'
    || evaluationGateResult.blocksAutonomousEdits
    || evaluationGateResult.blocksExecution
  ) {
    signals.push(`Evaluation gate: ${evaluationGateResult.reason}`);
  }

  for (const job of state.executedJobs.filter((candidate) => candidate.status === 'failed').slice(-3)) {
    signals.push(`Failed job ${job.title}: exit ${job.exitCode ?? 'n/a'}`);
  }

  const dedupedSignals = Array.from(new Set(signals.map((signal) => String(signal || '').trim()).filter(Boolean))).slice(0, 12);
  const signalFrequency = new Map<string, number>();
  for (const signal of signals) {
    const signature = extractRepairSignalSignature(signal);
    if (!signature) continue;
    signalFrequency.set(signature, (signalFrequency.get(signature) || 0) + 1);
  }

  const repetitiveSignals = dedupedSignals.filter((signal) => {
    const signature = extractRepairSignalSignature(signal);
    const frequencyCount = signature ? (signalFrequency.get(signature) || 0) : 0;
    return isRepetitiveRepairSignal(signal, frequencyCount);
  });
  const novelSignals = dedupedSignals.filter((signal) => !repetitiveSignals.includes(signal));
  const actionableSignals = novelSignals.filter((signal) => isActionableRepairSignal(signal));
  const deferredSignals = novelSignals.filter((signal) => !actionableSignals.includes(signal));
  const summary = actionableSignals.length > 0
    ? `Bounded repair focus: ${actionableSignals.slice(0, 3).join(' | ')}`
    : repetitiveSignals.length > 0
      ? `Repeated failure patterns were suppressed so the autonomous loop can prioritize bounded improvements and cleanup work while monitoring: ${repetitiveSignals.slice(0, 3).join(' | ')}`
    : deferredSignals.length > 0
      ? `Observed external, provider-bound, or input-bound churn without a clear code-local repair target; favor a bounded experimental improvement while monitoring: ${deferredSignals.slice(0, 3).join(' | ')}`
      : staleSignals.length > 0
        ? `Recent code-local repair signals are quiet; stale historical issues were suppressed so the autonomous loop can prefer bounded improvements while continuing to monitor: ${staleSignals.slice(0, 2).join(' | ')}`
      : 'No concrete failure signals were detected; only propose a bounded repair when logs, LangSmith signals, prompt fallback, or the evaluation gate identify a clear issue.';

  return {
    summary,
    signals: actionableSignals,
  };
}

function deriveImprovementIntent(state: ControlPlaneState): { summary: string; signals: string[] } {
  const signals: string[] = [];
  const uniqueScopeSet = new Set(getEffectiveScopes(state));
  const providerAvailabilityDriftDetected = state.logInsights.some((insight) => (
    insight.file.endsWith('probe-errors.jsonl')
    && insight.lines.some((line) => /provider_cap_blocked|provider_model_removed|image generation unavailable/i.test(line))
  ));

  if (hasApiFamilyScope(uniqueScopeSet) || uniqueScopeSet.has('repo')) {
    signals.push('Experimental API loop is healthy enough to pursue bounded throughput, routing, and model-availability improvements.');
  }

  if (uniqueScopeSet.has('repo')) {
    signals.push('Repo-wide coverage is active, so the autonomous loop can inspect root build/test health plus bounded UI, homepage, and workspace configuration improvements.');
  }

  if (hasRepoSurfaceFamilyScope(uniqueScopeSet)) {
    signals.push('Repo-surface coverage is active, so the autonomous loop can focus on root workspace files plus bounded homepage/UI improvements without widening into API or control-plane edits.');
  }

  if (uniqueScopeSet.has('control-plane')) {
    signals.push('Control-plane scope is active, so the runtime can refine orchestration, observability, and autonomous recovery heuristics during healthy iterations.');
  }

  if (uniqueScopeSet.has('repo')) {
    signals.push('If no novel repair target is present, prefer bounded feature work, codebase cleanup, architecture simplification, and developer-workflow hardening over repeating provider churn analysis.');
  }

  if (hasRepoSurfaceFamilyScope(uniqueScopeSet)) {
    signals.push('Prefer small root-workspace, homepage, and UI cleanup work when no code-local repair target is present.');
  }

  const syncInsight = state.logInsights.find((insight) => insight.file.endsWith('fast-image-sync.log'));
  const latestSyncLine = syncInsight?.lines[syncInsight.lines.length - 1];
  if (latestSyncLine && (hasApiFamilyScope(uniqueScopeSet) || uniqueScopeSet.has('repo'))) {
    signals.push(`Provider/model sync churn insight: ${latestSyncLine}`);
  }

  if (providerAvailabilityDriftDetected && (uniqueScopeSet.has('api-data') || hasApiFamilyScope(uniqueScopeSet) || uniqueScopeSet.has('repo'))) {
    signals.push(`Source-of-truth preference: when provider/model availability drift is active, prefer ${API_MODELS_SOURCE_FILE}, apps/api/dev/updateproviders.ts, apps/api/dev/updatemodels.ts, apps/api/modules/modelUpdater.ts, and apps/api/routes/models.ts over audit-only helpers like apps/api/dev/checkModelCapabilities.ts.`);
  }

  if (state.langSmithRuns.length > 0 && state.langSmithRuns.every((run) => !isLangSmithRunFailure(run))) {
    signals.push('Recent LangSmith runs did not surface active failures; prefer a small experimental improvement with bounded validation.');
  }

  if (state.langSmithFeedback.length === 0) {
    signals.push('No sampled LangSmith feedback regressions were present; safe feature or performance improvements can be considered.');
  }

  if (state.langSmithGovernance && state.langSmithGovernance.flags.every((flag) => flag.status === 'pass')) {
    signals.push('Governance checks are currently quiet; use the window for small experimental improvements rather than risky broad edits.');
  }

  const dedupedSignals = Array.from(new Set(signals.map((signal) => String(signal || '').trim()).filter(Boolean))).slice(0, 8);
  const summary = dedupedSignals.length > 0
    ? `Bounded improvement focus: ${dedupedSignals.slice(0, 3).join(' | ')}`
    : 'No active repair signals were detected; only propose a bounded experimental improvement when a clear, safe opportunity exists.';

  return {
    summary,
    signals: dedupedSignals,
  };
}

function resolveAutonomousContractPaths(
  state: Pick<ControlPlaneState, 'repoRoot' | 'editAllowlist' | 'editDenylist'>,
  preferredPaths: string[],
): string[] {
  const resolved: string[] = [];
  for (const preferredPath of preferredPaths) {
    const normalizedPath = String(preferredPath || '').trim();
    if (!normalizedPath) continue;
    const check = checkAutonomousEditPath(
      state.repoRoot,
      normalizedPath,
      state.editAllowlist,
      state.editDenylist,
    );
    if (!check.allowed) continue;
    if (!resolved.includes(check.normalizedPath)) {
      resolved.push(check.normalizedPath);
    }
  }
  return resolved;
}

function shouldAllowScopedProviderPathAutonomousEdits(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'scopes' | 'effectiveScopes'>,
  touchedPaths: string[],
  proposalReasonByPath?: Map<string, string>,
): boolean {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  if (!effectiveScopes.has('api-routing')) return false;

  const normalizedTouchedPaths = Array.from(new Set(
    touchedPaths
      .map((candidatePath) => String(candidatePath || '').trim())
      .filter(Boolean),
  ));
  if (!normalizedTouchedPaths.some((candidatePath) => candidatePath.startsWith('apps/api/providers/'))) {
    return false;
  }

  const allowedProviderPaths = new Set([
    'apps/api/providers/handler.ts',
    'apps/api/providers/gemini.ts',
    'apps/api/providers/openrouter.ts',
  ]);
  const allowedSupportingPaths = new Set([
    'apps/api/modules/openaiProviderSelection.ts',
    'apps/api/modules/openaiRequestSupport.ts',
    'apps/api/modules/openaiRouteSupport.ts',
    'apps/api/modules/openaiRouteUtils.ts',
    'apps/api/modules/openaiResponsesFormat.ts',
    'apps/api/modules/geminiMediaValidation.ts',
    'apps/api/modules/responsesHistory.ts',
    'apps/api/routes/openai.ts',
  ]);

  if (normalizedTouchedPaths.some((candidatePath) => candidatePath.startsWith('apps/api/providers/') && !allowedProviderPaths.has(candidatePath))) {
    return false;
  }
  if (normalizedTouchedPaths.some((candidatePath) => candidatePath.startsWith('apps/api/') && !allowedProviderPaths.has(candidatePath) && !allowedSupportingPaths.has(candidatePath))) {
    return false;
  }

  const sourceText = [
    ...state.repairSignals,
    ...state.improvementSignals,
    ...normalizedTouchedPaths.map((candidatePath) => proposalReasonByPath?.get(candidatePath) || ''),
  ].join(' | ').toLowerCase();
  return signalTextHasApiRoutingFocus(sourceText);
}

function buildDeterministicAutonomousContract(
  state: Pick<
    ControlPlaneState,
    | 'repoRoot'
    | 'editAllowlist'
    | 'editDenylist'
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'autonomousOperationMode'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
  >,
): { summary: string; checks: string[]; paths: string[] } {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  const sourceText = [
    state.goal,
    state.repairIntentSummary,
    ...state.repairSignals,
    state.improvementIntentSummary,
    ...state.improvementSignals,
  ].join(' | ').toLowerCase();
  const pricingCoverageAudit = auditModelPricingCoverage(state.repoRoot);
  const hasCurrentPricingCoverageGap = Boolean(
    pricingCoverageAudit
    && pricingCoverageAudit.unresolvedCount > 0,
  );
  const apiCatalogDriftFocus = signalTextHasApiCatalogDriftFocus(sourceText);
  const providerAuthDriftFocus = signalTextHasProviderAuthDriftFocus(sourceText);
  const scopedSkillContractTemplate = resolveScopedAutonomousContractTemplate({
    effectiveScopes: Array.from(effectiveScopes),
    goal: state.goal,
    repairSignals: state.repairSignals,
    improvementSignals: state.improvementSignals,
  });
  const checks = [
    'Pick one concrete next change or one tightly coupled file pair and stop after that bounded step.',
    'Every proposed edit must map directly to the active signals and name the exact success condition it satisfies.',
    'If no contract-aligned edit is safe, return no edits and state the blocking reason instead of re-planning broadly.',
  ];
  let summary = state.autonomousOperationMode === 'repair'
    ? 'Bounded repair contract: make one path-bounded change with explicit validation and rollback-ready scope.'
    : 'Bounded improvement contract: make one path-bounded improvement with explicit success criteria or no-op cleanly.';
  let preferredPaths: string[] = [];

  if (hasCurrentPricingCoverageGap && (effectiveScopes.has('api-data') || effectiveScopes.has('api') || effectiveScopes.has('api-experimental') || effectiveScopes.has('repo'))) {
    const sampleSuffix = pricingCoverageAudit?.sampleModelIds?.length
      ? ` (examples: ${pricingCoverageAudit.sampleModelIds.join(', ')})`
      : '';
    summary = `Pricing coverage contract: reduce ${pricingCoverageAudit?.unresolvedCount || 0} unresolved non-free pricing entr${(pricingCoverageAudit?.unresolvedCount || 0) === 1 ? 'y' : 'ies'} through source-of-truth pricing/model update files, not audit helpers${sampleSuffix}.`;
    checks.push('Success means the change is anchored in pricing source-of-truth files and remains compatible with experimental API build smoke.');
    checks.push('Use apps/api/pricing.json alone when possible, or a tightly coupled pricing.json plus fetchPricing.ts/modelUpdater.ts pair when generator logic truly must change.');
    preferredPaths = [
      API_PRICING_SOURCE_FILE,
      'apps/api/dev/fetchPricing.ts',
      'apps/api/modules/modelUpdater.ts',
      API_MODELS_SOURCE_FILE,
    ];
  } else if (effectiveScopes.has('api-routing') && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if (effectiveScopes.has('api-data') && providerAuthDriftFocus && !apiCatalogDriftFocus) {
    summary = 'Data sync defer contract: preserve source-of-truth model/provider files and return no edit unless a concrete catalog or availability delta is visible; repeated auth/quota drift belongs to apps/api provider routing/probing.';
    checks.push('Do not edit apps/api/models.json, modelUpdater, or provider/model sync files to respond to Unauthorized, invalid_api_key, or quota-only failures.');
    checks.push('Success for this iteration is a clear defer/no-op reason unless a concrete source-of-truth availability defect is visible in the provided context.');
    preferredPaths = [
      API_MODELS_SOURCE_FILE,
      'apps/api/dev/updateproviders.ts',
      'apps/api/dev/updatemodels.ts',
      'apps/api/dev/refreshModels.ts',
      'apps/api/modules/modelUpdater.ts',
      'apps/api/routes/models.ts',
    ];
  } else if ((effectiveScopes.has('api-data') || effectiveScopes.has('api') || effectiveScopes.has('api-experimental') || effectiveScopes.has('repo')) && apiCatalogDriftFocus) {
    summary = 'Provider/model availability contract: update source-of-truth model/provider availability handling and preserve expected region-blocked removals as availability constraints.';
    checks.push('Do not edit apps/api/dev/checkModelCapabilities.ts unless the active signal explicitly references the audit script or a missing-capability report.');
    checks.push('Prefer source-of-truth catalog files and model-availability output paths over audit-only helpers.');
    checks.push('Do not reinterpret expected Gemini regional image removals or provider capability blocks as generic runtime regressions.');
    checks.push('After an unused-local rejection in modelUpdater or updatemodels, prefer in-place branch rewrites over adding a new helper declaration; any helper added must be consumed by an existing branch in the same patch.');
    preferredPaths = [
      API_MODELS_SOURCE_FILE,
      'apps/api/dev/updateproviders.ts',
      'apps/api/dev/updatemodels.ts',
      'apps/api/dev/refreshModels.ts',
      'apps/api/modules/modelUpdater.ts',
      'apps/api/routes/models.ts',
    ];
  } else if (
    (effectiveScopes.has('api-runtime') || effectiveScopes.has('api') || effectiveScopes.has('api-experimental') || effectiveScopes.has('repo'))
    && /memory pressure|queue|overloaded|max_pending|swap_used_mb|external_mb|request-body-read/.test(sourceText)
  ) {
    summary = 'Runtime pressure contract: make one narrow queue/intake/classification change that reduces ambiguity or load-shedding risk without broad concurrency rewrites.';
    checks.push('Prefer requestQueue, requestIntake, or errorClassification paths and avoid speculative provider changes.');
    preferredPaths = [
      'apps/api/modules/requestQueue.ts',
      'apps/api/modules/requestIntake.ts',
      'apps/api/modules/errorClassification.ts',
    ];
  } else if (effectiveScopes.has('api-data') && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if (effectiveScopes.has('api-runtime') && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if (effectiveScopes.has('api-platform') && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if (effectiveScopes.has('research-scout') && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if ((effectiveScopes.has('control-plane') || effectiveScopes.has('repo')) && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if (effectiveScopes.has('homepage-surface') && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if (effectiveScopes.has('ui-surface') && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if (effectiveScopes.has('workspace-surface') && scopedSkillContractTemplate) {
    summary = scopedSkillContractTemplate.summary;
    checks.push(...scopedSkillContractTemplate.checks);
    preferredPaths = [...scopedSkillContractTemplate.preferredPaths];
  } else if (hasRepoSurfaceFamilyScope(effectiveScopes)) {
    summary = 'Repo-surface contract: make one bounded workspace/homepage/UI improvement with a direct user-visible or operator-visible payoff.';
  }

  return {
    summary,
    checks: Array.from(new Set(checks)).slice(0, 6),
    paths: resolveAutonomousContractPaths(state, preferredPaths),
  };
}

async function autonomousContractNode(state: ControlPlaneState, runtime?: Runtime): Promise<Partial<ControlPlaneState>> {
  if (!state.autonomousEditEnabled) {
    return {
      autonomousContractSummary: '',
      autonomousContractChecks: [],
      autonomousContractPaths: [],
    };
  }

  const contract = buildDeterministicAutonomousContract(state);
  const skillBundle = resolveAutonomousSkillBundle({
    effectiveScopes: getEffectiveScopes(state),
    goal: state.goal,
    repairSignals: state.repairSignals,
    improvementSignals: state.improvementSignals,
    autonomousContractPaths: contract.paths,
  });
  const notes = [
    `Autonomous contract: ${contract.summary}`,
    ...contract.checks.map((check, index) => `Autonomous contract check ${index + 1}: ${check}`),
  ];
  if (skillBundle.alwaysLoaded.length > 0) {
    notes.push(`Autonomous skills (always loaded): ${skillBundle.alwaysLoaded.map((skill) => skill.id).join(', ')}`);
  }
  if (skillBundle.loaded.length > 0) {
    notes.push(`Autonomous skills (loaded): ${skillBundle.loaded.map((skill) => skill.id).join(', ')}`);
  }
  if (contract.paths.length > 0) {
    notes.push(`Autonomous contract paths: ${contract.paths.join(', ')}`);
  }
  const sharedResearchNotes = await readResearchScoutPoolNotes(runtime?.store, {
    langSmithProjectName: state.langSmithProjectName,
    governanceProfile: state.governanceProfile,
    goal: state.goal,
    scopes: state.scopes,
    effectiveScopes: state.effectiveScopes,
    repairIntentSummary: state.repairIntentSummary,
    repairSignals: state.repairSignals,
    improvementIntentSummary: state.improvementIntentSummary,
    improvementSignals: state.improvementSignals,
    autonomousContractSummary: contract.summary,
    autonomousContractPaths: contract.paths,
  }).catch(() => [] as string[]);
  const queuedResearchRequestNotes = await queueResearchScoutLookupRequest(runtime?.store, {
    langSmithProjectName: state.langSmithProjectName,
    governanceProfile: state.governanceProfile,
    threadId: state.threadId,
    goal: state.goal,
    scopes: state.scopes,
    effectiveScopes: state.effectiveScopes,
    repairIntentSummary: state.repairIntentSummary,
    repairSignals: state.repairSignals,
    improvementIntentSummary: state.improvementIntentSummary,
    improvementSignals: state.improvementSignals,
    autonomousContractSummary: contract.summary,
    autonomousContractPaths: contract.paths,
  }).catch(() => [] as string[]);
  notes.push(...sharedResearchNotes);
  notes.push(...queuedResearchRequestNotes);

  return {
    autonomousContractSummary: contract.summary,
    autonomousContractChecks: contract.checks,
    autonomousContractPaths: contract.paths,
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
  };
}

function buildDeterministicQueueOverloadFallbackEdits(
  repoRoot: string,
  candidateFiles: Array<{ path: string; content: string }>,
): AutonomousEditAction[] {
  const edits: AutonomousEditAction[] = [];

  const resolveCandidateContent = (candidatePath: string): string | undefined => {
    try {
      return fs.readFileSync(path.resolve(repoRoot, candidatePath), 'utf8');
    } catch {
      const inMemory = candidateFiles.find((file) => file.path === candidatePath)?.content;
      if (typeof inMemory === 'string' && inMemory.length > 0) return inMemory;
      return undefined;
    }
  };

  const openAiRouteContent = resolveCandidateContent('apps/api/routes/openai.ts');
  const openAiRouteFind = [
    "const REQUEST_ADMISSION_QUEUE_CONCURRENCY = Math.max(1, readEnvNumber('REQUEST_ADMISSION_QUEUE_CONCURRENCY', Math.max(8, Math.min(32, Number(process.env.REQUEST_QUEUE_CONCURRENCY || 12) || 12))));",
    "const REQUEST_ADMISSION_QUEUE_MAX_PENDING = Math.max(0, readEnvNumber('REQUEST_ADMISSION_QUEUE_MAX_PENDING', Math.max(256, REQUEST_ADMISSION_QUEUE_CONCURRENCY * 64)));",
    "const RESPONSES_ADMISSION_QUEUE_CONCURRENCY = Math.max(1, readEnvNumber('RESPONSES_ADMISSION_QUEUE_CONCURRENCY', Math.max(8, REQUEST_ADMISSION_QUEUE_CONCURRENCY)));",
    "const RESPONSES_ADMISSION_QUEUE_MAX_PENDING = Math.max(0, readEnvNumber('RESPONSES_ADMISSION_QUEUE_MAX_PENDING', Math.max(256, RESPONSES_ADMISSION_QUEUE_CONCURRENCY * 64)));",
  ].join('\n');
  const openAiRouteReplace = [
    "const REQUEST_ADMISSION_QUEUE_CONCURRENCY = Math.max(1, readEnvNumber('REQUEST_ADMISSION_QUEUE_CONCURRENCY', Math.max(12, Math.min(48, Number(process.env.REQUEST_QUEUE_CONCURRENCY || 16) || 16))));",
    "const REQUEST_ADMISSION_QUEUE_MAX_PENDING = Math.max(0, readEnvNumber('REQUEST_ADMISSION_QUEUE_MAX_PENDING', Math.max(1024, REQUEST_ADMISSION_QUEUE_CONCURRENCY * 192)));",
    "const RESPONSES_ADMISSION_QUEUE_CONCURRENCY = Math.max(1, readEnvNumber('RESPONSES_ADMISSION_QUEUE_CONCURRENCY', Math.max(12, REQUEST_ADMISSION_QUEUE_CONCURRENCY)));",
    "const RESPONSES_ADMISSION_QUEUE_MAX_PENDING = Math.max(0, readEnvNumber('RESPONSES_ADMISSION_QUEUE_MAX_PENDING', Math.max(1024, RESPONSES_ADMISSION_QUEUE_CONCURRENCY * 192)));",
  ].join('\n');
  if (openAiRouteContent?.includes(openAiRouteFind)) {
    edits.push(AutonomousEditActionSchema.parse({
      type: 'replace',
      path: 'apps/api/routes/openai.ts',
      reason: 'Raise experimental admission-queue concurrency and backlog headroom after repeated QUEUE_OVERLOADED signals.',
      find: openAiRouteFind,
      replace: openAiRouteReplace,
    }));
  }

  const requestQueueContent = resolveCandidateContent('apps/api/modules/requestQueue.ts');
  const requestQueueFind = [
    '  const baselineTierRps = getBaselineTierRps();',
    '  const suggestedDefault = Math.max(8, Math.min(24, Math.ceil(baselineTierRps / 2)));',
    '  const raw = Number(process.env.REQUEST_QUEUE_CONCURRENCY ?? String(suggestedDefault));',
    '  if (!Number.isFinite(raw) || raw <= 0) return suggestedDefault;',
    '  return Math.floor(raw);',
    '})();',
    '',
    'const REQUEST_QUEUE_MAX_PENDING = (() => {',
    '  const baselineTierRps = getBaselineTierRps();',
    '  const suggestedDefault = Math.min(',
    '    4096,',
    '    Math.max(256, REQUEST_QUEUE_CONCURRENCY * 64, baselineTierRps * 8)',
    '  );',
    '  const raw = Number(process.env.REQUEST_QUEUE_MAX_PENDING ?? String(suggestedDefault));',
    '  if (!Number.isFinite(raw) || raw < 0) return suggestedDefault;',
    '  return Math.floor(raw);',
    '})();',
  ].join('\n');
  const requestQueueReplace = [
    '  const baselineTierRps = getBaselineTierRps();',
    '  const suggestedDefault = Math.max(12, Math.min(32, Math.ceil(baselineTierRps * 0.75)));',
    '  const raw = Number(process.env.REQUEST_QUEUE_CONCURRENCY ?? String(suggestedDefault));',
    '  if (!Number.isFinite(raw) || raw <= 0) return suggestedDefault;',
    '  return Math.floor(raw);',
    '})();',
    '',
    'const REQUEST_QUEUE_MAX_PENDING = (() => {',
    '  const baselineTierRps = getBaselineTierRps();',
    '  const suggestedDefault = Math.min(',
    '    8192,',
    '    Math.max(1024, REQUEST_QUEUE_CONCURRENCY * 192, baselineTierRps * 24)',
    '  );',
    '  const raw = Number(process.env.REQUEST_QUEUE_MAX_PENDING ?? String(suggestedDefault));',
    '  if (!Number.isFinite(raw) || raw < 0) return suggestedDefault;',
    '  return Math.floor(raw);',
    '})();',
  ].join('\n');
  if (requestQueueContent?.includes(requestQueueFind)) {
    edits.push(AutonomousEditActionSchema.parse({
      type: 'replace',
      path: 'apps/api/modules/requestQueue.ts',
      reason: 'Increase generic experimental queue concurrency and pending headroom to reduce saturation under bursty load.',
      find: requestQueueFind,
      replace: requestQueueReplace,
    }));
  }

  return edits;
}

function buildDeterministicAutonomousFallbackPlan(
  state: ControlPlaneState,
  operationMode: AutonomousOperationMode,
  candidateFiles: Array<{ path: string; content: string }>,
): { summary: string; edits: AutonomousEditAction[] } | null {
  if (operationMode !== 'repair') return null;

  const signalText = [
    state.repairIntentSummary,
    ...state.repairSignals,
    ...state.plannerNotes,
  ].join('\n');
  const queueSignalDetected = /queue (?:overloaded|is busy)|QUEUE_OVERLOADED|max_pending/i.test(signalText);
  const queueEdits = buildDeterministicQueueOverloadFallbackEdits(state.repoRoot, candidateFiles).slice(0, state.maxEditActions);
  const activeScopes = new Set(getEffectiveScopes(state));

  if (queueEdits.length > 0 && (queueSignalDetected || hasApiFamilyScope(activeScopes) || activeScopes.has('repo'))) {
    return {
      summary: queueSignalDetected
        ? 'Deterministic experimental fallback: widen queue concurrency and backlog headroom after repeated request-queue overload signals.'
        : 'Deterministic experimental fallback: apply the prebuilt queue-headroom patch instead of ending the repair iteration with no code changes.',
      edits: queueEdits,
    };
  }

  return null;
}

function buildRepairSmokeJobs(state: ControlPlaneState): PlannedJob[] {
  const touchedPaths = getRepairTouchedPaths(state);
  if (touchedPaths.length === 0) return [];

  const jobs: PlannedJob[] = [];
  const touchesControlPlaneWorkspace = touchedPaths.some((candidatePath) => candidatePath.startsWith('apps/langgraph-control-plane/'));
  const touchesApiCode = touchedPaths.some((candidatePath) => candidatePath.startsWith('apps/api/'));

  if (touchesControlPlaneWorkspace) {
    jobs.push({
      id: 'repair-smoke-control-plane-typecheck',
      target: 'control-plane',
      kind: 'test',
      title: 'Smoke validate control-plane repair',
      command: CONTROL_PLANE_TYPECHECK_COMMAND,
    });
  }

  if (touchesApiCode) {
    const apiBuildSource = state.buildJobs.find((job) => (
      (job.target === 'api' || job.target === 'api-experimental')
      && job.kind === 'build'
    ));
    const apiTestSource = state.testJobs.find((job) => (
      (job.target === 'api' || job.target === 'api-experimental')
      && job.kind === 'test'
    ));

    if (apiBuildSource) {
      jobs.push({
        ...apiBuildSource,
        id: `${apiBuildSource.id}-repair-smoke`,
        title: `${apiBuildSource.title} (repair smoke)`,
      });
    } else {
      jobs.push({
        id: 'repair-smoke-api-build',
        target: 'api-experimental',
        kind: 'build',
        title: 'Smoke build experimental API repair',
        command: API_EXPERIMENTAL_BUILD_COMMAND,
      });
    }

    if (apiTestSource) {
      jobs.push({
        ...apiTestSource,
        id: `${apiTestSource.id}-repair-smoke`,
        title: `${apiTestSource.title} (repair smoke)`,
      });
    }
  }

  if (jobs.length === 0) {
    jobs.push(buildNoteJob(
      'repair-smoke-none',
      'Repair smoke validation',
      `No executable smoke validation was required for touched files: ${touchedPaths.join(', ')}`,
    ));
  }

  return jobs.slice(0, REPAIR_SMOKE_JOB_LIMIT);
}

function shouldRunPostRepairValidation(state: ControlPlaneState): boolean {
  return state.repairStatus === 'promoted'
    && getRepairTouchedPaths(state).some((candidatePath) => candidatePath.startsWith('apps/api/'));
}

function buildPostRepairValidationJobs(state: ControlPlaneState): PlannedJob[] {
  if (!shouldRunPostRepairValidation(state)) return [];

  const jobs: PlannedJob[] = [
    {
      id: 'post-repair-api-build',
      target: 'api-experimental',
      kind: 'build',
      title: 'Build experimental API after autonomous promotion',
      command: API_EXPERIMENTAL_BUILD_COMMAND,
    },
    {
      id: 'post-repair-api-backtest',
      target: 'api-experimental',
      kind: 'test',
      title: 'Backtest experimental API after autonomous promotion',
      command: API_EXPERIMENTAL_TEST_COMMAND,
    },
  ];

  return jobs.slice(0, POST_REPAIR_VALIDATION_JOB_LIMIT);
}

function isBrowserEvidenceRequired(state: Pick<
  ControlPlaneState,
  'effectiveScopes' | 'scopes' | 'appliedEdits' | 'repairPromotedPaths' | 'repairRollbackPaths'
>): boolean {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  if (!(effectiveScopes.has('homepage-surface') || effectiveScopes.has('ui-surface'))) return false;
  const touchedPaths = [
    ...getAppliedRepairPaths({ appliedEdits: state.appliedEdits }),
    ...state.repairPromotedPaths,
    ...state.repairRollbackPaths,
  ].map((entry) => String(entry || '').trim());
  if (touchedPaths.length === 0) return false;
  return touchedPaths.some((candidatePath) =>
    candidatePath.startsWith('apps/homepage/')
      || candidatePath.startsWith('apps/ui/')
  );
}

function getSurfaceBrowserBlockingReason(
  state: Pick<
    ControlPlaneState,
    'executedMcpActions' | 'effectiveScopes' | 'scopes'
  >,
): string {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  if (!(effectiveScopes.has('homepage-surface') || effectiveScopes.has('ui-surface'))) return '';

  const relevantActions = state.executedMcpActions.filter((action) =>
    action.server === 'playwright'
      && (
        String(action.id || '').startsWith('mcp-playwright-')
        || /^mcp-playwright-post-repair-/.test(String(action.id || ''))
      ),
  );
  if (relevantActions.length === 0) {
    return 'Surface browser evidence is still missing for this browser-visible lane.';
  }

  const navigateFailure = relevantActions.find((action) =>
    action.tool === 'browser_navigate'
      && /err_connection_refused|page\.goto: net::err_connection_refused|chrome-error:\/\/chromewebdata/i.test(
        `${action.outputSummary || ''} ${action.outputPreview || ''}`,
      ),
  );
  if (navigateFailure) {
    return `Surface browser validation is blocked because the target page is unreachable: ${truncateTextMiddle(navigateFailure.outputSummary || navigateFailure.outputPreview || navigateFailure.title, 200)}.`;
  }

  const networkFailure = relevantActions.find((action) =>
    action.tool === 'browser_network_requests'
      && /err_connection_refused|failed| 404\b| 500\b|not found\b/i.test(
        `${action.outputSummary || ''} ${action.outputPreview || ''}`,
      ),
  );
  if (networkFailure) {
    return `Surface browser validation is blocked because the target page still shows blocking network errors: ${truncateTextMiddle(networkFailure.outputSummary || networkFailure.outputPreview || networkFailure.title, 200)}.`;
  }

  return '';
}

function buildPostRepairBrowserValidationActions(state: ControlPlaneState): McpPlannedAction[] {
  if (!isBrowserEvidenceRequired(state)) return [];
  const inspectionsByServer = new Map(
    state.mcpInspections.map((inspection) => [inspection.server, inspection] as const),
  );
  const configsByServer = new Map(
    loadMcpServers(resolveMcpConfigPath(state)).map((server) => [server.name, server] as const),
  );
  const playwrightInspection = inspectionsByServer.get('playwright');
  const playwrightConfig = configsByServer.get('playwright');
  if (!playwrightInspection || playwrightInspection.status !== 'connected' || !playwrightConfig) return [];

  const targetUrl = resolveSignalDrivenMcpTargetUrls(state)[0];
  if (!targetUrl) return [];

  const existingIds = new Set(
    state.executedMcpActions
      .map((action) => String(action.id || '').trim())
      .filter(Boolean),
  );
  const actions: McpPlannedAction[] = [];
  if (!existingIds.has('mcp-playwright-post-repair-navigate') && mcpInspectionHasTool(playwrightInspection, 'browser_navigate')) {
    actions.push(buildMcpPlannedAction({
      id: 'mcp-playwright-post-repair-navigate',
      server: 'playwright',
      tool: 'browser_navigate',
      title: `Validate browser page load for ${targetUrl}`,
      reason: 'Browser-visible lanes must re-open the touched surface after a repair so promotion is backed by a real page-load check.',
      arguments: { url: targetUrl },
      risk: 'low',
      alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_navigate'),
    }));
  }
  if (!existingIds.has('mcp-playwright-post-repair-snapshot') && mcpInspectionHasTool(playwrightInspection, 'browser_snapshot')) {
    actions.push(buildMcpPlannedAction({
      id: 'mcp-playwright-post-repair-snapshot',
      server: 'playwright',
      tool: 'browser_snapshot',
      title: 'Capture post-repair browser snapshot',
      reason: 'Promotion for browser-visible lanes requires a post-repair snapshot that reflects the changed surface.',
      arguments: {},
      risk: 'low',
      alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_snapshot'),
    }));
  }
  if (!existingIds.has('mcp-playwright-post-repair-network') && mcpInspectionHasTool(playwrightInspection, 'browser_network_requests')) {
    actions.push(buildMcpPlannedAction({
      id: 'mcp-playwright-post-repair-network',
      server: 'playwright',
      tool: 'browser_network_requests',
      title: 'Capture post-repair browser network activity',
      reason: 'Promotion for browser-visible lanes requires a post-repair network check so missing assets or blocking HTTP failures do not slip through.',
      arguments: {},
      risk: 'low',
      alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_network_requests'),
    }));
  }

  return actions;
}

function evaluateBrowserValidationBundle(
  state: Pick<ControlPlaneState, 'executedMcpActions' | 'effectiveScopes' | 'scopes' | 'appliedEdits' | 'repairPromotedPaths' | 'repairRollbackPaths'>,
): { required: boolean; passed: boolean; status: EvidenceStatus; reason: string } {
  const required = isBrowserEvidenceRequired(state);
  if (!required) {
    return {
      required: false,
      passed: true,
      status: 'not-required',
      reason: 'Browser validation is not required for this lane.',
    };
  }

  const actions = state.executedMcpActions.filter((action) =>
    action.server === 'playwright'
      && /^mcp-playwright-post-repair-/.test(String(action.id || '').trim()),
  );
  if (actions.length === 0) {
    return {
      required: true,
      passed: false,
      status: 'missing',
      reason: 'Promotion blocked because no post-repair Playwright validation bundle was captured for this browser-visible lane.',
    };
  }

  const navigate = actions.find((action) => action.tool === 'browser_navigate');
  const snapshot = actions.find((action) => action.tool === 'browser_snapshot');
  const network = actions.find((action) => action.tool === 'browser_network_requests');
  const targetUrl = normalizeHttpUrl((navigate?.arguments as Record<string, unknown> | undefined)?.url);
  const targetOrigin = (() => {
    try {
      return targetUrl ? new URL(targetUrl).origin : '';
    } catch {
      return '';
    }
  })();
  const failedAction = actions.find((action) => action.status === 'failed');
  if (failedAction) {
    return {
      required: true,
      passed: false,
      status: 'missing',
      reason: `Promotion blocked because post-repair browser validation failed during ${failedAction.tool}: ${truncateTextMiddle(failedAction.outputSummary || failedAction.title, 180)}.`,
    };
  }
  if (!navigate || navigate.status !== 'success') {
    return {
      required: true,
      passed: false,
      status: 'missing',
      reason: 'Promotion blocked because post-repair Playwright validation did not confirm a successful page load.',
    };
  }
  if (!snapshot || snapshot.status !== 'success') {
    return {
      required: true,
      passed: false,
      status: 'missing',
      reason: 'Promotion blocked because post-repair Playwright validation did not capture a browser snapshot for the touched surface.',
    };
  }

  const consoleEvidence = [navigate?.outputPreview, snapshot?.outputPreview, network?.outputPreview]
    .map((entry) => String(entry || ''))
    .join('\n');
  const consoleErrorCount = Math.max(
    ...Array.from(consoleEvidence.matchAll(/Console:\s*(\d+)\s+errors?/gi)).map((match) => Number(match[1]) || 0),
    0,
  );
  if (consoleErrorCount > 0) {
    return {
      required: true,
      passed: false,
      status: 'missing',
      reason: `Promotion blocked because post-repair browser validation still reported ${consoleErrorCount} console error(s) on the touched surface.`,
    };
  }

  const networkText = [network?.outputSummary, network?.outputPreview]
    .map((entry) => String(entry || ''))
    .join('\n');
  if (network && network.status === 'success') {
    const networkLines = networkText
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const blockingNetworkLines = networkLines.filter((line) => {
      const normalized = line.toLowerCase();
      const failed = normalized.includes('[failed]') || /=>\s*\[(4\d\d|5\d\d)\]/i.test(line);
      if (!failed) return false;
      if (!targetOrigin) return true;
      return normalized.includes(targetOrigin.toLowerCase());
    });
    if (blockingNetworkLines.length > 0) {
      return {
        required: true,
        passed: false,
        status: 'missing',
        reason: `Promotion blocked because post-repair browser validation still saw blocking same-origin network or asset failures: ${truncateTextMiddle(blockingNetworkLines[0], 180)}.`,
      };
    }
  }

  return {
    required: true,
    passed: true,
    status: 'validated',
    reason: 'Post-repair Playwright validation bundle passed with page-load, snapshot, and browser-network evidence.',
  };
}

async function postRepairBrowserEvidenceNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const actions = buildPostRepairBrowserValidationActions(state);
  if (actions.length === 0) {
    const bundle = evaluateBrowserValidationBundle(state);
    return {
      evidenceStatus: bundle.status,
      validationRequired: bundle.required,
      deferReason: bundle.passed ? state.deferReason : bundle.reason,
    };
  }

  const patch = await executePlannedMcpActions(state, actions);
  const executedMcpActions = patch.executedMcpActions || state.executedMcpActions;
  const bundle = evaluateBrowserValidationBundle({
    ...state,
    executedMcpActions,
  });
  const notes = [
    ...actions.map((action) => `Post-repair browser validation queued: ${action.title} (${action.server}.${action.tool}).`),
    bundle.reason,
  ];

  return {
    ...patch,
    evidenceStatus: bundle.status,
    validationRequired: bundle.required,
    deferReason: bundle.passed ? state.deferReason : bundle.reason,
    plannerNotes: appendUniqueNotes(patch.plannerNotes || state.plannerNotes, notes),
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    mcpActionNotes: appendUniqueNotes(patch.mcpActionNotes || state.mcpActionNotes, notes),
  };
}

type ControlPlaneAiConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningEffort?: string;
  source: string;
};

type AiNodeRunResult = {
  enabled: boolean;
  model: string;
  backend: string;
  notes: string[];
  error?: string;
  backpressure?: boolean;
  retryAfterSeconds?: number;
  failureClass?: AiFailureClass;
};

type AiCodeEditResult = {
  enabled: boolean;
  model: string;
  backend: string;
  summary: string;
  edits: AutonomousEditAction[];
  agentLabel?: string;
  agentFocus?: string;
  candidatePaths?: string[];
  error?: string;
  backpressure?: boolean;
  retryAfterSeconds?: number;
};

type AutonomousEditReviewResult = {
  enabled: boolean;
  approved: boolean;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  model: string;
  backend: string;
  error?: string;
};

type AutonomousEditAgentWorkload = {
  label: string;
  focus: string;
  candidateFiles: ReturnType<typeof readAutonomousEditContext>;
  candidatePaths: string[];
};

function isAiBackendBackpressureMessage(value: unknown): boolean {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return /request queue is busy/.test(text)
    || /service temporarily unavailable/.test(text)
    || /retry in a few seconds/.test(text)
    || (/retry_after_seconds/.test(text) && /error_id/.test(text))
    || (/status code 503/.test(text) && /queue|busy|retry/.test(text));
}

function extractAiBackendRetryAfterSeconds(value: unknown): number | undefined {
  const text = String(value || '');
  if (!text) return undefined;
  const jsonStyleMatch = text.match(/retry_after_seconds["']?\s*[:=]\s*(\d+)/i);
  if (jsonStyleMatch) {
    const parsed = Number(jsonStyleMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  const proseMatch = text.match(/retry in\s+(\d+)\s+seconds?/i);
  if (proseMatch) {
    const parsed = Number(proseMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function hasRecentAiBackendBackpressure(
  state: Pick<
    ControlPlaneState,
    | 'plannerNotes'
    | 'buildAgentInsights'
    | 'qualityAgentInsights'
    | 'deployAgentInsights'
    | 'autonomousEditNotes'
    | 'recentAutonomousLearningNotes'
  >,
): boolean {
  const candidates = [
    ...state.plannerNotes.slice(-24),
    ...state.buildAgentInsights.slice(-8),
    ...state.qualityAgentInsights.slice(-8),
    ...state.deployAgentInsights.slice(-8),
    ...state.autonomousEditNotes.slice(-12),
    ...state.recentAutonomousLearningNotes.slice(-8),
  ];
  return candidates.some((entry) => isAiBackendBackpressureMessage(entry));
}

type LoadedMcpServerConfig = {
  name: string;
  command: string;
  args: string[];
  type: string;
  disabled: boolean;
  alwaysAllow: string[];
  disabledTools: string[];
  env: Record<string, string>;
  cwd?: string;
};

const executableAvailabilityCache = new Map<string, boolean>();
const codeQlSourceFreshnessCache = new Map<string, {
  checkedAtMs: number;
  newestSourceMtimeMs: number;
  newestSourcePath: string;
}>();
const gitHubRepoSlugCache = new Map<string, string | null>();
const gitHubCodeQlSyncCache = new Map<string, {
  checkedAtMs: number;
  insights: LogInsight[];
  notes: string[];
}>();
const gitHubCodeQlSyncInflightCache = new Map<string, Promise<{
  insights: LogInsight[];
  notes: string[];
}>>();
const gitHubDependabotSyncCache = new Map<string, {
  checkedAtMs: number;
  insights: LogInsight[];
  notes: string[];
}>();
const gitHubDependabotSyncInflightCache = new Map<string, Promise<{
  insights: LogInsight[];
  notes: string[];
}>>();

const CONTROL_PLANE_DATA_DIR = './apps/api/.control-plane';
const CONTROL_PLANE_PACKAGE_DATA_DIR = '.control-plane';
const API_MODELS_SOURCE_FILE = 'apps/api/models.json';
const API_PRICING_SOURCE_FILE = 'apps/api/pricing.json';
const API_ROUTER_MODELS_SOURCE_FILE = 'apps/api/dev/routermodels.json';
const CONTROL_PLANE_PROVIDERS_FILE = `${CONTROL_PLANE_DATA_DIR}/providers.json`;
const CONTROL_PLANE_KEYS_FILE = `${CONTROL_PLANE_DATA_DIR}/keys.json`;
const CONTROL_PLANE_MODELS_FILE = `${CONTROL_PLANE_DATA_DIR}/models.json`;
const CONTROL_PLANE_PACKAGE_PROVIDERS_FILE = `${CONTROL_PLANE_PACKAGE_DATA_DIR}/providers.json`;
const CONTROL_PLANE_PACKAGE_KEYS_FILE = `${CONTROL_PLANE_PACKAGE_DATA_DIR}/keys.json`;
const CONTROL_PLANE_PACKAGE_MODELS_FILE = `${CONTROL_PLANE_PACKAGE_DATA_DIR}/models.json`;
const CONTROL_PLANE_TEST_PORT = '3310';
const CONTROL_PLANE_SOURCE_REDIS_DB = '0';
const CONTROL_PLANE_TARGET_REDIS_DB = '1';
const CONTROL_PLANE_CHECKPOINTS_FILE = './apps/langgraph-control-plane/.control-plane/checkpoints.json';
const CONTROL_PLANE_ISOLATION_PREFIX = [
  'mkdir -p ./apps/api/.control-plane',
  `cp -f ./apps/api/providers.json ${CONTROL_PLANE_PROVIDERS_FILE} 2>/dev/null || true`,
  `cp -f ./apps/api/keys.json ${CONTROL_PLANE_KEYS_FILE} 2>/dev/null || true`,
  `cp -f ./apps/api/models.json ${CONTROL_PLANE_MODELS_FILE} 2>/dev/null || true`,
].join(' && ');

const API_EXPERIMENTAL_BUILD_COMMAND = 'bash ./bun.sh run -F anygpt-api build:experimental';
const API_EXPERIMENTAL_TEST_COMMAND = [
  CONTROL_PLANE_ISOLATION_PREFIX,
  'CONTROL_PLANE_DATA_SOURCE_PREFERENCE=${CONTROL_PLANE_DATA_SOURCE_PREFERENCE:-redis}',
  `API_PROVIDERS_FILE=${CONTROL_PLANE_PACKAGE_PROVIDERS_FILE}`,
  `API_KEYS_FILE=${CONTROL_PLANE_PACKAGE_KEYS_FILE}`,
  `API_MODELS_FILE=${CONTROL_PLANE_PACKAGE_MODELS_FILE}`,
  `TEST_API_BASE_URL=http://localhost:${CONTROL_PLANE_TEST_PORT}`,
  'TEST_SETUP_MODE=external',
  'DATA_SOURCE_PREFERENCE=${CONTROL_PLANE_DATA_SOURCE_PREFERENCE:-redis}',
  'REDIS_URL=${CONTROL_PLANE_REDIS_URL:-${REDIS_URL:-127.0.0.1:6380}}',
  'REDIS_USERNAME=${CONTROL_PLANE_REDIS_USERNAME:-${REDIS_USERNAME:-default}}',
  'REDIS_PASSWORD=${CONTROL_PLANE_REDIS_PASSWORD:-${REDIS_PASSWORD:-}}',
  'REDIS_TLS=${CONTROL_PLANE_REDIS_TLS:-${REDIS_TLS:-false}}',
  `REDIS_DB={CONTROL_PLANE_TARGET_REDIS_DB:-${CONTROL_PLANE_TARGET_REDIS_DB}}`,
  'bash ./bun.sh run -F anygpt-api test:run',
].join(' ').replace('\u007f', '$');

function parsePositiveIntegerEnv(name: string, fallback: number, minimum: number): number {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const normalized = String(process.env[name] || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

type PricingCoverageAudit = {
  unresolvedCount: number;
  sampleModelIds: string[];
};

function readRepoJsonFile(repoRoot: string, repoRelativePath: string): unknown | null {
  try {
    const resolvedPath = path.resolve(repoRoot, repoRelativePath);
    if (!fs.existsSync(resolvedPath)) return null;
    return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch {
    return null;
  }
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasPositiveRouterPricing(entry: unknown): boolean {
  if (!isPlainObjectRecord(entry)) return false;
  return ['prompt', 'completion', 'image', 'request']
    .map((key) => Number.parseFloat(String(entry[key] ?? '0')))
    .some((value) => Number.isFinite(value) && value > 0);
}

function isFreePricingModelId(modelId: string): boolean {
  return modelId.endsWith(':free') || modelId === 'openrouter/free';
}

function buildPricingCoverageCandidates(modelId: string): string[] {
  const candidates = new Set<string>();
  const add = (value?: string | null) => {
    if (!value) return;
    candidates.add(value);
  };

  add(modelId);
  const stripped = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  add(stripped);

  if (modelId.endsWith(':free')) {
    const withoutFree = modelId.slice(0, -5);
    add(withoutFree);
    add(withoutFree.includes('/') ? withoutFree.split('/').pop()! : withoutFree);
  }

  if (modelId.endsWith(':exacto')) {
    const withoutExacto = modelId.slice(0, -7);
    add(withoutExacto);
    add(withoutExacto.includes('/') ? withoutExacto.split('/').pop()! : withoutExacto);
  }

  if (modelId.includes('-thinking')) {
    const withoutThinking = modelId.replace('-thinking', '');
    add(withoutThinking);
    add(withoutThinking.includes('/') ? withoutThinking.split('/').pop()! : withoutThinking);

    const collapsedThinking = modelId.replace('-thinking-', '-');
    add(collapsedThinking);
    add(collapsedThinking.includes('/') ? collapsedThinking.split('/').pop()! : collapsedThinking);

    const instructVariant = modelId.replace('-thinking', '-instruct');
    add(instructVariant);
    add(instructVariant.includes('/') ? instructVariant.split('/').pop()! : instructVariant);
  }

  const bare = stripped;
  const namespace = modelId.includes('/') ? `${modelId.split('/')[0]}/` : '';
  const withoutDateSuffix = bare.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  add(withoutDateSuffix);
  if (namespace) add(`${namespace}${withoutDateSuffix}`);

  const gpt5Match = withoutDateSuffix.match(/^gpt-5(?:\.\d+)?(?:-(pro|mini|nano|chat(?:-latest)?|chat|codex(?:-mini|-max)?|codex))?$/);
  if (gpt5Match) {
    const variant = gpt5Match[1];
    const canonical = variant ? `gpt-5-${variant}` : 'gpt-5';
    add(canonical);
    if (namespace) add(`${namespace}${canonical}`);
    if (!variant || variant === 'chat' || variant === 'chat-latest') {
      add('gpt-5');
      if (namespace) add(`${namespace}gpt-5`);
    }
  }

  if (withoutDateSuffix === 'omni-moderation-latest') {
    add('omni-moderation-2024-09-26');
  }

  if (/^gpt-4o-mini-transcribe(?:-\d{4}-\d{2}-\d{2})?$/i.test(withoutDateSuffix)) {
    add('gpt-4o-mini-transcribe');
  }
  if (/^gpt-4o-transcribe(?:-\d{4}-\d{2}-\d{2})?$/i.test(withoutDateSuffix)) {
    add('gpt-4o-transcribe');
  }
  if (/^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/i.test(withoutDateSuffix)) {
    add('gpt-4o-mini-tts');
  }
  if (/^gpt-audio(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/i.test(withoutDateSuffix)) {
    const audioMatch = withoutDateSuffix.match(/^(gpt-audio(?:-mini)?)/i);
    if (audioMatch?.[1]) add(audioMatch[1].toLowerCase());
  }

  return Array.from(candidates);
}

function buildKnownPricingCoverageMap(repoRoot: string): Record<string, Record<string, unknown>> {
  const knownCoverage: Record<string, Record<string, unknown>> = {};

  const pricingFile = readRepoJsonFile(repoRoot, API_PRICING_SOURCE_FILE);
  const pricingModels = isPlainObjectRecord(pricingFile) && isPlainObjectRecord(pricingFile.models)
    ? pricingFile.models
    : null;
  if (pricingModels) {
    for (const [modelId, pricing] of Object.entries(pricingModels)) {
      knownCoverage[modelId] = isPlainObjectRecord(pricing) ? pricing : {};
    }
  }

  const routerModels = readRepoJsonFile(repoRoot, API_ROUTER_MODELS_SOURCE_FILE);
  const routerRows = isPlainObjectRecord(routerModels) && Array.isArray(routerModels.data)
    ? routerModels.data
    : Array.isArray(routerModels)
      ? routerModels
      : [];
  for (const row of routerRows) {
    if (!isPlainObjectRecord(row)) continue;
    const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
    if (!slug) continue;
    const pricing = row.endpoint && isPlainObjectRecord(row.endpoint)
      ? row.endpoint.pricing
      : row.pricing;
    if (!hasPositiveRouterPricing(pricing)) continue;
    knownCoverage[slug] = isPlainObjectRecord(pricing) ? pricing : { slug };
  }

  return knownCoverage;
}

function extractNumericPricingValues(pricingRecord: unknown): number[] {
  if (!isPlainObjectRecord(pricingRecord)) return [];
  return Object.entries(pricingRecord)
    .filter(([key]) => !['unit', 'source', 'updated_at'].includes(key))
    .map(([, value]) => typeof value === 'number' ? value : Number.parseFloat(String(value)))
    .filter((value) => Number.isFinite(value));
}

function hasKnownPricingCoverage(modelId: string, knownCoverage: Record<string, Record<string, unknown>>): boolean {
  return buildPricingCoverageCandidates(modelId).some((candidate) => Boolean(knownCoverage[candidate]));
}

function auditModelPricingCoverage(repoRoot: string): PricingCoverageAudit | null {
  const modelsFile = readRepoJsonFile(repoRoot, API_MODELS_SOURCE_FILE);
  const modelRows = isPlainObjectRecord(modelsFile) && Array.isArray(modelsFile.data)
    ? modelsFile.data
    : Array.isArray(modelsFile)
      ? modelsFile
      : [];
  if (modelRows.length === 0) return null;

  const knownCoverage = buildKnownPricingCoverageMap(repoRoot);
  const unresolvedModelIds: string[] = [];

  for (const row of modelRows) {
    if (!isPlainObjectRecord(row)) continue;
    const modelId = typeof row.id === 'string' ? row.id.trim() : '';
    if (!modelId || isFreePricingModelId(modelId)) continue;

    const pricingValues = extractNumericPricingValues(row.pricing);
    const hasPlaceholderPricing = !isPlainObjectRecord(row.pricing)
      || pricingValues.length === 0
      || pricingValues.every((value) => value === 0);
    if (!hasPlaceholderPricing) continue;
    if (hasKnownPricingCoverage(modelId, knownCoverage)) continue;

    unresolvedModelIds.push(modelId);
  }

  return {
    unresolvedCount: unresolvedModelIds.length,
    sampleModelIds: unresolvedModelIds.slice(0, 6),
  };
}

const SAFE_EXPERIMENTAL_DEPLOY_COMMAND = 'sudo systemctl restart anygpt-experimental';
const SAFE_PRODUCTION_DEPLOY_COMMAND = 'sudo systemctl restart anygpt.service';
const AUTO_RESTART_PRODUCTION_AFTER_REPAIR = parseBooleanEnv('CONTROL_PLANE_AUTO_RESTART_PRODUCTION', false);
const REDACTED_SECRET_PLACEHOLDER = '[redacted]';
const REDACTED_IP_PLACEHOLDER = '[redacted-ip]';
const MCP_CLIENT_NAME = 'anygpt-langgraph-control-plane';
const MCP_CLIENT_VERSION = '0.1.0';
const DEFAULT_LOG_TAIL_LINE_COUNT = parsePositiveIntegerEnv('CONTROL_PLANE_LOG_TAIL_LINES', 40, 4);
const MCP_INSPECTION_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_MCP_INSPECTION_TIMEOUT_MS', 8_000, 1_000);
const MCP_ACTION_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_MCP_ACTION_TIMEOUT_MS', 20_000, 1_000);
const MCP_MAX_TOOL_PAGES = 20;
const MCP_ACTION_OUTPUT_PREVIEW_MAX_CHARS = parsePositiveIntegerEnv('CONTROL_PLANE_MCP_ACTION_OUTPUT_MAX_CHARS', 2_400, 200);
const CODEQL_RESULT_FILE_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_CODEQL_RESULT_FILE_LIMIT', 4, 1);
const CODEQL_RESULT_LINE_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_CODEQL_RESULT_LINE_LIMIT', 12, 1);
const AI_AGENT_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_AI_AGENT_TIMEOUT_MS', 40_000, 5_000);
const AI_NOTES_AGENT_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_AI_NOTES_TIMEOUT_MS', 20_000, 1_000);
const API_FAMILY_AI_NOTES_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_API_FAMILY_AI_NOTES_TIMEOUT_MS', 45_000, 5_000);
const SURFACE_FAMILY_AI_NOTES_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_SURFACE_FAMILY_AI_NOTES_TIMEOUT_MS', 60_000, 5_000);
const CONTROL_PLANE_LANE_AI_NOTES_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_CONTROL_PLANE_AI_NOTES_TIMEOUT_MS', 60_000, 5_000);
const AI_AGENT_NOTE_LIMIT = 8;
const AI_AGENT_PAYLOAD_STRING_MAX_CHARS = parsePositiveIntegerEnv('CONTROL_PLANE_AI_MAX_STRING_CHARS', 2_000, 200);
const AI_AGENT_LOG_LINE_MAX_CHARS = parsePositiveIntegerEnv('CONTROL_PLANE_AI_LOG_LINE_MAX_CHARS', 2_400, 200);
const AI_AGENT_PAYLOAD_ARRAY_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_AI_ARRAY_LIMIT', 20, 2);
const AI_AGENT_PAYLOAD_OBJECT_KEY_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_AI_OBJECT_KEY_LIMIT', 24, 4);
const AI_AGENT_CONTEXT_NOTE_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_AI_CONTEXT_NOTE_LIMIT', 16, 2);
const AI_AGENT_SIGNAL_PAYLOAD_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_AI_SIGNAL_PAYLOAD_LIMIT', 20, 2);
const AI_CODE_EDIT_CANDIDATE_FILE_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_AI_CANDIDATE_FILE_LIMIT', 20, 2);
const AI_CODE_EDIT_CANDIDATE_PATH_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_AI_CANDIDATE_PATH_LIMIT', 32, 4);
const AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS = parsePositiveIntegerEnv('CONTROL_PLANE_AI_CANDIDATE_FILE_MAX_CHARS', 4_000, 400);
const AI_CODE_EDIT_PAYLOAD_STRING_MAX_CHARS = parsePositiveIntegerEnv('CONTROL_PLANE_AI_CODE_EDIT_MAX_STRING_CHARS', 4_000, 400);
const AI_CODE_EDIT_AGENT_PARALLELISM = parsePositiveIntegerEnv('CONTROL_PLANE_AI_CODE_EDIT_AGENT_PARALLELISM', 6, 1);
const CONTROL_PLANE_NOTE_HISTORY_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_NOTE_HISTORY_LIMIT', 120, 20);
const CONTROL_PLANE_TYPECHECK_COMMAND = 'bash ./bun.sh run -F anygpt-langgraph-control-plane typecheck';
const RESEARCH_SCOUT_AI_NOTES_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_RESEARCH_SCOUT_AI_NOTES_TIMEOUT_MS', 240_000, 5_000);
const RESEARCH_SCOUT_AI_PLANNER_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_RESEARCH_SCOUT_AI_PLANNER_TIMEOUT_MS', 240_000, 10_000);
const RESEARCH_SCOUT_PREFETCH_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_RESEARCH_SCOUT_PREFETCH_TIMEOUT_MS', 8_000, 1_000);
const RESEARCH_SCOUT_PREFETCH_CANDIDATE_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_RESEARCH_SCOUT_PREFETCH_CANDIDATE_LIMIT', 6, 1);
const RESEARCH_SCOUT_PREFETCH_TEXT_MAX_CHARS = parsePositiveIntegerEnv('CONTROL_PLANE_RESEARCH_SCOUT_PREFETCH_TEXT_MAX_CHARS', 40_000, 2_000);
const DEFAULT_HOMEPAGE_SURFACE_URL = normalizeHttpUrl(String(process.env.CONTROL_PLANE_HOMEPAGE_SURFACE_URL || 'http://127.0.0.1:3091').trim()) || 'http://127.0.0.1:3091';
const DEFAULT_UI_SURFACE_URL = normalizeHttpUrl(String(process.env.CONTROL_PLANE_UI_SURFACE_URL || 'http://127.0.0.1:3090').trim()) || 'http://127.0.0.1:3090';
const CODEQL_AUTORUN_ENABLED = parseBooleanEnv('CONTROL_PLANE_CODEQL_AUTORUN', true);
const GITHUB_CODEQL_SYNC_ENABLED = parseBooleanEnv('CONTROL_PLANE_GITHUB_CODEQL_SYNC', true);
const GITHUB_CODEQL_SYNC_REFRESH_MS = parsePositiveIntegerEnv('CONTROL_PLANE_GITHUB_CODEQL_SYNC_REFRESH_MS', 15 * 60 * 1000, 60_000);
const GITHUB_CODEQL_ALERT_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_GITHUB_CODEQL_ALERT_LIMIT', 12, 1);
const GITHUB_CODEQL_ANALYSIS_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_GITHUB_CODEQL_ANALYSIS_LIMIT', 5, 1);
const GITHUB_CODEQL_WORKFLOW_RUN_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_GITHUB_CODEQL_WORKFLOW_RUN_LIMIT', 3, 1);
const GITHUB_CODEQL_API_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_GITHUB_CODEQL_API_TIMEOUT_MS', 20_000, 1_000);
const GITHUB_DEPENDABOT_SYNC_ENABLED = parseBooleanEnv('CONTROL_PLANE_GITHUB_DEPENDABOT_SYNC', true);
const GITHUB_DEPENDABOT_SYNC_REFRESH_MS = parsePositiveIntegerEnv('CONTROL_PLANE_GITHUB_DEPENDABOT_SYNC_REFRESH_MS', 15 * 60 * 1000, 60_000);
const GITHUB_DEPENDABOT_ALERT_LIMIT = parsePositiveIntegerEnv('CONTROL_PLANE_GITHUB_DEPENDABOT_ALERT_LIMIT', 12, 1);
const CODEQL_REFRESH_MS = parsePositiveIntegerEnv('CONTROL_PLANE_CODEQL_REFRESH_MS', 30 * 60 * 1000, 60_000);
const CODEQL_SOURCE_FRESHNESS_REFRESH_MS = parsePositiveIntegerEnv('CONTROL_PLANE_CODEQL_SOURCE_FRESHNESS_REFRESH_MS', 500, 250);
const CODEQL_LOCK_POLL_MS = parsePositiveIntegerEnv('CONTROL_PLANE_CODEQL_LOCK_POLL_MS', 1_000, 100);
const CODEQL_LOCK_STALE_MS = parsePositiveIntegerEnv('CONTROL_PLANE_CODEQL_LOCK_STALE_MS', 25 * 60 * 1000, 5_000);
const CODEQL_LOCK_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_CODEQL_LOCK_TIMEOUT_MS', 30 * 60 * 1000, 60_000);
const REDIS_CLONE_CONNECT_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_REDIS_CLONE_CONNECT_TIMEOUT_MS', 15_000, 1_000);
const REDIS_CLONE_SCAN_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_REDIS_CLONE_SCAN_TIMEOUT_MS', 60_000, 1_000);
const REDIS_CLONE_COMMAND_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_REDIS_CLONE_COMMAND_TIMEOUT_MS', 30_000, 1_000);
const REPAIR_SMOKE_JOB_LIMIT = 2;
const REPAIR_SMOKE_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_REPAIR_SMOKE_TIMEOUT_MS', 120_000, 5_000);
const POST_REPAIR_VALIDATION_JOB_LIMIT = 2;
const POST_REPAIR_VALIDATION_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_POST_REPAIR_VALIDATION_TIMEOUT_MS', 600_000, 10_000);
const AUTO_RESTART_EXPERIMENTAL_AFTER_REPAIR = parseBooleanEnv('CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL', false);
const AUTO_RESTART_EXPERIMENTAL_REQUIRE_IDLE = parseBooleanEnv('CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL_REQUIRE_IDLE', true);
const EXPERIMENTAL_RESTART_CLIENT_INSPECTION_TIMEOUT_MS = parsePositiveIntegerEnv(
  'CONTROL_PLANE_EXPERIMENTAL_RESTART_CLIENT_INSPECTION_TIMEOUT_MS',
  4_000,
  500,
);
const DEFAULT_EXPERIMENTAL_API_PORT = 3310;
const CONTROL_PLANE_SIGNAL_FRESHNESS_WINDOW_MS = parsePositiveIntegerEnv('CONTROL_PLANE_SIGNAL_FRESHNESS_WINDOW_MS', 12 * 60 * 60 * 1000, 60_000);
const AUTONOMOUS_FULL_COVERAGE_SCOPES = ['repo', 'api', 'api-experimental', 'control-plane', 'repo-surface'] as const;
const EXPANSIVE_SCOPE_ALIASES = new Set(['all', 'everything', 'adaptive', '*']);
const API_FAMILY_SCOPES = new Set(['api', 'api-experimental', 'api-routing', 'api-runtime', 'api-data', 'api-platform']);
const REPO_SURFACE_FAMILY_SCOPES = new Set(['repo-surface', 'workspace-surface', 'homepage-surface', 'ui-surface']);

const EXPLICIT_SENSITIVE_KEYS = new Set([
  'apikey',
  'authorization',
  'cookie',
  'key',
  'password',
  'redispassword',
  'secret',
  'sourceip',
  'token',
  'xapikey',
]);

const SCOPE_COMMANDS: Record<string, { build?: string; test?: string }> = {
  repo: {
    build: 'bash ./bun.sh run build',
    test: 'bash ./bun.sh run test',
  },
  'repo-surface': {},
  'workspace-surface': {},
  'homepage-surface': {},
  'ui-surface': {},
  api: {
    build: API_EXPERIMENTAL_BUILD_COMMAND,
    test: API_EXPERIMENTAL_TEST_COMMAND,
  },
  'api-experimental': {
    build: API_EXPERIMENTAL_BUILD_COMMAND,
    test: API_EXPERIMENTAL_TEST_COMMAND,
  },
  'api-routing': {},
  'api-runtime': {},
  'api-data': {},
  'api-platform': {
    build: API_EXPERIMENTAL_BUILD_COMMAND,
    test: API_EXPERIMENTAL_TEST_COMMAND,
  },
  'control-plane': {
    build: 'bash ./bun.sh run -F anygpt-langgraph-control-plane build',
    test: 'bash ./bun.sh run -F anygpt-langgraph-control-plane typecheck',
  },
  'research-scout': {},
};

function hasScopeFamily(scopes: Iterable<string>, family: Set<string>): boolean {
  for (const scope of scopes) {
    if (family.has(String(scope || '').trim().toLowerCase())) return true;
  }
  return false;
}

function hasApiFamilyScope(scopes: Iterable<string>): boolean {
  return hasScopeFamily(scopes, API_FAMILY_SCOPES);
}

function hasRepoSurfaceFamilyScope(scopes: Iterable<string>): boolean {
  return hasScopeFamily(scopes, REPO_SURFACE_FAMILY_SCOPES);
}

function normalizeKeyName(key: string): string {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKeyName(key);
  if (!normalized) return false;
  if (EXPLICIT_SENSITIVE_KEYS.has(normalized)) return true;
  return normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('apikey')
    || normalized.endsWith('cookie')
    || normalized.endsWith('sourceip')
    || normalized.endsWith('clientip')
    || normalized.endsWith('remoteip');
}

function getRedactionPlaceholder(keyHint: string = ''): string {
  const normalized = normalizeKeyName(keyHint);
  if (normalized.endsWith('ip') || normalized.includes('ipaddress')) {
    return REDACTED_IP_PLACEHOLDER;
  }
  return REDACTED_SECRET_PLACEHOLDER;
}

function redactSensitiveText(text: string): string {
  return String(text)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, REDACTED_IP_PLACEHOLDER)
    .replace(/\bAIza[0-9A-Za-z\-_]{20,}\b/g, REDACTED_SECRET_PLACEHOLDER)
    .replace(/\bsk-[A-Za-z0-9\-_]{12,}\b/g, REDACTED_SECRET_PLACEHOLDER)
    .replace(/([a-z]+:\/\/[^@\s:]+:)[^@\s]+@/gi, `$1${REDACTED_SECRET_PLACEHOLDER}@`)
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi, `$1${REDACTED_SECRET_PLACEHOLDER}`)
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&\s]+/gi, `$1${REDACTED_SECRET_PLACEHOLDER}`)
    .replace(/((?:api[_-]?key|token|password|secret|authorization|cookie)\s*[:=]\s*)(["']?)([^"',\s]+)(\2)/gi, (_match, prefix: string, quote: string) => {
      const wrappedPlaceholder = quote
        ? `${quote}${REDACTED_SECRET_PLACEHOLDER}${quote}`
        : REDACTED_SECRET_PLACEHOLDER;
      return `${prefix}${wrappedPlaceholder}`;
    });
}

function redactSensitiveValue(value: unknown, keyHint: string = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry, keyHint));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
        if (isSensitiveKey(key)) {
          return [key, getRedactionPlaceholder(key)];
        }

        return [key, redactSensitiveValue(nestedValue, key)];
      }),
    );
  }

  if (typeof value === 'string') {
    if (isSensitiveKey(keyHint)) {
      return getRedactionPlaceholder(keyHint);
    }
    return redactSensitiveText(value);
  }

  return value;
}

function sanitizeLogLine(line: string): string {
  const trimmed = String(line || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    return truncateTextMiddle(
      JSON.stringify(redactSensitiveValue(parsed)),
      AI_AGENT_LOG_LINE_MAX_CHARS,
    );
  } catch {
    return truncateTextMiddle(redactSensitiveText(trimmed), AI_AGENT_LOG_LINE_MAX_CHARS);
  }
}

function truncateTextMiddle(text: string, maxChars: number): string {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxChars) return normalized;

  const marker = ` …[truncated ${normalized.length - maxChars} chars]… `;
  const availableChars = maxChars - marker.length;
  if (availableChars <= 32) {
    return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  const headChars = Math.ceil(availableChars / 2);
  const tailChars = Math.floor(availableChars / 2);
  return `${normalized.slice(0, headChars)}${marker}${normalized.slice(normalized.length - tailChars)}`;
}

function compactStringArrayForAi(
  values: string[],
  maxItems: number,
  maxChars: number = AI_AGENT_PAYLOAD_STRING_MAX_CHARS,
): string[] {
  return values
    .slice(-maxItems)
    .map((value) => truncateTextMiddle(redactSensitiveText(value), maxChars))
    .filter(Boolean);
}

function compactUnknownForAi(
  value: unknown,
  options: {
    maxStringChars?: number;
    maxArrayItems?: number;
    maxObjectKeys?: number;
    maxDepth?: number;
  } = {},
  depth: number = 0,
): unknown {
  const maxStringChars = options.maxStringChars ?? AI_AGENT_PAYLOAD_STRING_MAX_CHARS;
  const maxArrayItems = options.maxArrayItems ?? AI_AGENT_PAYLOAD_ARRAY_LIMIT;
  const maxObjectKeys = options.maxObjectKeys ?? AI_AGENT_PAYLOAD_OBJECT_KEY_LIMIT;
  const maxDepth = options.maxDepth ?? 4;

  const sanitizeAiPayloadText = (input: string): string => {
    const normalized = String(input || '');
    if (!normalized) return normalized;
    if (normalized.length > 20_000 && /<svg[\s\S]*\bdata:image\/[a-z0-9.+-]+;base64,/i.test(normalized)) {
      return '[svg asset with embedded image data omitted from AI payload]';
    }
    return normalized.replace(/\bdata:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[embedded image data omitted]');
  };

  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return truncateTextMiddle(redactSensitiveText(sanitizeAiPayloadText(value)), maxStringChars);
  }

  if (Array.isArray(value)) {
    const sliced = value.slice(0, maxArrayItems);
    if (depth >= maxDepth) {
      return sliced.map((entry) => truncateTextMiddle(
        sanitizeAiPayloadText(JSON.stringify(redactSensitiveValue(entry))),
        maxStringChars,
      ));
    }
    return sliced.map((entry) => compactUnknownForAi(entry, options, depth + 1));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, maxObjectKeys);
    if (depth >= maxDepth) {
      return Object.fromEntries(
        entries.map(([key, entryValue]) => [
          key,
          truncateTextMiddle(sanitizeAiPayloadText(JSON.stringify(redactSensitiveValue(entryValue))), maxStringChars),
        ]),
      );
    }
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, compactUnknownForAi(entryValue, options, depth + 1)]),
    );
  }

  return truncateTextMiddle(String(value), maxStringChars);
}

function uniqueScopes(scopes: string[]): string[] {
  const normalized = scopes
    .map((scope) => String(scope || '').trim().toLowerCase())
    .filter(Boolean);
  const expanded: string[] = [];

  for (const scope of (normalized.length > 0 ? normalized : ['repo'])) {
    if (EXPANSIVE_SCOPE_ALIASES.has(scope)) {
      expanded.push(...AUTONOMOUS_FULL_COVERAGE_SCOPES);
      continue;
    }
    expanded.push(scope);
  }

  return Array.from(new Set(expanded));
}

function resolveEffectiveScopes(
  state: Pick<ControlPlaneState, 'scopes' | 'autonomous' | 'continuous'> & Partial<Pick<ControlPlaneState, 'effectiveScopes' | 'scopeExpansionReason' | 'scopeExpansionMode'>>,
): { scopes: string[]; reason: string } {
  const requestedScopes = uniqueScopes(state.scopes);
  const existingEffectiveScopes = Array.isArray(state.effectiveScopes) && state.effectiveScopes.length > 0
    ? uniqueScopes(state.effectiveScopes)
    : [];
  const effectiveScopes = [...requestedScopes];
  const addedScopes: string[] = [];
  const scopeExpansionMode = state.scopeExpansionMode === 'locked' ? 'locked' : 'adaptive';

  for (const scope of existingEffectiveScopes) {
    if (!effectiveScopes.includes(scope)) {
      effectiveScopes.push(scope);
    }
  }

  if (scopeExpansionMode !== 'locked' && state.autonomous && state.continuous) {
    for (const scope of AUTONOMOUS_FULL_COVERAGE_SCOPES) {
      if (!effectiveScopes.includes(scope)) {
        effectiveScopes.push(scope);
        addedScopes.push(scope);
      }
    }
  }

  const reason = addedScopes.length > 0
    ? `Continuous autonomous mode widened scope coverage from ${requestedScopes.join(', ')} to ${uniqueScopes(effectiveScopes).join(', ')} so the control plane keeps checking repo-wide build/test health while preserving targeted experimental lanes.`
    : scopeExpansionMode === 'locked'
      ? `Adaptive scope expansion is locked; keeping the runner on ${requestedScopes.join(', ')} for coordinated multi-runner coverage.`
    : '';

  return {
    scopes: uniqueScopes(effectiveScopes),
    reason,
  };
}

function getEffectiveScopes(
  state: Pick<ControlPlaneState, 'scopes' | 'autonomous' | 'continuous'> & Partial<Pick<ControlPlaneState, 'effectiveScopes' | 'scopeExpansionReason' | 'scopeExpansionMode'>>,
): string[] {
  return resolveEffectiveScopes(state).scopes;
}

function shouldUseAggressiveAutonomousPlanning(
  state: Pick<ControlPlaneState, 'autonomousEditEnabled' | 'autonomous' | 'continuous' | 'approvalMode'>,
): boolean {
  return state.autonomousEditEnabled
    && state.autonomous
    && state.continuous
    && state.approvalMode === 'auto';
}

function extractNewestSignalTimestampMs(value: string): number {
  const matches = String(value || '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) || [];
  let newest = 0;
  for (const match of matches) {
    const parsed = Date.parse(match);
    if (Number.isFinite(parsed) && parsed > newest) {
      newest = parsed;
    }
  }
  return newest;
}

function isFreshSignalText(value: string, maxAgeMs: number = CONTROL_PLANE_SIGNAL_FRESHNESS_WINDOW_MS): boolean {
  const newestTimestamp = extractNewestSignalTimestampMs(value);
  if (!newestTimestamp) return true;
  return (Date.now() - newestTimestamp) <= maxAgeMs;
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).filter((entry) => entry.trim().length > 0)
    : [];
}

function coerceStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [String(key), String(entry ?? '')])
      .filter(([key]) => key.trim().length > 0),
  );
}

function sanitizeMcpServer(config: LoadedMcpServerConfig): McpServer {
  return McpServerSchema.parse({
    name: config.name,
    command: config.command,
    args: config.args,
    type: config.type,
    disabled: config.disabled,
    alwaysAllow: config.alwaysAllow,
    disabledTools: config.disabledTools,
    envKeys: Object.keys(config.env).sort(),
  });
}

function appendUniqueNotes(existingNotes: string[], additionalNotes: string[]): string[] {
  const merged = [...existingNotes];
  const seen = new Set(existingNotes.map((note) => note.trim()).filter(Boolean));

  for (const note of additionalNotes) {
    const trimmed = String(note || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }

  return merged.slice(-CONTROL_PLANE_NOTE_HISTORY_LIMIT);
}

function resolveApprovalDecision(decision: unknown): { approved: boolean; message: string } {
  if (typeof decision === 'boolean') {
    return {
      approved: decision,
      message: decision ? 'Manual approval granted.' : 'Manual approval denied.',
    };
  }

  if (decision && typeof decision === 'object') {
    const objectDecision = decision as Record<string, unknown>;
    if (typeof objectDecision.approved === 'boolean') {
      return {
        approved: objectDecision.approved,
        message: objectDecision.approved ? 'Manual approval granted.' : 'Manual approval denied.',
      };
    }

    const stringAction = typeof objectDecision.action === 'string'
      ? objectDecision.action
      : typeof objectDecision.resume === 'string'
        ? objectDecision.resume
        : '';
    if (stringAction) {
      return resolveApprovalDecision(stringAction);
    }
  }

  const normalized = typeof decision === 'string' ? decision.trim().toLowerCase() : '';
  if (['approve', 'approved', 'yes', 'y', 'true', 'continue', 'resume', 'run'].includes(normalized)) {
    return { approved: true, message: 'Manual approval granted.' };
  }
  if (['deny', 'denied', 'no', 'n', 'false', 'stop', 'abort', 'cancel', 'reject'].includes(normalized)) {
    return { approved: false, message: 'Manual approval denied.' };
  }

  return {
    approved: false,
    message: `Manual approval denied because the resume value was not recognized: ${JSON.stringify(decision)}`,
  };
}

function buildApprovalRequests(state: ControlPlaneState): ApprovalRequest[] {
  const approvals: ApprovalRequest[] = [];
  const seen = new Set<string>();
  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  const governanceGateResult = resolveStateGovernanceGateResult(state);

  if (!evaluationGateResult.blocksExecution && !governanceGateResult.blocksExecution) {
    for (const job of state.jobs) {
      if (job.kind === 'test' && (job.target === 'api' || job.target === 'api-experimental')) {
        const approvalId = `redis-clone-${job.target}`;
        if (!seen.has(approvalId)) {
          seen.add(approvalId);
          approvals.push(ApprovalRequestSchema.parse({
            id: approvalId,
            title: `Approve Redis/Dragonfly clone for ${job.target}`,
            reason: `Running ${job.title} clones Redis/Dragonfly DB ${CONTROL_PLANE_SOURCE_REDIS_DB} into experimental DB ${CONTROL_PLANE_TARGET_REDIS_DB} before execution.`,
          }));
        }
      }

      if (job.kind === 'deploy') {
        const approvalId = `deploy-${job.id}`;
        if (!seen.has(approvalId)) {
          seen.add(approvalId);
          approvals.push(ApprovalRequestSchema.parse({
            id: approvalId,
            title: `Approve deploy command for ${job.target}`,
            reason: `Execute deploy command: ${job.command}`,
          }));
        }
      }
    }
  }

  if (
    !evaluationGateResult.blocksAutonomousEdits
    && !governanceGateResult.blocksAutonomousEdits
    && state.autonomousEditEnabled
    && state.autonomousEditReviewDecision === 'approved'
    && state.proposedEdits.length > 0
  ) {
    approvals.push(ApprovalRequestSchema.parse({
      id: 'autonomous-code-edits',
      title: `Approve ${state.proposedEdits.length} autonomous code edit(s)`,
      reason: state.proposedEdits
        .map((edit) => `${edit.type} ${edit.path}: ${edit.reason}`)
        .join(' | '),
    }));
  }

  for (const action of state.plannedMcpActions) {
    if (action.alwaysAllow && action.risk === 'low') {
      continue;
    }

    const approvalId = `mcp-action-${action.id}`;
    if (seen.has(approvalId)) {
      continue;
    }
    seen.add(approvalId);
    approvals.push(ApprovalRequestSchema.parse({
      id: approvalId,
      title: `Approve MCP tool ${action.server}.${action.tool}`,
      reason: `${action.title}: ${action.reason}`,
    }));
  }

  return approvals;
}

export function resolveControlPlaneCheckpointPath(repoRoot: string, override?: string): string {
  const configuredPath = String(override || process.env.CONTROL_PLANE_CHECKPOINT_PATH || CONTROL_PLANE_CHECKPOINTS_FILE).trim();
  return path.resolve(repoRoot, configuredPath || CONTROL_PLANE_CHECKPOINTS_FILE);
}

function resolveControlPlaneRuntimeDir(repoRoot: string): string {
  const configured = String(process.env.CONTROL_PLANE_RUNTIME_DIR || '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(repoRoot, 'apps', 'langgraph-control-plane', '.control-plane');
}

function normalizeOpenAiCompatibleBaseUrl(rawBaseUrl: string): string {
  const trimmed = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function uniqueNormalizedStrings(values: Array<string | undefined | null>): string[] {
  const items = new Set<string>();
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) items.add(normalized);
  }
  return [...items.values()];
}

function normalizePromptChannel(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildLangSmithPromptReference(promptIdentifier: string, commitOrTag?: string): string {
  const normalizedPromptIdentifier = String(promptIdentifier || '').trim();
  const normalizedCommitOrTag = String(commitOrTag || '').trim();
  if (!normalizedPromptIdentifier) return '';
  return normalizedCommitOrTag ? `${normalizedPromptIdentifier}:${normalizedCommitOrTag}` : normalizedPromptIdentifier;
}

function inferPromptChannelFromReference(reference: string): string {
  const trimmed = String(reference || '').trim();
  const colonIndex = trimmed.lastIndexOf(':');
  if (colonIndex <= 0) return '';

  const candidate = normalizePromptChannel(trimmed.slice(colonIndex + 1));
  if (!candidate || /^[a-f0-9]{12,}$/i.test(candidate)) return '';
  return candidate;
}

function getDefaultControlPlanePromptBundle(): ControlPlanePromptBundle {
  return ControlPlanePromptBundleSchema.parse(DEFAULT_CONTROL_PLANE_PROMPT_BUNDLE);
}

function buildControlPlanePromptManifest(
  promptIdentifier: string,
  bundle: ControlPlanePromptBundle,
): Record<string, unknown> {
  const bundleManifest = {
    _type: 'anygpt_control_plane_prompt_bundle',
    version: 1,
    prompts: {
      planner: { role: 'system', content: bundle.planner },
      build: { role: 'system', content: bundle.build },
      quality: { role: 'system', content: bundle.quality },
      deploy: { role: 'system', content: bundle.deploy },
      autonomousEdit: { role: 'system', content: bundle.autonomousEdit },
    },
    metadata: {
      source: 'anygpt-langgraph-control-plane',
      promptIdentifier,
    },
  };

  return {
    lc: 1,
    type: 'constructor',
    id: ['langchain', 'prompts', 'prompt', 'PromptTemplate'],
    kwargs: {
      input_variables: [],
      template_format: 'f-string',
      template: JSON.stringify(bundleManifest, null, 2),
    },
  };
}

function extractPromptText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (!value || typeof value !== 'object') return undefined;

  const candidate = value as Record<string, unknown>;
  const candidateKwargs = candidate.kwargs && typeof candidate.kwargs === 'object'
    ? candidate.kwargs as Record<string, unknown>
    : null;
  if (typeof candidate.content === 'string' && candidate.content.trim()) {
    return candidate.content.trim();
  }
  if (typeof candidate.prompt === 'string' && candidate.prompt.trim()) {
    return candidate.prompt.trim();
  }
  if (typeof candidate.template === 'string' && candidate.template.trim()) {
    return candidate.template.trim();
  }
  if (candidateKwargs) {
    if (typeof candidateKwargs.content === 'string' && candidateKwargs.content.trim()) {
      return candidateKwargs.content.trim();
    }
    if (typeof candidateKwargs.prompt === 'string' && candidateKwargs.prompt.trim()) {
      return candidateKwargs.prompt.trim();
    }
    if (typeof candidateKwargs.template === 'string' && candidateKwargs.template.trim()) {
      return candidateKwargs.template.trim();
    }
  }
  return undefined;
}

function buildLegacyControlPlanePromptBundle(sharedPrompt: string): ControlPlanePromptBundle {
  const defaultBundle = getDefaultControlPlanePromptBundle();
  const prefix = sharedPrompt.trim();
  return ControlPlanePromptBundleSchema.parse({
    planner: `${prefix}\n\n${defaultBundle.planner}`,
    build: `${prefix}\n\n${defaultBundle.build}`,
    quality: `${prefix}\n\n${defaultBundle.quality}`,
    deploy: `${prefix}\n\n${defaultBundle.deploy}`,
    autonomousEdit: `${prefix}\n\n${defaultBundle.autonomousEdit}`,
  });
}

function extractControlPlanePromptBundle(source: unknown): ControlPlanePromptBundle | null {
  if (!source || typeof source !== 'object') return null;

  const candidate = source as Record<string, unknown>;
  const promptContainer = candidate.prompts && typeof candidate.prompts === 'object'
    ? candidate.prompts as Record<string, unknown>
    : candidate;

  const bundleCandidate = {
    planner: extractPromptText(promptContainer.planner),
    build: extractPromptText(promptContainer.build),
    quality: extractPromptText(promptContainer.quality),
    deploy: extractPromptText(promptContainer.deploy),
    autonomousEdit: extractPromptText(promptContainer.autonomousEdit),
  };

  if (Object.values(bundleCandidate).every((value) => typeof value === 'string' && value.trim().length > 0)) {
    return ControlPlanePromptBundleSchema.parse(bundleCandidate);
  }

  const sharedPrompt = extractPromptText(candidate);
  if (sharedPrompt) {
    const trimmedSharedPrompt = sharedPrompt.trim();
    if (
      (trimmedSharedPrompt.startsWith('{') && trimmedSharedPrompt.endsWith('}'))
      || (trimmedSharedPrompt.startsWith('[') && trimmedSharedPrompt.endsWith(']'))
    ) {
      try {
        const parsedSharedPrompt = JSON.parse(trimmedSharedPrompt);
        const nestedBundle = extractControlPlanePromptBundle(parsedSharedPrompt);
        if (nestedBundle) return nestedBundle;
      } catch {
        // Fall through to legacy shared-prompt handling.
      }
    }

    return buildLegacyControlPlanePromptBundle(sharedPrompt);
  }

  return null;
}

function extractControlPlanePromptBundleFromCommit(commit: any): ControlPlanePromptBundle | null {
  if (!commit || typeof commit !== 'object') return null;

  const manifest = typeof commit?.manifest === 'object' && commit.manifest
    ? (typeof (commit.manifest as any).object === 'object' && (commit.manifest as any).object
        ? (commit.manifest as any).object
        : commit.manifest)
    : (typeof commit?.object === 'object' && commit.object ? commit.object : null);

  return extractControlPlanePromptBundle(manifest);
}

function extractPromptMetadataFromCommit(commit: any): Record<string, unknown> {
  if (!commit || typeof commit !== 'object') return {};

  const manifest = typeof commit?.manifest === 'object' && commit.manifest
    ? (typeof (commit.manifest as any).object === 'object' && (commit.manifest as any).object
        ? (commit.manifest as any).object
        : commit.manifest)
    : (typeof commit?.object === 'object' && commit.object ? commit.object : null);

  if (!manifest || typeof manifest !== 'object') return {};

  const metadata = (manifest as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return { ...(metadata as Record<string, unknown>) };
}

function extractPromptChannelsFromCommit(commit: any): string[] {
  const metadata = extractPromptMetadataFromCommit(commit);
  return uniqueNormalizedStrings([
    ...(Array.isArray((metadata as any)?.channels)
      ? ((metadata as any).channels as unknown[]).map((entry) => String(entry || '').trim())
      : []),
    typeof (metadata as any)?.channel === 'string' ? String((metadata as any).channel).trim() : '',
  ]);
}

function extractPromptCommitHash(commit: any): string {
  return String(commit?.commit_hash || commit?.commitHash || '').trim();
}

function buildControlPlaneObservabilityTags(
  state: Pick<ControlPlaneState, 'scopes' | 'effectiveScopes' | 'scopeExpansionReason' | 'scopeExpansionMode' | 'autonomous' | 'continuous' | 'promptIdentifier' | 'selectedPromptReference' | 'selectedPromptSource' | 'selectedPromptChannel' | 'governanceProfile' | 'evaluationGatePolicy'>,
  datasetNames: string[] = [],
): string[] {
  return uniqueNormalizedStrings([
    ...getEffectiveScopes(state).map((scope) => `scope:${scope}`),
    `autonomous:${state.autonomous ? 'true' : 'false'}`,
    `prompt_identifier:${state.promptIdentifier}`,
    state.selectedPromptReference ? `prompt_ref:${state.selectedPromptReference}` : undefined,
    state.selectedPromptSource ? `prompt_source:${state.selectedPromptSource}` : undefined,
    state.selectedPromptChannel ? `prompt_channel:${state.selectedPromptChannel}` : undefined,
    state.governanceProfile ? `governance_profile:${state.governanceProfile}` : undefined,
    `eval_gate_mode:${state.evaluationGatePolicy.mode}`,
    `eval_gate_target:${state.evaluationGatePolicy.target}`,
    ...datasetNames.map((datasetName) => `eval_dataset:${datasetName}`),
  ]);
}

function buildControlPlaneObservabilityMetadata(
  state: ControlPlaneState,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  const governanceGateResult = resolveStateGovernanceGateResult(state);
  const { scopes: effectiveScopes, reason: scopeExpansionReason } = resolveEffectiveScopes(state);
  return {
    source: 'anygpt-langgraph-control-plane',
    goal: state.goal,
    scopes: effectiveScopes,
    requested_scopes: uniqueScopes(state.scopes),
    scope_expansion_mode: state.scopeExpansionMode,
    scope_expansion_reason: scopeExpansionReason || undefined,
    thread_id: state.threadId,
    autonomous: state.autonomous,
    autonomous_edit_enabled: state.autonomousEditEnabled,
    prompt_identifier: state.promptIdentifier,
    prompt_selected_ref: state.selectedPromptReference || undefined,
    prompt_selected_channel: state.selectedPromptChannel || undefined,
    prompt_source: state.selectedPromptSource,
    prompt_commit_hash: state.selectedPromptCommitHash || undefined,
    prompt_rollback_reference: state.promptRollbackReference || undefined,
    prompt_sync_channel: state.promptSyncChannel || undefined,
    prompt_promote_channel: state.promptPromoteChannel || undefined,
    governance_profile: state.governanceProfile,
    evaluation_gate_status: evaluationGateResult.status,
    governance_gate_status: governanceGateResult.status,
    experimental_api_base_url: state.experimentalApiBaseUrl,
    experimental_service_name: state.experimentalServiceName,
    repair_session_id: state.repairSessionManifest?.sessionId || undefined,
    repair_status: state.repairStatus,
    repair_touched_paths: getRepairTouchedPaths(state),
    repair_rollback_status: state.repairSessionManifest?.rollbackStatus || undefined,
    post_repair_validation_status: state.postRepairValidationStatus,
    experimental_restart_status: state.experimentalRestartStatus,
    ...extra,
  };
}

export function resolveControlPlaneAiConfig(): ControlPlaneAiConfig {
  const explicitBaseUrl = normalizeOpenAiCompatibleBaseUrl(String(process.env.CONTROL_PLANE_AI_BASE_URL || '').trim());
  const explicitApiKey = String(process.env.CONTROL_PLANE_AI_API_KEY || '').trim();
  const explicitModel = String(process.env.CONTROL_PLANE_AI_MODEL || '').trim();
  const configuredReasoningEffort = String(
    process.env.CONTROL_PLANE_AI_REASONING_EFFORT
    || process.env.ANYGPT_REASONING_EFFORT
    || process.env.OPENAI_REASONING_EFFORT
    || '',
  ).trim();

  const parsedTemperature = Number(process.env.CONTROL_PLANE_AI_TEMPERATURE || '0.2');
  const temperature = Number.isFinite(parsedTemperature) ? parsedTemperature : 0.2;

  if (explicitBaseUrl && explicitApiKey) {
    return {
      enabled: true,
      baseUrl: explicitBaseUrl,
      apiKey: explicitApiKey,
      model: explicitModel || String(process.env.ANYGPT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4',
      temperature,
      reasoningEffort: configuredReasoningEffort || undefined,
      source: 'CONTROL_PLANE_AI_BASE_URL/API_KEY (+ optional model override)',
    };
  }

  const anygptApiKey = String(process.env.ANYGPT_API_KEY || '').trim();
  const anygptBaseUrl = normalizeOpenAiCompatibleBaseUrl(
    String(
      process.env.CONTROL_PLANE_ANYGPT_API_BASE_URL
      || process.env.ANYGPT_API_BASE_URL
      || process.env.OPENAI_BASE_URL
      || 'http://127.0.0.1:3310',
    ).trim(),
  );
  const anygptModel = explicitModel || String(process.env.ANYGPT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4').trim();

  if (anygptApiKey && anygptBaseUrl && anygptModel) {
    return {
      enabled: true,
      baseUrl: anygptBaseUrl,
      apiKey: anygptApiKey,
      model: anygptModel,
      temperature,
      reasoningEffort: configuredReasoningEffort || undefined,
      source: explicitModel ? 'CONTROL_PLANE_AI_MODEL + ANYGPT_API_* / OPENAI_*' : 'ANYGPT_API_* / OPENAI_*',
    };
  }

  const fallbackKeyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'api', 'keys.json');
  let fileBackedApiKey = '';
  if (fs.existsSync(fallbackKeyPath)) {
    try {
      const parsedKeys = JSON.parse(fs.readFileSync(fallbackKeyPath, 'utf8')) as Record<string, any>;
      for (const [candidateKey, entry] of Object.entries(parsedKeys)) {
        if (
          typeof candidateKey === 'string'
          && candidateKey.startsWith('test-key-for-automated-testing-')
          && entry
          && typeof entry === 'object'
          && entry.role !== 'disabled'
        ) {
          fileBackedApiKey = candidateKey;
          break;
        }
      }
    } catch {
      fileBackedApiKey = '';
    }
  }

  if (fileBackedApiKey) {
    return {
      enabled: true,
      baseUrl: anygptBaseUrl,
      apiKey: fileBackedApiKey,
      model: anygptModel,
      temperature,
      reasoningEffort: configuredReasoningEffort || undefined,
      source: explicitModel ? 'CONTROL_PLANE_AI_MODEL + apps/api/keys.json fallback' : 'apps/api/keys.json fallback',
    };
  }

  return {
    enabled: false,
    baseUrl: anygptBaseUrl,
    apiKey: '',
    model: anygptModel,
    temperature,
    reasoningEffort: configuredReasoningEffort || undefined,
    source: '',
  };
}

function extractAssistantTextFromChatCompletionPayload(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item: any) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractJsonObjectFromText(text: string): string | undefined {
  const raw = String(text || '').trim();
  if (!raw) return undefined;

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : raw;
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    return candidate;
  }

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }

  return undefined;
}

function loadRuntimeAutonomousEditPlanOverride(
  state: ControlPlaneState,
): { plan: z.infer<typeof AutonomousEditPlanSchema> | null; source: string; error?: string } {
  const overrideFile = String(process.env.CONTROL_PLANE_AUTONOMOUS_EDIT_PLAN_FILE || '').trim();
  const inlineOverride = String(process.env.CONTROL_PLANE_AUTONOMOUS_EDIT_PLAN || '').trim();

  if (!overrideFile && !inlineOverride) {
    return { plan: null, source: '' };
  }

  let raw = '';
  let source = '';
  try {
    if (overrideFile) {
      const resolvedPath = path.resolve(state.repoRoot, overrideFile);
      raw = fs.readFileSync(resolvedPath, 'utf8');
      source = path.relative(state.repoRoot, resolvedPath) || overrideFile;
    } else {
      raw = inlineOverride;
      source = 'CONTROL_PLANE_AUTONOMOUS_EDIT_PLAN';
    }

    const parsed = AutonomousEditPlanSchema.parse(JSON.parse(raw));
    return {
      plan: AutonomousEditPlanSchema.parse({
        summary: parsed.summary || `Runtime autonomous edit plan loaded from ${source}`,
        edits: parsed.edits.slice(0, state.maxEditActions),
      }),
      source,
    };
  } catch (error: any) {
    return {
      plan: null,
      source,
      error: redactSensitiveText(error?.message || String(error)),
    };
  }
}

function getControlPlaneSemanticMemoryNamespace(state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>): string[] {
  const projectName = String(state.langSmithProjectName || 'anygpt-control-plane-autonomous').trim() || 'anygpt-control-plane-autonomous';
  const governanceProfile = String(state.governanceProfile || 'experimental').trim() || 'experimental';
  return ['control-plane', 'semantic-memory', projectName, governanceProfile];
}

const SEMANTIC_MEMORY_QUERY_SOURCE_LIMIT = 18;
const SEMANTIC_MEMORY_QUERY_TOKEN_LIMIT = 24;
const SEMANTIC_MEMORY_READ_LIMIT = 8;
const SEMANTIC_MEMORY_SEARCH_WINDOW = 16;
const SEMANTIC_MEMORY_WRITE_LIMIT = 6;
const SEMANTIC_MEMORY_MEMORY_MAX_CHARS = 280;
const SEMANTIC_MEMORY_SIGNAL_SIGNATURE_MAX_CHARS = 320;
const SEMANTIC_MEMORY_RESOLUTION_MAX_CHARS = 220;
const SEMANTIC_MEMORY_METADATA_MAX_CHARS = 96;
const SEMANTIC_MEMORY_KEYWORD_LIMIT = 16;
const SEMANTIC_MEMORY_QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'with',
]);

function normalizeSemanticMemorySummary(value: unknown, maxChars: number): string {
  const normalized = redactSensitiveText(String(value || '').replace(/\s+/g, ' ').trim());
  if (!normalized) return '';
  return truncateTextMiddle(normalized, maxChars);
}

function tokenizeSemanticMemoryText(value: unknown): string[] {
  const normalized = normalizeSemanticMemorySummary(value, 640)
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_:/.-]+/g, ' ');
  if (!normalized) return [];

  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !SEMANTIC_MEMORY_QUERY_STOP_WORDS.has(token));
}

function collectSemanticMemoryKeywords(values: unknown[], limit: number = SEMANTIC_MEMORY_KEYWORD_LIMIT): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    for (const token of tokenizeSemanticMemoryText(value)) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => (
      right[1] - left[1]
      || right[0].length - left[0].length
      || left[0].localeCompare(right[0])
    ))
    .slice(0, limit)
    .map(([token]) => token);
}

function buildSemanticMemoryQuery(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'recentAutonomousLearningNotes'>,
): string {
  const sources = [
    ...state.repairSignals,
    ...state.improvementSignals,
    ...state.recentAutonomousLearningNotes,
  ]
    .map((entry) => normalizeSemanticMemorySummary(entry, 180))
    .filter(Boolean)
    .slice(-SEMANTIC_MEMORY_QUERY_SOURCE_LIMIT);

  const keywords = collectSemanticMemoryKeywords(sources, SEMANTIC_MEMORY_QUERY_TOKEN_LIMIT);
  return [...keywords, ...sources.slice(-6)]
    .slice(0, SEMANTIC_MEMORY_QUERY_TOKEN_LIMIT)
    .join(' | ')
    .trim();
}

function dedupeSemanticMemoryNotes(
  notes: Array<z.infer<typeof SemanticMemoryNoteSchema>>,
): Array<z.infer<typeof SemanticMemoryNoteSchema>> {
  const uniqueNotes: Array<z.infer<typeof SemanticMemoryNoteSchema>> = [];
  const seen = new Set<string>();

  for (const note of notes) {
    const identity = normalizeSemanticMemorySummary(note.memory, SEMANTIC_MEMORY_MEMORY_MAX_CHARS).toLowerCase();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    uniqueNotes.push(note);
    if (uniqueNotes.length >= SEMANTIC_MEMORY_READ_LIMIT) break;
  }

  return uniqueNotes;
}

function buildSemanticMemoryPayload(
  memory: string,
  metadata?: { signalSignature?: string; failureClass?: string; resolution?: string; source?: string },
  existingValue?: Record<string, any> | null,
): Record<string, any> {
  const now = new Date().toISOString();
  const normalizedMemory = normalizeSemanticMemorySummary(memory, SEMANTIC_MEMORY_MEMORY_MAX_CHARS);
  const failureClass = normalizeSemanticMemorySummary(metadata?.failureClass, SEMANTIC_MEMORY_METADATA_MAX_CHARS) || 'general';
  const signalSignature = normalizeSemanticMemorySummary(metadata?.signalSignature, SEMANTIC_MEMORY_SIGNAL_SIGNATURE_MAX_CHARS);
  const resolution = normalizeSemanticMemorySummary(metadata?.resolution, SEMANTIC_MEMORY_RESOLUTION_MAX_CHARS);
  const source = normalizeSemanticMemorySummary(metadata?.source, SEMANTIC_MEMORY_METADATA_MAX_CHARS) || 'runner-learning';
  const signalKeywords = Array.from(new Set([
    ...(
      Array.isArray(existingValue?.signalKeywords)
        ? existingValue.signalKeywords.map((entry: unknown) => String(entry || '').trim()).filter(Boolean)
        : []
    ),
    ...collectSemanticMemoryKeywords([normalizedMemory, signalSignature, resolution, failureClass], SEMANTIC_MEMORY_KEYWORD_LIMIT),
  ])).slice(0, SEMANTIC_MEMORY_KEYWORD_LIMIT);
  const previousObservationCount = Math.max(0, Math.floor(Number(existingValue?.observationCount) || 0));

  return {
    category: failureClass,
    memory: normalizedMemory,
    signalSignature,
    failureClass,
    resolution,
    source,
    observationCount: previousObservationCount + 1,
    firstObservedAt: typeof existingValue?.firstObservedAt === 'string' && existingValue.firstObservedAt.trim()
      ? existingValue.firstObservedAt.trim()
      : now,
    lastObservedAt: now,
    signalKeywords,
    searchText: [
      normalizedMemory,
      failureClass,
      signalSignature,
      resolution,
      signalKeywords.join(' '),
    ].filter(Boolean).join('\n'),
  };
}

async function readSemanticMemoryNotes(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile' | 'repairSignals' | 'improvementSignals' | 'recentAutonomousLearningNotes'>,
): Promise<Array<z.infer<typeof SemanticMemoryNoteSchema>>> {
  if (!store) return [];
  const namespace = getControlPlaneSemanticMemoryNamespace(state);
  const query = buildSemanticMemoryQuery(state);
  const parseResults = (items: SearchItem[]): Array<z.infer<typeof SemanticMemoryNoteSchema>> => items
    .map((item) => SemanticMemoryNoteSchema.safeParse({
      key: item.key,
      category: item.value.category,
      memory: item.value.memory,
      signalSignature: item.value.signalSignature,
      failureClass: item.value.failureClass,
      resolution: item.value.resolution,
      source: item.value.source,
    }))
    .flatMap((parsed) => parsed.success ? [parsed.data] : []);

  const results = await store.search(namespace, {
    query: query || 'control plane runner learnings recent repair notes',
    limit: SEMANTIC_MEMORY_SEARCH_WINDOW,
  }).catch(() => [] as SearchItem[]);
  const primaryNotes = dedupeSemanticMemoryNotes(parseResults(results));
  if (primaryNotes.length >= SEMANTIC_MEMORY_READ_LIMIT) {
    return primaryNotes;
  }

  const fallbackResults = await store.search(namespace, {
    limit: SEMANTIC_MEMORY_READ_LIMIT,
  }).catch(() => [] as SearchItem[]);
  return dedupeSemanticMemoryNotes([
    ...primaryNotes,
    ...parseResults(fallbackResults),
  ]);
}

export async function writeSemanticMemoryNotes(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
  notes: string[],
  metadata?: { signalSignature?: string; failureClass?: string; resolution?: string; source?: string },
): Promise<void> {
  if (!store || notes.length === 0) return;
  const namespace = getControlPlaneSemanticMemoryNamespace(state);
  const normalizedNotes = Array.from(new Set(
    notes
      .map((entry) => normalizeSemanticMemorySummary(entry, SEMANTIC_MEMORY_MEMORY_MAX_CHARS))
      .filter(Boolean),
  )).slice(-SEMANTIC_MEMORY_WRITE_LIMIT);
  for (const memory of normalizedNotes) {
    const key = buildSemanticMemoryRecordKey({
      memory,
      failureClass: metadata?.failureClass,
      category: metadata?.failureClass,
    });
    const existing = await store.get(namespace, key).catch(() => null);
    await store.put(
      namespace,
      key,
      buildSemanticMemoryPayload(memory, metadata, existing?.value || null),
      ['memory', 'category', 'failureClass', 'resolution', 'signalSignature', 'signalKeywords[*]', 'searchText'],
    ).catch(() => undefined);
  }
}

function getResearchScoutRequestNamespace(
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
): string[] {
  return [...getControlPlaneSemanticMemoryNamespace(state), 'research-scout-requests'];
}

function shouldSuppressSurfaceNoiseForResearch(
  state: Pick<ControlPlaneState, 'scopes' | 'effectiveScopes'>,
): boolean {
  const effectiveScopes = getEffectiveScopes(state as ControlPlaneState);
  return effectiveScopes.some((scope) => ['homepage-surface', 'ui-surface', 'workspace-surface'].includes(scope));
}

function filterResearchScoutRequestSignals(
  state: Pick<ControlPlaneState, 'scopes' | 'effectiveScopes'>,
  entries: string[],
): string[] {
  if (!shouldSuppressSurfaceNoiseForResearch(state)) return entries;
  return entries.filter((entry) => {
    const normalized = String(entry || '').toLowerCase();
    return !signalTextHasProviderAuthDriftFocus(normalized)
      && !signalTextHasApiRoutingFocus(normalized)
      && !signalTextHasApiRuntimeFocus(normalized)
      && !signalTextHasApiPlatformFocus(normalized);
  });
}

function buildResearchScoutRequestTopicKey(
  state: Pick<
    ControlPlaneState,
    | 'scopes'
    | 'effectiveScopes'
    | 'repairSignals'
    | 'improvementSignals'
    | 'autonomousContractPaths'
  >,
  query: string,
): string {
  const effectiveScopes = getEffectiveScopes(state as ControlPlaneState);
  const signalHints = extractSignalDrivenSearchHints(
    filterResearchScoutRequestSignals(state, [...state.repairSignals, ...state.improvementSignals]),
  ).slice(0, 4);
  const pathHints = state.autonomousContractPaths
    .map((entry) => String(entry || '').split('/').pop() || '')
    .map((entry) => entry.replace(/\.[^.]+$/g, ''))
    .filter(Boolean)
    .sort()
    .slice(0, 3);

  return normalizeSemanticMemorySummary(
    [effectiveScopes.join(','), signalHints.sort().join(','), pathHints.join(','), query]
      .filter(Boolean)
      .join(' | '),
    240,
  ).toLowerCase();
}

function buildResearchScoutPoolQuery(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'autonomousContractSummary'
    | 'autonomousContractPaths'
  >,
): string {
  const sources = [
    state.goal,
    state.repairIntentSummary,
    ...filterResearchScoutRequestSignals(state, state.repairSignals).slice(0, 3),
    state.improvementIntentSummary,
    ...filterResearchScoutRequestSignals(state, state.improvementSignals).slice(0, 3),
    state.autonomousContractSummary,
    ...state.autonomousContractPaths.slice(0, 3),
  ]
    .map((entry) => normalizeSemanticMemorySummary(entry, 180))
    .filter(Boolean);
  const keywords = collectSemanticMemoryKeywords(sources, 18);
  return [...keywords, ...sources.slice(0, 6)].join(' | ').trim();
}

function buildResearchScoutNaturalLanguageRequestQuery(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairSignals'
    | 'improvementSignals'
    | 'autonomousContractPaths'
  >,
): string {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  const signalHints = extractSignalDrivenSearchHints([
    ...filterResearchScoutRequestSignals(state, state.repairSignals),
    ...filterResearchScoutRequestSignals(state, state.improvementSignals),
  ]).slice(0, 4);
  const pathHints = state.autonomousContractPaths
    .map((entry) => String(entry || '').split('/').pop() || '')
    .map((entry) => entry.replace(/\.[^.]+$/g, ''))
    .filter((entry) => entry.length >= 4)
    .filter((entry) => !['index', 'main', 'app', 'route', 'routes', 'utils', 'types'].includes(entry.toLowerCase()))
    .filter(Boolean)
    .slice(0, 3);

  let query = '';
  if (effectiveScopes.has('api-routing')) {
    query = 'Developer docs and implementation patterns for provider routing, capability gating, retry-worthless failures, and model availability fallbacks in AI gateways.';
  } else if (effectiveScopes.has('api-runtime')) {
    query = 'Developer docs and implementation patterns for API request queues, timeout handling, retry classification, provider failure backoff, and intake guards.';
  } else if (effectiveScopes.has('api-data')) {
    query = 'Developer docs and implementation patterns for model catalog synchronization, provider availability metadata, source-of-truth updates, and pricing coverage.';
  } else if (effectiveScopes.has('api-platform')) {
    query = 'Developer docs and implementation patterns for experimental API startup health, systemd service readiness, websocket health, and safe runtime validation.';
  } else if (effectiveScopes.has('workspace-surface')) {
    query = 'Developer docs and implementation patterns for package.json scripts, monorepo workspace setup, root tooling ergonomics, and developer workflow aliases.';
  } else if (effectiveScopes.has('homepage-surface')) {
    query = 'Developer docs and implementation patterns for homepage static assets, favicon handling, browser-visible polish, and lightweight front-end shell fixes.';
  } else if (effectiveScopes.has('ui-surface')) {
    query = 'Developer docs and implementation patterns for frontend shell static assets, browser-visible error polish, and favicon or entrypoint fixes.';
  } else {
    query = 'Developer docs and implementation patterns for control-plane orchestration, durable workflows, evaluation gates, governance, semantic memory, and MCP tool routing.';
  }

  const suffix = [
    signalHints.length > 0 ? `Focus on: ${signalHints.join(', ')}.` : '',
    pathHints.length > 0 ? `Relevant files: ${pathHints.join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  return truncateTextMiddle(
    `${query}${suffix ? ` ${suffix}` : ''}`,
    240,
  );
}

async function readResearchScoutPoolNotes(
  store: BaseStore | undefined,
  state: Pick<
    ControlPlaneState,
    | 'langSmithProjectName'
    | 'governanceProfile'
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'autonomousContractSummary'
    | 'autonomousContractPaths'
  >,
): Promise<string[]> {
  if (!store) return [];
  const namespace = getResearchScoutPageMemoryNamespace(state);
  const query = buildResearchScoutPoolQuery(state);
  const results = await store.search(namespace, {
    query: query || 'agent orchestration workflow reliability api routing capability',
    limit: 6,
  }).catch(() => [] as SearchItem[]);

  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  const entries: Array<{
    url: string;
    hostname: string;
    family: 'control-plane' | 'api' | 'generic';
    quality: string;
    informationScore: number;
    mappedPaths: string[];
    keywords: string[];
    title: string;
    priority: number;
  }> = [];
  const seenUrls = new Set<string>();
  for (const item of results) {
    const value = item.value && typeof item.value === 'object'
      ? item.value as Record<string, unknown>
      : {};
    const url = normalizeHttpUrl(value.pageUrl || item.key);
    if (!url || seenUrls.has(url)) continue;
    const hostname = getResearchScoutHostname(url);
    const combinedText = [
      value.pageTitle,
      value.searchTitle,
      value.searchDescription,
      value.pageSummary,
      value.pagePreview,
    ].map((entry) => String(entry || '').trim()).filter(Boolean).join(' | ');
    const family = value.family === 'control-plane' || value.family === 'api' ? value.family : 'generic';
    if (isResearchScoutNavigationTrap(url, hostname, combinedText)) continue;
    if (isResearchScoutUndesiredHost(hostname, family)) continue;
    if (isResearchScoutLowValueCommunityHost(hostname)) continue;
    if (family !== 'generic' && !isResearchScoutPreferredTechnicalHost(hostname, family)) continue;
    if (!isResearchScoutPreferredTechnicalHost(hostname, family) && !isResearchScoutTechnicalDocLike(combinedText.toLowerCase())) continue;
    seenUrls.add(url);
    const quality = String(value.quality || 'low').trim() || 'low';
    const informationScore = Number(value.informationScore) || 0;
    if (quality !== 'high' && informationScore < 8) continue;
    const mappedPaths = Array.isArray(value.mappedPaths)
      ? value.mappedPaths.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 2)
      : [];
    const keywords = Array.isArray(value.keywords)
      ? value.keywords.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 4)
      : [];
    const title = normalizeSemanticMemorySummary(value.pageTitle || value.searchTitle || url, 140);
    let priority = (Number(value.totalScore) || 0) + scoreResearchScoutDomain(hostname, family) + informationScore;
    if (effectiveScopes.has('research-scout') || effectiveScopes.has('control-plane')) {
      if (/docs\.temporal\.io$|modelcontextprotocol\.io$|qdrant\.tech$/.test(hostname)) priority += 12;
      if (/github\.com$|langchain\.com$|langchain\.dev$/.test(hostname)) priority += 2;
      if (/langgraph|langchain/i.test(title) && !/docs\.temporal\.io$|modelcontextprotocol\.io$|qdrant\.tech$/.test(hostname)) priority -= 4;
    }
    if (hasApiFamilyScope(effectiveScopes) || effectiveScopes.has('research-scout')) {
      if (/openrouter\.ai$|platform\.openai\.com$|openai\.com$|ai\.google\.dev$|developers\.google\.com$|docs\.anthropic\.com$|anthropic\.com$/.test(hostname)) priority += 8;
    }
    entries.push({
      url,
      hostname,
      family,
      quality,
      informationScore,
      mappedPaths,
      keywords,
      title,
      priority,
    });
  }

  entries.sort((left, right) =>
    right.priority - left.priority
    || left.url.localeCompare(right.url),
  );

  const notes: string[] = [];
  const seenHosts = new Set<string>();
  for (const entry of entries) {
    if (seenHosts.has(entry.hostname)) continue;
    seenHosts.add(entry.hostname);
    notes.push(
      `Research pool: ${entry.title} — ${entry.url}${entry.mappedPaths.length > 0 ? `; mapped to ${entry.mappedPaths.join(', ')}` : ''}${entry.keywords.length > 0 ? `; signals: ${entry.keywords.join(', ')}` : ''}; quality: ${entry.quality}.`,
    );
    if (notes.length >= 3) break;
  }

  return notes;
}

function shouldQueueResearchScoutLookupRequest(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'autonomousContractSummary'
    | 'autonomousContractPaths'
  >,
): boolean {
  const effectiveScopes = getEffectiveScopes(state as ControlPlaneState);
  if (effectiveScopes.includes('research-scout')) return false;
  if (shouldPlanBraveSearchForGoal(state.goal)) return true;
  const sourceText = [
    state.goal,
    state.repairIntentSummary,
    ...state.repairSignals,
    state.improvementIntentSummary,
    ...state.improvementSignals,
    state.autonomousContractSummary,
    ...state.autonomousContractPaths,
  ].join(' | ').toLowerCase();
  if (/provider model|provider[_ -]?cap|routing|retry|quota|capability|rate limit|invalid argument|responses api|tool calling|function calling|openrouter|openai|gemini|anthropic|mcp|checkpoint|durable execution|state graph|semantic memory|vector memory|hybrid search|evaluation|governance|observability/.test(sourceText)) {
    return true;
  }
  return state.repairSignals.length > 0 || state.improvementSignals.length > 0;
}

function buildResearchScoutLookupRequestSummary(
  state: Pick<
    ControlPlaneState,
    | 'threadId'
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'autonomousContractSummary'
    | 'autonomousContractPaths'
  >,
): { summary: string; query: string } {
  const summary = truncateTextMiddle(
    [
      `thread=${state.threadId}`,
      `scopes=${getEffectiveScopes(state as ControlPlaneState).join(',')}`,
      state.repairIntentSummary || state.improvementIntentSummary || state.goal,
      ...state.repairSignals.slice(0, 2),
      ...state.improvementSignals.slice(0, 2),
      state.autonomousContractSummary,
      ...state.autonomousContractPaths.slice(0, 2),
    ]
      .map((entry) => normalizeSemanticMemorySummary(entry, 180))
      .filter(Boolean)
      .join(' | '),
    420,
  );
  return {
    summary,
    query: buildResearchScoutNaturalLanguageRequestQuery(state),
  };
}

async function queueResearchScoutLookupRequest(
  store: BaseStore | undefined,
  state: Pick<
    ControlPlaneState,
    | 'langSmithProjectName'
    | 'governanceProfile'
    | 'threadId'
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'autonomousContractSummary'
    | 'autonomousContractPaths'
  >,
): Promise<string[]> {
  if (!store || !shouldQueueResearchScoutLookupRequest(state)) return [];
  const { summary, query } = buildResearchScoutLookupRequestSummary(state);
  if (!summary || !query) return [];

  const namespace = getResearchScoutRequestNamespace(state);
  const key = buildSemanticMemoryRecordKey({
    memory: buildResearchScoutRequestTopicKey(state, query),
    failureClass: 'research-request',
    category: 'research-request',
  });
  const existing = await store.get(namespace, key).catch(() => null);
  const existingValue = existing?.value && typeof existing.value === 'object'
    ? existing.value as Record<string, unknown>
    : {};
  const lastObservedAtMs = Date.parse(String(existingValue.lastObservedAt || ''));
  if (lastObservedAtMs && (Date.now() - lastObservedAtMs) < 30 * 60 * 1000) {
    return [];
  }

  const now = new Date().toISOString();
  await store.put(namespace, key, {
    requestSummary: summary,
    requestQuery: query,
    requestedByThreadId: state.threadId,
    requestedByScopes: getEffectiveScopes(state as ControlPlaneState),
    mappedPaths: state.autonomousContractPaths.slice(0, 4),
    firstObservedAt: typeof existingValue.firstObservedAt === 'string' && existingValue.firstObservedAt.trim()
      ? existingValue.firstObservedAt.trim()
      : now,
    lastObservedAt: now,
    observationCount: Math.max(0, Math.floor(Number(existingValue.observationCount) || 0)) + 1,
    searchText: [summary, query, ...state.autonomousContractPaths.slice(0, 4)].join('\n'),
  }, ['searchText']).catch(() => undefined);

  return [
    `Queued research-scout request: ${truncateTextMiddle(summary, 180)}.`,
  ];
}

async function readResearchScoutRequestedQueries(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
): Promise<string[]> {
  if (!store) return [];
  const namespace = getResearchScoutRequestNamespace(state);
  const results = await store.search(namespace, {
    limit: 6,
  }).catch(() => [] as SearchItem[]);

  return uniqueNormalizedStrings(
    results
      .map((item) => item.value && typeof item.value === 'object'
        ? String((item.value as Record<string, unknown>).requestQuery || '').trim()
        : '')
      .filter(Boolean),
  ).slice(0, 4);
}

function buildSharedAiAgentPayload(state: ControlPlaneState): Record<string, unknown> {
  const filteredRepairSignals = filterResearchScoutRequestSignals(state, state.repairSignals);
  const filteredImprovementSignals = filterResearchScoutRequestSignals(state, state.improvementSignals);
  const evaluationGatePolicy = resolveStateEvaluationGatePolicy(state);
  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  const governanceGateResult = resolveStateGovernanceGateResult(state);
  const { scopes: effectiveScopes, reason: scopeExpansionReason } = resolveEffectiveScopes(state);
  const autonomousSkillBundle = resolveAutonomousSkillBundle({
    effectiveScopes,
    goal: state.goal,
    repairSignals: filteredRepairSignals,
    improvementSignals: filteredImprovementSignals,
    autonomousContractPaths: state.autonomousContractPaths,
  });
  const payload = {
    goal: state.goal,
    scopes: effectiveScopes,
    requestedScopes: uniqueScopes(state.scopes),
    scopeExpansionMode: state.scopeExpansionMode,
    scopeExpansionReason: scopeExpansionReason || undefined,
    experimentalTarget: {
      apiBaseUrl: state.experimentalApiBaseUrl,
      serviceName: state.experimentalServiceName,
    },
    langSmith: {
      enabled: state.langSmithEnabled,
      workspace: state.langSmithWorkspace,
      accessibleWorkspaces: state.langSmithAccessibleWorkspaces.map((workspace) => ({
        id: workspace.id,
        displayName: workspace.displayName,
        roleName: workspace.roleName,
      })),
      currentProject: state.langSmithProject
        ? {
            id: state.langSmithProject.id,
            name: state.langSmithProject.name,
            description: state.langSmithProject.description,
            metadata: state.langSmithProject.metadata,
          }
        : null,
      projectName: state.langSmithProjectName,
      recentProjects: state.langSmithProjects.map((project) => project.name),
      recentRuns: state.langSmithRuns.map((run) => ({
        name: run.name,
        status: run.status,
        runType: run.runType,
        traceId: run.traceId,
        parentRunId: run.parentRunId,
        threadId: run.threadId,
        tags: run.tags,
      })),
      datasets: state.langSmithDatasets.map((dataset) => dataset.name),
      prompts: state.langSmithPrompts.map((prompt) => ({
        identifier: prompt.identifier,
        commitHash: prompt.commitHash,
        channels: prompt.channels,
      })),
      annotationQueues: state.langSmithAnnotationQueues.map((queue) => ({
        name: queue.name,
        itemCount: queue.itemCount,
        feedbackCount: queue.feedbackCount,
      })),
      annotationQueueItems: state.langSmithAnnotationQueueItems.slice(0, 5).map((item) => ({
        queue: item.queueName,
        runName: item.runName,
        runId: item.runId,
        status: item.status,
      })),
      feedback: state.langSmithFeedback.slice(0, 5).map((item) => ({
        key: item.key,
        runId: item.runId,
        exampleId: item.exampleId,
        score: item.score,
      })),
      evaluations: state.langSmithEvaluations.map((evaluation) => ({
        datasetName: evaluation.datasetName,
        experimentName: evaluation.experimentName,
        experimentId: evaluation.experimentId,
        experimentUrl: evaluation.experimentUrl,
        resultCount: evaluation.resultCount,
        averageScore: evaluation.averageScore,
        metrics: evaluation.metrics.map((metric) => ({
          key: metric.key,
          count: metric.count,
          averageScore: metric.averageScore,
        })),
        scorecard: evaluation.scorecard,
      })),
      governance: state.langSmithGovernance
        ? {
            counts: state.langSmithGovernance.counts,
            feedbackKeyCounts: state.langSmithGovernance.feedbackKeyCounts,
            flags: state.langSmithGovernance.flags,
            mutations: state.langSmithGovernance.mutations,
          }
        : null,
      governanceGate: governanceGateResult,
      evaluationGatePolicy,
      evaluationGate: evaluationGateResult,
      evaluationMetricResults: evaluationGateResult.metricResults,
      selectedPrompt: {
        identifier: state.promptIdentifier,
        requestedRef: state.promptRef || undefined,
        requestedChannel: state.promptChannel || undefined,
        selectedReference: state.selectedPromptReference || undefined,
        source: state.selectedPromptSource,
        selectedChannel: state.selectedPromptChannel || undefined,
        commitHash: state.selectedPromptCommitHash || undefined,
        availableChannels: state.selectedPromptAvailableChannels,
        metadata: state.selectedPromptMetadata,
        rollbackReference: state.promptRollbackReference || undefined,
        syncEnabled: state.promptSyncEnabled,
        syncChannel: state.promptSyncChannel || undefined,
        promoteChannel: state.promptPromoteChannel || undefined,
        promotionReason: state.promptPromotionReason || undefined,
        promotionBlockedReason: state.promptPromotionBlockedReason || undefined,
      },
      notes: compactStringArrayForAi(state.langSmithNotes, AI_AGENT_CONTEXT_NOTE_LIMIT),
    },
    observability: {
      tags: state.observabilityTags,
      metadata: state.observabilityMetadata,
    },
    autonomousPlanning: {
      aggressiveExperimentalBias: shouldUseAggressiveAutonomousPlanning(state),
      plannerAgentCount: state.autonomousPlannerAgentCount,
      plannerStrategy: state.autonomousPlannerStrategy || undefined,
      plannerFocuses: state.autonomousPlannerFocuses,
    },
    autonomousSkills: {
      alwaysLoaded: autonomousSkillBundle.alwaysLoaded.map((skill) => ({
        id: skill.id,
        title: skill.title,
        description: skill.description,
      })),
      loaded: autonomousSkillBundle.loaded.map((skill) => ({
        id: skill.id,
        title: skill.title,
        description: skill.description,
        guidance: skill.guidance,
        references: skill.references,
        contract: skill.contract
          ? {
              summary: skill.contract.summary,
              checks: skill.contract.checks,
              preferredPaths: skill.contract.preferredPaths,
            }
          : undefined,
      })),
    },
    mcpServers: state.mcpInspections.map((inspection) => ({
      server: inspection.server,
      status: inspection.status,
      tools: inspection.tools.map((tool) => tool.name),
    })),
    mcpActions: {
      planned: state.plannedMcpActions.map((action) => ({
        id: action.id,
        server: action.server,
        tool: action.tool,
        title: action.title,
        reason: action.reason,
        risk: action.risk,
      })),
      executed: state.executedMcpActions.map((action) => ({
        id: action.id,
        server: action.server,
        tool: action.tool,
        status: action.status,
        outputSummary: action.outputSummary,
      })),
      notes: compactStringArrayForAi(state.mcpActionNotes, 8),
    },
    logInsights: state.logInsights.map((insight) => ({
      file: insight.file,
      latest: insight.lines.slice(-6),
    })),
    plannerNotes: compactStringArrayForAi(state.plannerNotes, AI_AGENT_CONTEXT_NOTE_LIMIT),
    recentAutonomousLearningNotes: compactStringArrayForAi(state.recentAutonomousLearningNotes, 8),
    semanticMemoryNotes: state.semanticMemoryNotes.map((note) => ({
      category: note.category,
      memory: note.memory,
      failureClass: note.failureClass,
      resolution: note.resolution,
      signalSignature: note.signalSignature,
      source: note.source,
    })),
    recentExecutedJobs: state.executedJobs.slice(-8).map((job) => ({
      title: job.title,
      target: job.target,
      kind: job.kind,
      status: job.status,
      exitCode: job.exitCode,
      output: truncateTextMiddle(String(job.output || ''), 1200),
    })),
    allowDeploy: state.allowDeploy,
    deployCommand: state.deployCommand,
    repair: {
      mode: state.autonomousOperationMode,
      intentSummary: state.repairIntentSummary,
      signals: filteredRepairSignals,
      actionableSignalCount: countActionableRepairSignals(filteredRepairSignals),
      externalSignalCount: countExternallyCausedRepairSignals(filteredRepairSignals),
      improvementIntentSummary: state.improvementIntentSummary,
      improvementSignals: filteredImprovementSignals,
      status: state.repairStatus,
      decisionReason: state.repairDecisionReason,
      sessionId: state.repairSessionManifest?.sessionId,
      rollbackStatus: state.repairSessionManifest?.rollbackStatus,
      touchedPaths: getRepairTouchedPaths(state),
      promotedPaths: state.repairPromotedPaths,
      rollbackPaths: state.repairRollbackPaths,
      smokeResults: state.repairSmokeResults.map((job) => ({
        title: job.title,
        status: job.status,
        exitCode: job.exitCode,
      })),
      postRepairValidationStatus: state.postRepairValidationStatus,
      postRepairValidationResults: state.postRepairValidationResults.map((job) => ({
        title: job.title,
        status: job.status,
        exitCode: job.exitCode,
      })),
      experimentalRestartStatus: state.experimentalRestartStatus,
      experimentalRestartReason: state.experimentalRestartReason,
    },
    autonomousContract: state.autonomousContractSummary.trim()
      ? {
          summary: state.autonomousContractSummary,
          checks: state.autonomousContractChecks,
          paths: state.autonomousContractPaths,
        }
      : undefined,
  };

  return compactUnknownForAi(payload, {
    maxStringChars: AI_AGENT_PAYLOAD_STRING_MAX_CHARS,
    maxArrayItems: AI_AGENT_PAYLOAD_ARRAY_LIMIT,
    maxObjectKeys: AI_AGENT_PAYLOAD_OBJECT_KEY_LIMIT,
    maxDepth: 4,
  }) as Record<string, unknown>;
}

function resolveAiNotesAgentTimeoutMs(
  role: 'planner' | 'build' | 'quality' | 'deploy',
  state: Pick<ControlPlaneState, 'scopes' | 'effectiveScopes'>,
): number {
  const effectiveScopes = getEffectiveScopes(state as ControlPlaneState);
  if (effectiveScopes.includes('research-scout')) {
    if (role === 'planner') {
      return Math.max(RESEARCH_SCOUT_AI_NOTES_TIMEOUT_MS, RESEARCH_SCOUT_AI_PLANNER_TIMEOUT_MS);
    }
    return Math.max(AI_NOTES_AGENT_REQUEST_TIMEOUT_MS, RESEARCH_SCOUT_AI_NOTES_TIMEOUT_MS);
  }
  if (effectiveScopes.includes('control-plane')) {
    return Math.max(AI_NOTES_AGENT_REQUEST_TIMEOUT_MS, CONTROL_PLANE_LANE_AI_NOTES_TIMEOUT_MS);
  }
  if (effectiveScopes.some((scope) => ['homepage-surface', 'ui-surface', 'workspace-surface'].includes(scope))) {
    return Math.max(AI_NOTES_AGENT_REQUEST_TIMEOUT_MS, SURFACE_FAMILY_AI_NOTES_TIMEOUT_MS);
  }
  if (hasApiFamilyScope(effectiveScopes)) {
    return Math.max(AI_NOTES_AGENT_REQUEST_TIMEOUT_MS, API_FAMILY_AI_NOTES_TIMEOUT_MS);
  }
  return AI_NOTES_AGENT_REQUEST_TIMEOUT_MS;
}

function classifyAiFailureMessage(message: string): AiFailureClass {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) return 'none';
  if (isAiBackendBackpressureMessage(normalized)) return 'backpressure';
  if (/timed out after|aborterror|the operation was aborted/.test(normalized)) return 'timeout';
  if (/unparsable content|unexpected token|json|unterminated|string|parse/i.test(normalized)) return 'malformed-output';
  return 'backend-error';
}

function buildReducedAiNotesPayload(
  role: 'planner' | 'build' | 'quality' | 'deploy',
  state: ControlPlaneState,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return compactUnknownForAi({
    role,
    goal: state.goal,
    effectiveScopes: getEffectiveScopes(state),
    repairIntentSummary: state.repairIntentSummary,
    improvementIntentSummary: state.improvementIntentSummary,
    autonomousContractSummary: state.autonomousContractSummary,
    autonomousContractPaths: state.autonomousContractPaths.slice(0, 4),
    currentNotes: Array.isArray(payload.currentNotes)
      ? payload.currentNotes
      : [],
  }, {
    maxStringChars: Math.max(240, Math.floor(AI_AGENT_PAYLOAD_STRING_MAX_CHARS / 2)),
    maxArrayItems: Math.max(4, Math.floor(AI_AGENT_PAYLOAD_ARRAY_LIMIT / 2)),
    maxObjectKeys: Math.max(6, Math.floor(AI_AGENT_PAYLOAD_OBJECT_KEY_LIMIT / 2)),
    maxDepth: 3,
  }) as Record<string, unknown>;
}

async function callAiNotesAgent(
  role: 'planner' | 'build' | 'quality' | 'deploy',
  state: ControlPlaneState,
  payload: Record<string, unknown>,
  systemPrompt: string,
): Promise<AiNodeRunResult> {
  const config = resolveControlPlaneAiConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      model: config.model,
      backend: config.baseUrl,
      notes: [],
    };
  }

  const timeoutMs = resolveAiNotesAgentTimeoutMs(role, state);
  const rateLimitWaitBudgetMs = Math.max(1_000, timeoutMs - 5_000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const reducedPayload = buildReducedAiNotesPayload(role, state, payload);

  try {
    const attemptRequest = async (
      attemptPayload: Record<string, unknown>,
      reducedAttempt: boolean,
    ): Promise<AiNodeRunResult> => {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          'x-anygpt-internal-client': 'control-plane',
          'x-anygpt-rate-limit-wait-budget-ms': String(rateLimitWaitBudgetMs),
        },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                systemPrompt,
                'Return JSON only in the form {"notes": string[]}.',
                'Do not output markdown fences.',
                'Never invent credentials, API keys, or shell commands.',
                'Respect the rule that production anygpt.service must not be restarted.',
                reducedAttempt ? 'This is a retry after malformed output. Keep the response minimal and strictly valid JSON.' : '',
              ].filter(Boolean).join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify(compactUnknownForAi({
                threadId: state.threadId,
                role,
                payload: attemptPayload,
              })),
            },
          ],
        }),
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`AI ${role} agent request failed (${response.status}): ${rawText.slice(0, 400)}`);
      }

      const payloadJson = JSON.parse(rawText);
      const assistantText = extractAssistantTextFromChatCompletionPayload(payloadJson);
      const jsonObjectText = extractJsonObjectFromText(assistantText);
      if (!jsonObjectText) {
        throw new Error(`AI ${role} agent returned unparsable content.`);
      }

      const parsed = AiNodeAdviceSchema.parse(JSON.parse(jsonObjectText));
      const notes = parsed.notes
        .map((note) => String(note || '').trim())
        .filter(Boolean)
        .slice(0, AI_AGENT_NOTE_LIMIT);

      return {
        enabled: true,
        model: config.model,
        backend: config.baseUrl,
        notes,
        failureClass: 'none',
      };
    };

    try {
      return await attemptRequest(payload, false);
    } catch (error: any) {
      const rawMessage = String(error?.message || error || '');
      const failureClass = classifyAiFailureMessage(rawMessage);
      if (failureClass !== 'malformed-output') {
        throw error;
      }
      return await attemptRequest(reducedPayload, true);
    }
  } catch (error: any) {
    const errorText = String(error?.message || error || '');
    const rawMessage = error?.name === 'AbortError' || errorText === 'The operation was aborted.'
      ? `AI ${role} agent timed out after ${timeoutMs}ms`
      : errorText;
    const backpressure = isAiBackendBackpressureMessage(rawMessage);
    const failureClass = classifyAiFailureMessage(rawMessage);
    return {
      enabled: true,
      model: config.model,
      backend: config.baseUrl,
      notes: [],
      error: redactSensitiveText(rawMessage),
      backpressure,
      retryAfterSeconds: backpressure ? extractAiBackendRetryAfterSeconds(rawMessage) : undefined,
      failureClass,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callAiAutonomousEditReviewer(
  state: ControlPlaneState,
  payload: Record<string, unknown>,
): Promise<AutonomousEditReviewResult> {
  const config = resolveControlPlaneAiConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      approved: false,
      reason: '',
      confidence: 'low',
      model: config.model,
      backend: config.baseUrl,
    };
  }

  const controller = new AbortController();
  const rateLimitWaitBudgetMs = Math.max(1_000, AI_AGENT_REQUEST_TIMEOUT_MS - 5_000);
  const timeoutId = setTimeout(() => controller.abort(), AI_AGENT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        'x-anygpt-internal-client': 'control-plane',
        'x-anygpt-rate-limit-wait-budget-ms': String(rateLimitWaitBudgetMs),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You are a strict autonomous edit reviewer for the AnyGPT control plane.',
              'Return JSON only in the form {"approved": boolean, "reason": string, "confidence": "low" | "medium" | "high"}.',
              'Reject speculative edits that do not clearly match the active signals.',
              'Prefer rejecting edits when the proposed path set is broad, weakly justified, or mixes unrelated subsystems.',
              'Allow tightly coupled multi-file edits only when the reason clearly depends on both files and the payload shows strong signal/path alignment.',
              'When signals are externally caused or provider-bound, approve only control-plane or clearly justified classification/queue/resilience edits.',
              'When an autonomous contract is provided, reject proposals that do not satisfy its summary/checks or that go outside its listed contract paths.',
              'Do not output markdown fences or prose outside the JSON object.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify(compactUnknownForAi(payload, {
              maxStringChars: AI_CODE_EDIT_PAYLOAD_STRING_MAX_CHARS,
              maxArrayItems: AI_AGENT_PAYLOAD_ARRAY_LIMIT,
              maxObjectKeys: AI_AGENT_PAYLOAD_OBJECT_KEY_LIMIT,
              maxDepth: 5,
            })),
          },
        ],
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`AI autonomous edit reviewer failed (${response.status}): ${rawText.slice(0, 400)}`);
    }

    const payloadJson = JSON.parse(rawText);
    const assistantText = extractAssistantTextFromChatCompletionPayload(payloadJson);
    const jsonObjectText = extractJsonObjectFromText(assistantText);
    if (!jsonObjectText) {
      throw new Error('AI autonomous edit reviewer returned unparsable content.');
    }

    const parsed = JSON.parse(jsonObjectText) as Record<string, unknown>;
    const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low';
    return {
      enabled: true,
      approved: parsed.approved === true,
      reason: String(parsed.reason || '').trim(),
      confidence,
      model: config.model,
      backend: config.baseUrl,
    };
  } catch (error: any) {
    return {
      enabled: true,
      approved: false,
      reason: redactSensitiveText(error?.message || String(error)),
      confidence: 'low',
      model: config.model,
      backend: config.baseUrl,
      error: redactSensitiveText(error?.message || String(error)),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callAiCodeEditAgent(
  state: ControlPlaneState,
  payload: Record<string, unknown>,
): Promise<AiCodeEditResult> {
  const requestedOperationMode = String((payload as any).operationMode || '').trim().toLowerCase() === 'repair'
    ? 'repair'
    : 'improvement';
  const repairSignalCount = Array.isArray((payload as any).repairIntent?.signals)
    ? (payload as any).repairIntent.signals.length
    : 0;
  const improvementSignalCount = Array.isArray((payload as any).improvementIntent?.signals)
    ? (payload as any).improvementIntent.signals.length
    : 0;
  const agentLabel = String((payload as any).agentLabel || 'primary').trim() || 'primary';
  const agentFocus = String((payload as any).agentFocus || '').trim();
  const aggressiveExperimentalBias = (payload as any).aggressiveExperimentalBias === true;
  const config = resolveControlPlaneAiConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      model: config.model,
      backend: config.baseUrl,
      summary: '',
      edits: [],
      agentLabel,
      agentFocus,
      candidatePaths: Array.isArray((payload as any).autonomousCandidatePaths)
        ? (payload as any).autonomousCandidatePaths.map((entry: any) => String(entry || '').trim()).filter(Boolean)
        : [],
    };
  }

  const controller = new AbortController();
  const rateLimitWaitBudgetMs = Math.max(1_000, AI_AGENT_REQUEST_TIMEOUT_MS - 5_000);
  const timeoutId = setTimeout(() => controller.abort(), AI_AGENT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        'x-anygpt-internal-client': 'control-plane',
        'x-anygpt-rate-limit-wait-budget-ms': String(rateLimitWaitBudgetMs),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              String(state.controlPlanePrompts.autonomousEdit || DEFAULT_CONTROL_PLANE_PROMPT_BUNDLE.autonomousEdit).trim()
                || DEFAULT_CONTROL_PLANE_PROMPT_BUNDLE.autonomousEdit,
              `Focused agent label: ${agentLabel}.`,
              agentFocus ? `Focused agent task: ${agentFocus}` : '',
              'Return JSON only in the form {"summary": string, "edits": [{"type": "replace" | "write", "path": string, "reason": string, "find"?: string, "replace"?: string, "content"?: string}]}.',
              requestedOperationMode === 'repair'
                ? `You are operating in repair mode with ${repairSignalCount} actionable repair signal(s). Prefer a minimal bounded replace edit whenever a safe fix is possible. When the direct repair is ambiguous or the signals are provider-bound, input-bound, or otherwise external, pivot to the smallest resilience, validation, observability, or cleanup improvement in the most relevant candidate path instead of returning an empty plan. Empty edits are only acceptable when no safe bounded change fits the allowlist or available context, and then the summary must explain why.`
                : `You are operating in improvement mode with ${improvementSignalCount} improvement signal(s). On experimental scope, default to proposing at least one small hot-path throughput, routing, resilience, or observability improvement that can be validated quickly. Return an empty edits array only when the candidate context is too weak or every plausible change would violate path or safety rules, and then the summary must explain why.`,
              aggressiveExperimentalBias
                ? 'Aggressive experimental planning is enabled. Because allowlists, path checks, repair smoke validation, and rollback still apply, bias toward proposing one small bounded edit instead of another no-op analysis pass.'
                : '',
              'An autonomous contract may be provided in the payload. Treat it as binding: satisfy the contract summary, stay inside the contract paths when they are provided, and explicitly address the listed checks.',
              'Autonomous skills may be provided with tiered summaries, loaded guidance, and reference paths. Treat loaded skills as project-specific guidance and use their reference paths to choose the smallest matching file.',
              'Think in two phases: first decide the next concrete contract-aligned change, then emit only that bounded edit plan. Do not re-plan the whole subsystem.',
              'Prefer the smallest safe replace edit over rewriting entire files.',
              'If previous failed edits are provided, do not repeat the same stale replace block or reuse the same find string unchanged.',
              'When a previous replace failed because the target text was not found, refresh the exact current block from the provided candidate file excerpts before proposing another replace edit.',
              'Use the dedicated failed-edit refresh contexts when present; they contain the current live block for the previously failing file path.',
              'Only propose replace edits for files that already exist in the provided candidate contexts. Do not invent new replace-target paths.',
              'When the provided signals mention a file family or subsystem, bias the proposal toward the most relevant candidate file instead of returning a no-op.',
              'Candidate files include selectionReason, rawCharCount, excerptStrategy, and anchorHints metadata; use those fields to understand why each file was included and how much context you are seeing.',
              'Only modify explicitly allowed paths and never modify denied paths, secrets, key files, environment files, lockfiles, node_modules, or generated outputs.',
              'If you return an empty edits array, the summary must name the blocking constraint, missing context, or safety reason.',
              'Your summary must name the targeted file or subsystem when you do propose an edit.',
              `Never return more than ${state.maxEditActions} edits.`,
              'Do not emit markdown fences or prose outside the JSON object.',
            ].filter(Boolean).join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify(compactUnknownForAi(payload, {
              maxStringChars: Math.max(AI_CODE_EDIT_PAYLOAD_STRING_MAX_CHARS, AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS * 2, 3_200),
              maxArrayItems: Math.max(AI_CODE_EDIT_CANDIDATE_FILE_LIMIT, AI_AGENT_PAYLOAD_ARRAY_LIMIT),
              maxObjectKeys: Math.max(AI_AGENT_PAYLOAD_OBJECT_KEY_LIMIT, 24),
              maxDepth: 5,
            })),
          },
        ],
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`AI code edit agent request failed (${response.status}): ${rawText.slice(0, 400)}`);
    }

    const payloadJson = JSON.parse(rawText);
    const assistantText = extractAssistantTextFromChatCompletionPayload(payloadJson);
    const jsonObjectText = extractJsonObjectFromText(assistantText);
    if (!jsonObjectText) {
      throw new Error('AI code edit agent returned unparsable content.');
    }

    const parsed = AutonomousEditPlanSchema.parse(JSON.parse(jsonObjectText));
    const normalizedSummary = String(parsed.summary || '').trim()
      || (parsed.edits.length > 0
        ? `${parsed.edits.length} bounded ${requestedOperationMode} edit(s) proposed.`
        : requestedOperationMode === 'repair' && repairSignalCount > 0
          ? `No bounded repair edit was identified despite ${repairSignalCount} actionable repair signal(s); the current candidate context may still be too narrow for a safe minimal fix.`
          : requestedOperationMode === 'improvement' && improvementSignalCount > 0
            ? `No safe bounded improvement edit was identified for ${improvementSignalCount} improvement signal(s).`
            : `No safe bounded ${requestedOperationMode} edit was identified for this iteration.`);
    return {
      enabled: true,
      model: config.model,
      backend: config.baseUrl,
      summary: normalizedSummary,
      edits: parsed.edits.slice(0, state.maxEditActions),
      agentLabel,
      agentFocus,
      candidatePaths: Array.isArray((payload as any).autonomousCandidatePaths)
        ? (payload as any).autonomousCandidatePaths.map((entry: any) => String(entry || '').trim()).filter(Boolean)
        : [],
    };
  } catch (error: any) {
    const rawMessage = String(error?.message || error || '');
    const backpressure = isAiBackendBackpressureMessage(rawMessage);
    return {
      enabled: true,
      model: config.model,
      backend: config.baseUrl,
      summary: requestedOperationMode === 'repair' && repairSignalCount > 0
        ? 'AI repair agent request failed before a bounded edit plan was produced.'
        : requestedOperationMode === 'improvement' && improvementSignalCount > 0
          ? 'AI improvement agent request failed before a bounded edit plan was produced.'
          : '',
      edits: [],
      agentLabel,
      agentFocus,
      candidatePaths: Array.isArray((payload as any).autonomousCandidatePaths)
        ? (payload as any).autonomousCandidatePaths.map((entry: any) => String(entry || '').trim()).filter(Boolean)
        : [],
      error: redactSensitiveText(rawMessage),
      backpressure,
      retryAfterSeconds: backpressure ? extractAiBackendRetryAfterSeconds(rawMessage) : undefined,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function withConnectedMcpClient<T>(
  config: LoadedMcpServerConfig,
  repoRoot: string,
  label: string,
  callback: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });

  try {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...process.env,
        ...config.env,
      },
      cwd: config.cwd ? path.resolve(repoRoot, config.cwd) : repoRoot,
    } as any);

    await withTimeout(
      client.connect(transport),
      MCP_INSPECTION_TIMEOUT_MS,
      `${label} connect`,
    );
    return await callback(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function summarizeMcpCallResult(result: unknown): { summary: string; preview: string; failed: boolean } {
  const fragments: string[] = [];
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  const content = Array.isArray(record?.content) ? record.content : [];

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const typedItem = item as Record<string, any>;
    if (typedItem.type === 'text' && typeof typedItem.text === 'string') {
      fragments.push(typedItem.text.trim());
      continue;
    }
    if (typedItem.type === 'resource' && typedItem.resource && typeof typedItem.resource === 'object') {
      if (typeof typedItem.resource.text === 'string' && typedItem.resource.text.trim()) {
        fragments.push(typedItem.resource.text.trim());
      } else if (typeof typedItem.resource.uri === 'string' && typedItem.resource.uri.trim()) {
        fragments.push(`[resource] ${typedItem.resource.uri.trim()}`);
      }
      continue;
    }
    if (typedItem.type === 'resource_link' && typeof typedItem.uri === 'string' && typedItem.uri.trim()) {
      fragments.push(`[resource-link] ${typedItem.uri.trim()}`);
      continue;
    }
    if (typedItem.type === 'image' && typeof typedItem.mimeType === 'string') {
      fragments.push(`[image:${typedItem.mimeType}]`);
      continue;
    }
    if (typedItem.type === 'audio' && typeof typedItem.mimeType === 'string') {
      fragments.push(`[audio:${typedItem.mimeType}]`);
    }
  }

  if (fragments.length === 0 && record?.structuredContent !== undefined) {
    fragments.push(JSON.stringify(record.structuredContent));
  }
  if (fragments.length === 0 && record?.content !== undefined) {
    fragments.push(JSON.stringify(record.content));
  }
  if (fragments.length === 0 && result !== undefined) {
    fragments.push(JSON.stringify(result));
  }

  const preview = truncateTextMiddle(
    fragments.filter(Boolean).join('\n\n') || 'Tool completed without textual output.',
    MCP_ACTION_OUTPUT_PREVIEW_MAX_CHARS,
  );
  const summary = truncateTextMiddle(
    preview
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' '),
    320,
  ) || 'Tool completed without textual output.';

  const failed = record?.isError === true
    || /^#+\s*error\b/i.test(summary)
    || /^error[:\s]/i.test(summary)
    || /failed to launch the browser process/i.test(preview)
    || /chromium distribution .* is not found/i.test(preview)
    || /browser has been closed/i.test(preview);

  return { summary, preview, failed };
}

function normalizeHttpUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') return '';
  const value = rawUrl.trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractMcpResultLinks(result: unknown): Array<{
  url: string;
  title: string;
  description: string;
  source: string;
}> {
  const links = new Map<string, { url: string; title: string; description: string; source: string }>();
  const pushLink = (candidate: {
    url?: unknown;
    title?: unknown;
    description?: unknown;
    source?: unknown;
  }): void => {
    const url = normalizeHttpUrl(candidate.url);
    if (!url) return;
    const existing = links.get(url);
    const next = {
      url,
      title: typeof candidate.title === 'string' ? candidate.title.trim() : '',
      description: typeof candidate.description === 'string' ? candidate.description.trim() : '',
      source: typeof candidate.source === 'string' ? candidate.source.trim() : '',
    };
    links.set(url, {
      url,
      title: existing?.title || next.title,
      description: existing?.description || next.description,
      source: existing?.source || next.source,
    });
  };

  const record = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  const structuredContent = record?.structuredContent && typeof record.structuredContent === 'object'
    ? record.structuredContent as Record<string, unknown>
    : null;

  if (Array.isArray(structuredContent?.results)) {
    for (const entry of structuredContent.results) {
      if (!entry || typeof entry !== 'object') continue;
      const typedEntry = entry as Record<string, unknown>;
      pushLink({
        url: typedEntry.url,
        title: typedEntry.title,
        description: typedEntry.description,
        source: typedEntry.source,
      });
    }
  }

  const content = Array.isArray(record?.content) ? record.content : [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const typedItem = item as Record<string, unknown>;
    if (typedItem.type === 'resource_link') {
      pushLink({ url: typedItem.uri });
      continue;
    }
    if (typedItem.type === 'resource' && typedItem.resource && typeof typedItem.resource === 'object') {
      pushLink({ url: (typedItem.resource as Record<string, unknown>).uri });
      continue;
    }
    if (typedItem.type === 'text' && typeof typedItem.text === 'string') {
      const urlMatches = typedItem.text.match(/^URL:\s*(\S+)/gm) || [];
      for (const match of urlMatches) {
        pushLink({ url: match.replace(/^URL:\s*/i, '').trim() });
      }
    }
  }

  return Array.from(links.values()).slice(0, 4);
}

async function listAllMcpTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    const result = cursor
      ? await client.listTools({ cursor })
      : await client.listTools();

    const pageTools = Array.isArray(result?.tools) ? result.tools : [];
    for (const tool of pageTools) {
      tools.push(McpToolSchema.parse({
        server: '',
        name: String(tool?.name || ''),
        description: typeof tool?.description === 'string' ? tool.description : '',
        inputSchema: tool?.inputSchema,
      }));
    }

    cursor = typeof result?.nextCursor === 'string' && result.nextCursor.trim().length > 0
      ? result.nextCursor
      : undefined;
    pageCount += 1;
  } while (cursor && pageCount < MCP_MAX_TOOL_PAGES);

  return tools;
}

async function inspectMcpServer(config: LoadedMcpServerConfig, repoRoot: string): Promise<McpInspection> {
  if (config.disabled) {
    return McpInspectionSchema.parse({
      server: config.name,
      status: 'skipped',
      message: 'Disabled in MCP config.',
      tools: [],
    });
  }

  if (config.type !== 'stdio') {
    return McpInspectionSchema.parse({
      server: config.name,
      status: 'skipped',
      message: `Unsupported MCP transport type: ${config.type}`,
      tools: [],
    });
  }

  const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });

  try {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...process.env,
        ...config.env,
      },
      cwd: config.cwd ? path.resolve(repoRoot, config.cwd) : repoRoot,
    } as any);

    await withTimeout(client.connect(transport), MCP_INSPECTION_TIMEOUT_MS, `MCP server ${config.name} connect`);
    const discoveredTools = await withTimeout(listAllMcpTools(client), MCP_INSPECTION_TIMEOUT_MS, `MCP server ${config.name} listTools`);
    const filteredTools = discoveredTools
      .filter((tool) => tool.name.trim().length > 0)
      .filter((tool) => !config.disabledTools.includes(tool.name))
      .map((tool) => McpToolSchema.parse({
        ...tool,
        server: config.name,
      }));

    const allowedTools = config.alwaysAllow.filter((toolName) => filteredTools.some((tool) => tool.name === toolName));
    const messageParts = [`Discovered ${filteredTools.length} tool(s).`];
    if (allowedTools.length > 0) {
      messageParts.push(`alwaysAllow=${allowedTools.join(', ')}`);
    }
    if (config.disabledTools.length > 0) {
      messageParts.push(`disabledTools=${config.disabledTools.join(', ')}`);
    }

    return McpInspectionSchema.parse({
      server: config.name,
      status: 'connected',
      message: messageParts.join(' '),
      tools: filteredTools,
    });
  } catch (error: any) {
    return McpInspectionSchema.parse({
      server: config.name,
      status: 'failed',
      message: redactSensitiveText(error?.stack || error?.message || String(error)),
      tools: [],
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function buildNoteJob(id: string, title: string, command: string): PlannedJob {
  return {
    id,
    target: 'meta',
    kind: 'note',
    title,
    command,
  };
}

function buildScopeJobs(
  scopes: string[],
  kind: 'build' | 'test',
): PlannedJob[] {
  const jobs: PlannedJob[] = [];
  const normalizedScopes = uniqueScopes(scopes);
  const seenCommands = new Set<string>();
  const shouldSkipAggregateRepoJob = normalizedScopes.includes('repo')
    && normalizedScopes.some((scope) => ['api', 'api-experimental', 'control-plane', 'repo-surface'].includes(scope));

  for (const scope of normalizedScopes) {
    if (scope === 'repo' && shouldSkipAggregateRepoJob) {
      continue;
    }

    const commands = SCOPE_COMMANDS[scope];
    if (!commands) {
      continue;
    }

    const command = kind === 'build' ? commands.build : commands.test;
    const normalizedCommand = String(command || '').trim();
    if (!normalizedCommand || seenCommands.has(normalizedCommand)) {
      continue;
    }
    seenCommands.add(normalizedCommand);

    jobs.push({
      id: `${scope}-${kind}`,
      target: scope,
      kind,
      title: `${kind === 'build' ? 'Build' : 'Test'} ${scope}`,
      command: normalizedCommand,
    });
  }

  return jobs;
}

function resolveMcpConfigPath(state: ControlPlaneState): string {
  const provided = String(state.mcpConfigPath || '').trim();
  if (provided) return path.resolve(state.repoRoot, provided);
  return path.resolve(state.repoRoot, '.roo', 'mcp.json');
}

function splitConfiguredRepoPaths(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasExecutable(command: string): boolean {
  const normalized = String(command || '').trim();
  if (!normalized) return false;
  if (executableAvailabilityCache.has(normalized)) {
    return executableAvailabilityCache.get(normalized) === true;
  }

  const probe = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(normalized)} >/dev/null 2>&1`], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
  });
  const exists = probe.status === 0;
  executableAvailabilityCache.set(normalized, exists);
  return exists;
}

function resolveCodeQlBinaryPath(state: Pick<ControlPlaneState, 'repoRoot'>): string {
  const configuredBinary = String(process.env.CONTROL_PLANE_CODEQL_BIN || '').trim();
  if (configuredBinary) return configuredBinary;

  const localCandidates = [
    path.resolve(state.repoRoot, '.tools', 'codeql-bundle', 'codeql', 'codeql'),
    path.resolve(state.repoRoot, '.tools', 'codeql', 'codeql', 'codeql'),
    path.resolve(state.repoRoot, 'tools', 'codeql-bundle', 'codeql', 'codeql'),
    path.resolve(state.repoRoot, 'tools', 'codeql', 'codeql', 'codeql'),
  ];
  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'codeql';
}

function parseGitHubRepoSlugFromRemoteUrl(remoteUrl: string): string | null {
  const normalized = String(remoteUrl || '').trim();
  if (!normalized) return null;

  const httpsMatch = normalized.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  return null;
}

async function resolveGitHubRepositorySlug(state: Pick<ControlPlaneState, 'repoRoot'>): Promise<string | null> {
  const cached = gitHubRepoSlugCache.get(state.repoRoot);
  if (typeof cached !== 'undefined') return cached;

  const configured = String(
    process.env.CONTROL_PLANE_GITHUB_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || '',
  ).trim();
  if (configured) {
    gitHubRepoSlugCache.set(state.repoRoot, configured);
    return configured;
  }

  const remoteResult = await runShellCommand('git remote get-url origin', path.resolve(state.repoRoot), {
    timeoutMs: 5_000,
  });
  if (remoteResult.exitCode !== 0) {
    gitHubRepoSlugCache.set(state.repoRoot, null);
    return null;
  }

  const parsed = parseGitHubRepoSlugFromRemoteUrl(remoteResult.output);
  gitHubRepoSlugCache.set(state.repoRoot, parsed);
  return parsed;
}

function buildGitHubCodeQlAlertInsight(
  state: Pick<ControlPlaneState, 'repoRoot'>,
  repoSlug: string,
  alerts: Array<Record<string, any>>,
): LogInsight | null {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const alert of alerts.slice(0, GITHUB_CODEQL_ALERT_LIMIT)) {
    const ruleId = String(alert?.rule?.id || '').trim() || 'unknown-rule';
    const severity = String(
      alert?.rule?.security_severity_level
      || alert?.rule?.severity
      || 'warning',
    ).trim().toLowerCase();
    const locationPath = String(alert?.most_recent_instance?.location?.path || '').trim();
    const locationLine = Number(alert?.most_recent_instance?.location?.start_line || 0);
    const message = sanitizeLogLine(
      String(
        alert?.most_recent_instance?.message?.text
        || alert?.rule?.description
        || alert?.rule?.name
        || ruleId,
      ),
    );
    const locationLabel = locationPath
      ? `${locationPath}${locationLine > 0 ? `:${locationLine}` : ''}`
      : repoSlug;
    const summary = `GitHub CodeQL ${severity} ${ruleId} at ${locationLabel} — ${message} (#${alert?.number ?? 'n/a'}, state=${String(alert?.state || 'unknown')})`;
    if (seen.has(summary)) continue;
    seen.add(summary);
    lines.push(summary);
  }

  if (lines.length === 0) return null;
  return LogInsightSchema.parse({
    file: `github-codeql:${repoSlug}`,
    lines,
  });
}

function buildGitHubCodeQlAnalysisNotes(
  repoSlug: string,
  analyses: Array<Record<string, any>>,
  openAlertCount: number,
): string[] {
  const notes: string[] = [];
  if (openAlertCount > 0) {
    notes.push(`GitHub CodeQL sync: ${openAlertCount} open CodeQL alert(s) are active for ${repoSlug}.`);
  } else {
    notes.push(`GitHub CodeQL sync: no open CodeQL alerts are active for ${repoSlug}.`);
  }

  const latest = analyses[0];
  if (!latest) return notes;

  const ref = String(latest.ref || '').replace(/^refs\/heads\//, '').trim() || 'unknown-ref';
  const createdAt = String(latest.created_at || '').trim() || 'unknown-time';
  const resultsCount = Number(latest.results_count || 0);
  const rulesCount = Number(latest.rules_count || 0);
  const category = String(latest.category || latest.analysis_key || '').trim();
  const toolVersion = String(latest.tool?.version || '').trim();
  notes.push(
    `GitHub CodeQL latest analysis for ${repoSlug}: ref=${ref}, created_at=${createdAt}, results=${resultsCount}, rules=${rulesCount}${category ? `, category=${category}` : ''}${toolVersion ? `, tool=${toolVersion}` : ''}.`,
  );
  return notes;
}

function buildGitHubCodeQlWorkflowNotes(
  repoSlug: string,
  workflowRuns: Array<Record<string, any>>,
  defaultSetupState: string,
  advancedWorkflowPresent: boolean,
): string[] {
  const notes: string[] = [];
  notes.push(`GitHub CodeQL default setup state for ${repoSlug}: ${defaultSetupState || 'unknown'}.`);
  if (advancedWorkflowPresent && defaultSetupState === 'configured') {
    notes.push(`GitHub CodeQL warning for ${repoSlug}: default setup is still configured while .github/workflows/codeql.yml advanced setup is present; advanced SARIF processing can fail until default setup is disabled.`);
  }

  const latest = workflowRuns[0];
  if (!latest) return notes;

  const status = String(latest.status || '').trim() || 'unknown';
  const conclusion = String(latest.conclusion || '').trim() || 'in_progress';
  const createdAt = String(latest.createdAt || latest.created_at || '').trim() || 'unknown-time';
  const updatedAt = String(latest.updatedAt || latest.updated_at || '').trim() || 'unknown-time';
  const event = String(latest.event || '').trim() || 'unknown-event';
  const url = String(latest.url || latest.html_url || '').trim();
  notes.push(
    `GitHub CodeQL workflow latest run for ${repoSlug}: status=${status}, conclusion=${conclusion}, event=${event}, created_at=${createdAt}, updated_at=${updatedAt}${url ? `, url=${url}` : ''}.`,
  );
  return notes;
}

function buildGitHubDependabotAlertInsight(
  state: Pick<ControlPlaneState, 'repoRoot'>,
  repoSlug: string,
  alerts: Array<Record<string, any>>,
): LogInsight | null {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const alert of alerts.slice(0, GITHUB_DEPENDABOT_ALERT_LIMIT)) {
    const packageName = String(alert?.dependency?.package?.name || '').trim() || 'unknown-package';
    const manifestPath = String(alert?.dependency?.manifest_path || '').trim() || repoSlug;
    const severity = String(alert?.security_advisory?.severity || alert?.security_vulnerability?.severity || 'unknown').trim().toLowerCase();
    const summary = sanitizeLogLine(
      String(alert?.security_advisory?.summary || alert?.security_advisory?.description || packageName),
    );
    const identifier = String(alert?.security_advisory?.ghsa_id || alert?.security_advisory?.cve_id || '').trim() || 'unknown-advisory';
    const line = `GitHub Dependabot ${severity} ${identifier} in ${manifestPath} (${packageName}) — ${summary} (#${alert?.number ?? 'n/a'}, state=${String(alert?.state || 'unknown')})`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }

  if (lines.length === 0) return null;
  return LogInsightSchema.parse({
    file: `github-dependabot:${repoSlug}`,
    lines,
  });
}

function buildGitHubDependabotNotes(
  repoSlug: string,
  alerts: Array<Record<string, any>>,
): string[] {
  const notes: string[] = [];
  if (alerts.length === 0) {
    notes.push(`GitHub Dependabot sync: no open Dependabot alert(s) are active for ${repoSlug}.`);
    return notes;
  }

  notes.push(`GitHub Dependabot sync: ${alerts.length} open Dependabot alert(s) are active for ${repoSlug}.`);
  const severityCounts = new Map<string, number>();
  for (const alert of alerts) {
    const severity = String(alert?.security_advisory?.severity || alert?.security_vulnerability?.severity || 'unknown').trim().toLowerCase() || 'unknown';
    severityCounts.set(severity, (severityCounts.get(severity) || 0) + 1);
  }
  const severitySummary = [...severityCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([severity, count]) => `${severity}=${count}`)
    .join(', ');
  if (severitySummary) {
    notes.push(`GitHub Dependabot severity mix for ${repoSlug}: ${severitySummary}.`);
  }
  return notes;
}

async function fetchGitHubCodeQlSync(
  state: Pick<ControlPlaneState, 'repoRoot'>,
): Promise<{ insights: LogInsight[]; notes: string[] }> {
  if (!GITHUB_CODEQL_SYNC_ENABLED || !hasExecutable('gh')) {
    return { insights: [], notes: [] };
  }

  const repoSlug = await resolveGitHubRepositorySlug(state);
  if (!repoSlug) {
    return { insights: [], notes: [] };
  }

  const cached = gitHubCodeQlSyncCache.get(repoSlug);
  if (cached && Date.now() - cached.checkedAtMs <= GITHUB_CODEQL_SYNC_REFRESH_MS) {
    return {
      insights: cached.insights,
      notes: cached.notes,
    };
  }

  const inflight = gitHubCodeQlSyncInflightCache.get(repoSlug);
  if (inflight) return inflight;

  const syncPromise = (async () => {
    const alertsCommand = `gh api ${shellEscapeCommandArg(`repos/${repoSlug}/code-scanning/alerts?tool_name=CodeQL&state=open&per_page=${GITHUB_CODEQL_ALERT_LIMIT}`)}`;
    const analysesCommand = `gh api ${shellEscapeCommandArg(`repos/${repoSlug}/code-scanning/analyses?tool_name=CodeQL&per_page=${GITHUB_CODEQL_ANALYSIS_LIMIT}`)}`;
    const defaultSetupCommand = `gh api ${shellEscapeCommandArg(`repos/${repoSlug}/code-scanning/default-setup`)}`;
    const workflowRunsCommand = `gh run list --workflow codeql.yml --limit ${GITHUB_CODEQL_WORKFLOW_RUN_LIMIT} --json databaseId,status,conclusion,createdAt,updatedAt,url,event`;

    const [alertsResult, analysesResult, defaultSetupResult, workflowRunsResult] = await Promise.all([
      runShellCommand(alertsCommand, path.resolve(state.repoRoot), { timeoutMs: GITHUB_CODEQL_API_TIMEOUT_MS }),
      runShellCommand(analysesCommand, path.resolve(state.repoRoot), { timeoutMs: GITHUB_CODEQL_API_TIMEOUT_MS }),
      runShellCommand(defaultSetupCommand, path.resolve(state.repoRoot), { timeoutMs: GITHUB_CODEQL_API_TIMEOUT_MS }),
      runShellCommand(workflowRunsCommand, path.resolve(state.repoRoot), { timeoutMs: GITHUB_CODEQL_API_TIMEOUT_MS }),
    ]);

    const alerts = alertsResult.exitCode === 0
      ? (JSON.parse(alertsResult.output.trim() || '[]') as Array<Record<string, any>>)
      : [];
    const analyses = analysesResult.exitCode === 0
      ? (JSON.parse(analysesResult.output.trim() || '[]') as Array<Record<string, any>>)
      : [];
    const defaultSetup = defaultSetupResult.exitCode === 0
      ? (JSON.parse(defaultSetupResult.output.trim() || '{}') as Record<string, any>)
      : {};
    const workflowRuns = workflowRunsResult.exitCode === 0
      ? (JSON.parse(workflowRunsResult.output.trim() || '[]') as Array<Record<string, any>>)
      : [];

    const insight = buildGitHubCodeQlAlertInsight(state, repoSlug, alerts);
    const insights = insight ? [insight] : [];
    const notes = [
      ...buildGitHubCodeQlAnalysisNotes(repoSlug, analyses, alerts.length),
      ...buildGitHubCodeQlWorkflowNotes(
        repoSlug,
        workflowRuns,
        String(defaultSetup?.state || '').trim() || 'unknown',
        fs.existsSync(path.resolve(state.repoRoot, '.github', 'workflows', 'codeql.yml')),
      ),
    ];

    const snapshot = {
      checkedAtMs: Date.now(),
      insights,
      notes,
    };
    gitHubCodeQlSyncCache.set(repoSlug, snapshot);
    return {
      insights,
      notes,
    };
  })().catch((error: unknown) => ({
    insights: [],
    notes: [`GitHub CodeQL sync failed: ${sanitizeLogLine(error instanceof Error ? error.message : String(error))}`],
  })).finally(() => {
    gitHubCodeQlSyncInflightCache.delete(repoSlug);
  });

  gitHubCodeQlSyncInflightCache.set(repoSlug, syncPromise);
  return syncPromise;
}

async function fetchGitHubDependabotSync(
  state: Pick<ControlPlaneState, 'repoRoot'>,
): Promise<{ insights: LogInsight[]; notes: string[] }> {
  if (!GITHUB_DEPENDABOT_SYNC_ENABLED || !hasExecutable('gh')) {
    return { insights: [], notes: [] };
  }

  const repoSlug = await resolveGitHubRepositorySlug(state);
  if (!repoSlug) {
    return { insights: [], notes: [] };
  }

  const cached = gitHubDependabotSyncCache.get(repoSlug);
  if (cached && Date.now() - cached.checkedAtMs <= GITHUB_DEPENDABOT_SYNC_REFRESH_MS) {
    return {
      insights: cached.insights,
      notes: cached.notes,
    };
  }

  const inflight = gitHubDependabotSyncInflightCache.get(repoSlug);
  if (inflight) return inflight;

  const syncPromise = (async () => {
    const alertsCommand = `gh api ${shellEscapeCommandArg(`repos/${repoSlug}/dependabot/alerts?state=open&per_page=${GITHUB_DEPENDABOT_ALERT_LIMIT}`)}`;
    const alertsResult = await runShellCommand(alertsCommand, path.resolve(state.repoRoot), {
      timeoutMs: GITHUB_CODEQL_API_TIMEOUT_MS,
    });
    const alerts = alertsResult.exitCode === 0
      ? (JSON.parse(alertsResult.output.trim() || '[]') as Array<Record<string, any>>)
      : [];

    const insight = buildGitHubDependabotAlertInsight(state, repoSlug, alerts);
    const insights = insight ? [insight] : [];
    const notes = buildGitHubDependabotNotes(repoSlug, alerts);

    const snapshot = {
      checkedAtMs: Date.now(),
      insights,
      notes,
    };
    gitHubDependabotSyncCache.set(repoSlug, snapshot);
    return {
      insights,
      notes,
    };
  })().catch((error: unknown) => ({
    insights: [],
    notes: [`GitHub Dependabot sync failed: ${sanitizeLogLine(error instanceof Error ? error.message : String(error))}`],
  })).finally(() => {
    gitHubDependabotSyncInflightCache.delete(repoSlug);
  });

  gitHubDependabotSyncInflightCache.set(repoSlug, syncPromise);
  return syncPromise;
}

function normalizeMcpCommand(command: string, args: string[]): { command: string; args: string[] } {
  const normalizedCommand = String(command || '').trim();
  const normalizedArgs = [...args];
  const isPlaywrightMcp = normalizedArgs.some((entry) => /@playwright\/mcp\b/.test(String(entry || '').trim()));
  const sandboxFlagsPresent = normalizedArgs.includes('--no-sandbox') || normalizedArgs.includes('--sandbox');

  if (isPlaywrightMcp && !sandboxFlagsPresent) {
    try {
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        normalizedArgs.push('--no-sandbox');
      }
    } catch {
      // Preserve configured args when uid detection is unavailable.
    }
  }

  if (normalizedCommand !== 'npx') {
    return { command: normalizedCommand, args: normalizedArgs };
  }

  if (hasExecutable('npx')) {
    return { command: normalizedCommand, args: normalizedArgs };
  }

  const fallbackCommand = String(process.env.CONTROL_PLANE_MCP_EXECUTABLE_FALLBACK || 'bunx').trim() || 'bunx';
  if (!hasExecutable(fallbackCommand)) {
    return { command: normalizedCommand, args: normalizedArgs };
  }

  const fallbackArgs = [...normalizedArgs];
  while (fallbackArgs[0] === '-y' || fallbackArgs[0] === '--yes') {
    fallbackArgs.shift();
  }
  return {
    command: fallbackCommand,
    args: fallbackArgs,
  };
}

function readTailLines(filePath: string, maxLines: number = 20): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => sanitizeLogLine(line))
      .filter(Boolean)
      .slice(-maxLines);
  } catch {
    return [];
  }
}

function getFileModifiedTimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function listRecentSarifFiles(directoryPath: string, maxFiles: number): string[] {
  if (!fs.existsSync(directoryPath)) return [];
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:sarif|sarif\.json)$/i.test(entry.name))
      .map((entry) => path.resolve(directoryPath, entry.name))
      .sort((left, right) => getFileModifiedTimeMs(right) - getFileModifiedTimeMs(left))
      .slice(0, maxFiles);
  } catch {
    return [];
  }
}

function listRecentCodeQlCandidatePaths(state: ControlPlaneState): string[] {
  const configuredCandidates = splitConfiguredRepoPaths(
    process.env.CONTROL_PLANE_CODEQL_RESULTS
    || process.env.CONTROL_PLANE_CODEQL_SARIF
    || process.env.CONTROL_PLANE_SARIF_RESULTS,
  ).map((candidate) => path.resolve(state.repoRoot, candidate));
  const seededCandidates = [
    path.resolve(state.repoRoot, 'codeql-results.sarif'),
    path.resolve(state.repoRoot, 'codeql-results.sarif.json'),
    path.resolve(state.repoRoot, '.codeql', 'api-codeql-results.sarif'),
    path.resolve(state.repoRoot, '.codeql', 'api-codeql-results.sarif.json'),
    path.resolve(state.repoRoot, '.codeql', 'control-plane-results.sarif'),
    path.resolve(state.repoRoot, '.codeql', 'control-plane-results.sarif.json'),
    path.resolve(state.repoRoot, '.codeql', 'repo-codeql-results.sarif'),
    path.resolve(state.repoRoot, '.codeql', 'repo-codeql-results.sarif.json'),
    path.resolve(state.repoRoot, 'reports', 'codeql-results.sarif'),
    path.resolve(state.repoRoot, 'reports', 'codeql-results.sarif.json'),
    path.resolve(state.repoRoot, 'logs', 'codeql-results.sarif'),
    path.resolve(state.repoRoot, 'logs', 'codeql-results.sarif.json'),
    path.resolve(state.repoRoot, '.github', 'codeql-results.sarif'),
    path.resolve(state.repoRoot, '.github', 'codeql-results.sarif.json'),
    path.resolve(state.repoRoot, 'apps', 'langgraph-control-plane', '.control-plane', 'codeql-results.sarif'),
    path.resolve(state.repoRoot, 'apps', 'langgraph-control-plane', '.control-plane', 'codeql-results.sarif.json'),
  ];
  const discoveredCandidates = [
    ...listRecentSarifFiles(path.resolve(state.repoRoot, '.codeql'), CODEQL_RESULT_FILE_LIMIT),
    ...listRecentSarifFiles(path.resolve(state.repoRoot, 'reports'), CODEQL_RESULT_FILE_LIMIT),
    ...listRecentSarifFiles(path.resolve(state.repoRoot, 'logs'), CODEQL_RESULT_FILE_LIMIT),
    ...listRecentSarifFiles(path.resolve(state.repoRoot, '.github'), CODEQL_RESULT_FILE_LIMIT),
    ...listRecentSarifFiles(path.resolve(state.repoRoot, 'apps', 'langgraph-control-plane', '.control-plane'), CODEQL_RESULT_FILE_LIMIT),
  ];

  return Array.from(new Set([...configuredCandidates, ...seededCandidates, ...discoveredCandidates]))
    .filter((candidatePath) => fs.existsSync(candidatePath))
    .sort((left, right) => getFileModifiedTimeMs(right) - getFileModifiedTimeMs(left))
    .slice(0, CODEQL_RESULT_FILE_LIMIT);
}

type AutomaticCodeQlTarget = 'control-plane' | 'api' | 'repo' | null;

type AutomaticCodeQlLockMetadata = {
  pid: number;
  threadId: string;
  target: Exclude<AutomaticCodeQlTarget, null> | 'unknown';
  resultPath: string;
  sourceRoot: string;
  acquiredAt: string;
};

function resolveAutomaticCodeQlTarget(state: ControlPlaneState): AutomaticCodeQlTarget {
  const scopes = new Set(getEffectiveScopes(state));
  const hasApiScope = (
    scopes.has('api')
    || scopes.has('api-experimental')
    || scopes.has('api-routing')
    || scopes.has('api-runtime')
    || scopes.has('api-data')
    || scopes.has('api-platform')
  );

  if (hasApiScope) return 'api';
  if (scopes.has('control-plane')) return 'control-plane';
  if (scopes.has('repo')) return 'repo';
  return null;
}

function shouldAutoRunCodeQl(state: ControlPlaneState): boolean {
  if (!CODEQL_AUTORUN_ENABLED) return false;
  return resolveAutomaticCodeQlTarget(state) !== null;
}

function resolveAutomaticCodeQlLockPath(state: ControlPlaneState): string {
  const configured = String(process.env.CONTROL_PLANE_CODEQL_LOCK_PATH || '').trim();
  if (configured) return path.resolve(state.repoRoot, configured);

  const resultPath = resolveAutomaticCodeQlResultPath(state);
  const parsed = path.parse(resultPath);
  return path.resolve(parsed.dir, `${parsed.name}.lock`);
}

function resolveAutomaticCodeQlResultPath(state: ControlPlaneState): string {
  const configured = String(process.env.CONTROL_PLANE_CODEQL_RESULT_PATH || '').trim();
  if (configured) return path.resolve(state.repoRoot, configured);

  const target = resolveAutomaticCodeQlTarget(state);
  if (target === 'api') {
    return path.resolve(state.repoRoot, '.codeql', 'api-codeql-results.sarif');
  }
  if (target === 'control-plane') {
    return path.resolve(state.repoRoot, '.codeql', 'control-plane-results.sarif');
  }

  return path.resolve(state.repoRoot, '.codeql', 'repo-codeql-results.sarif');
}

function resolveAutomaticCodeQlDatabasePath(state: ControlPlaneState): string {
  const configured = String(process.env.CONTROL_PLANE_CODEQL_DATABASE_PATH || '').trim();
  if (configured) return path.resolve(state.repoRoot, configured);

  const target = resolveAutomaticCodeQlTarget(state);
  const databaseName = target === 'api'
    ? 'api-db-javascript'
    : target === 'control-plane'
      ? 'control-plane-db-javascript'
      : 'repo-db-javascript';
  return path.resolve(state.repoRoot, '.codeql', databaseName);
}

function resolveAutomaticCodeQlSourceRoot(state: ControlPlaneState): string {
  const configured = String(process.env.CONTROL_PLANE_CODEQL_SOURCE_ROOT || '').trim();
  if (configured) return path.resolve(state.repoRoot, configured);

  const target = resolveAutomaticCodeQlTarget(state);
  const apiRoot = path.resolve(state.repoRoot, 'apps', 'api');
  const controlPlaneRoot = path.resolve(state.repoRoot, 'apps', 'langgraph-control-plane');
  if (target === 'api' && fs.existsSync(apiRoot)) {
    return apiRoot;
  }
  if (target === 'control-plane' && fs.existsSync(controlPlaneRoot)) {
    return controlPlaneRoot;
  }

  return state.repoRoot;
}

function shouldTrackCodeQlSourceFreshness(state: ControlPlaneState, sourceRoot: string): boolean {
  const normalizedSourceRoot = path.resolve(sourceRoot);
  return fs.existsSync(normalizedSourceRoot);
}

function getNewestCodeQlSourceState(sourceRoot: string): { newestSourceMtimeMs: number; newestSourcePath: string } {
  const normalizedSourceRoot = path.resolve(sourceRoot);
  if (!fs.existsSync(normalizedSourceRoot)) {
    return { newestSourceMtimeMs: 0, newestSourcePath: '' };
  }

  const cached = codeQlSourceFreshnessCache.get(normalizedSourceRoot);
  if (cached && Date.now() - cached.checkedAtMs <= CODEQL_SOURCE_FRESHNESS_REFRESH_MS) {
    return {
      newestSourceMtimeMs: cached.newestSourceMtimeMs,
      newestSourcePath: cached.newestSourcePath,
    };
  }

  const ignoredDirectoryNames = new Set([
    '.git',
    '.hg',
    '.svn',
    '.codeql',
    '.codeql-test',
    '.control-plane',
    '.tools',
    '.turbo',
    'coverage',
    'dist',
    'logs',
    'node_modules',
  ]);

  let newestSourceMtimeMs = 0;
  let newestSourcePath = '';
  const rootStats = fs.statSync(normalizedSourceRoot);
  if (rootStats.isFile()) {
    newestSourceMtimeMs = rootStats.mtimeMs || 0;
    newestSourcePath = normalizedSourceRoot;
  } else {
    const pendingDirectories = [normalizedSourceRoot];
    while (pendingDirectories.length > 0) {
      const currentDirectory = pendingDirectories.pop();
      if (!currentDirectory) continue;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (ignoredDirectoryNames.has(entry.name)) continue;
          pendingDirectories.push(path.resolve(currentDirectory, entry.name));
          continue;
        }

        if (!entry.isFile()) continue;
        const entryPath = path.resolve(currentDirectory, entry.name);
        const modifiedTimeMs = getFileModifiedTimeMs(entryPath);
        if (modifiedTimeMs > newestSourceMtimeMs) {
          newestSourceMtimeMs = modifiedTimeMs;
          newestSourcePath = entryPath;
        }
      }
    }
  }

  codeQlSourceFreshnessCache.set(normalizedSourceRoot, {
    checkedAtMs: Date.now(),
    newestSourceMtimeMs,
    newestSourcePath,
  });

  return { newestSourceMtimeMs, newestSourcePath };
}

function countCodeQlSarifFindings(filePath: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
    const runs = Array.isArray(parsed?.runs) ? parsed.runs : [];
    return runs.reduce((total, run) => total + (Array.isArray(run?.results) ? run.results.length : 0), 0);
  } catch {
    return 0;
  }
}

function shellEscapeCommandArg(value: string): string {
  return JSON.stringify(String(value));
}

function waitForMilliseconds(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function readAutomaticCodeQlLockMetadata(lockPath: string): AutomaticCodeQlLockMetadata | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as AutomaticCodeQlLockMetadata;
  } catch {
    return null;
  }
}

function releaseAutomaticCodeQlLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Ignore best-effort lock cleanup failures.
  }
}

function tryAcquireAutomaticCodeQlLock(lockPath: string, metadata: AutomaticCodeQlLockMetadata): boolean {
  try {
    const handle = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(handle, JSON.stringify(metadata, null, 2), 'utf8');
    } finally {
      fs.closeSync(handle);
    }
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

function isAutomaticCodeQlLockStale(
  lockPath: string,
  metadata: AutomaticCodeQlLockMetadata | null,
  staleAfterMs: number,
): boolean {
  const modifiedTimeMs = getFileModifiedTimeMs(lockPath);
  if (modifiedTimeMs <= 0) return true;
  const ageMs = Date.now() - modifiedTimeMs;
  const pid = Number(metadata?.pid ?? 0);
  if (Number.isInteger(pid) && pid > 0) {
    return !isProcessRunning(pid) || ageMs > staleAfterMs;
  }
  return ageMs > staleAfterMs;
}

async function acquireAutomaticCodeQlLock(
  state: ControlPlaneState,
  lockPath: string,
  resultPath: string,
  sourceRoot: string,
  codeQlTimeoutMs: number,
): Promise<{ acquired: true } | { acquired: false; reason: string }> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const staleAfterMs = Math.max(CODEQL_LOCK_STALE_MS, codeQlTimeoutMs + CODEQL_LOCK_POLL_MS);
  const waitTimeoutMs = Math.max(CODEQL_LOCK_TIMEOUT_MS, staleAfterMs + CODEQL_LOCK_POLL_MS);
  const startTimeMs = Date.now();
  const metadata: AutomaticCodeQlLockMetadata = {
    pid: process.pid,
    threadId: String(state.threadId || ''),
    target: resolveAutomaticCodeQlTarget(state) ?? 'unknown',
    resultPath,
    sourceRoot,
    acquiredAt: new Date().toISOString(),
  };

  while (true) {
    if (tryAcquireAutomaticCodeQlLock(lockPath, metadata)) {
      return { acquired: true };
    }

    const ownerMetadata = readAutomaticCodeQlLockMetadata(lockPath);
    if (isAutomaticCodeQlLockStale(lockPath, ownerMetadata, staleAfterMs)) {
      releaseAutomaticCodeQlLock(lockPath);
      continue;
    }

    if (Date.now() - startTimeMs >= waitTimeoutMs) {
      const ownerLabel = ownerMetadata?.threadId
        ? ` held by ${ownerMetadata.threadId}`
        : '';
      return {
        acquired: false,
        reason: `timed out waiting for CodeQL lock ${path.relative(state.repoRoot, lockPath).replace(/\\/g, '/')}${ownerLabel}`,
      };
    }

    await waitForMilliseconds(CODEQL_LOCK_POLL_MS);
  }
}

function describeAutomaticCodeQlFreshSarif(
  state: ControlPlaneState,
  resultPath: string,
  sourceRoot: string,
  resultRelativePath: string,
): {
  note: string | null;
  trackedSourceState: { newestSourceMtimeMs: number; newestSourcePath: string } | null;
  cachedSarifIsOlderThanTrackedSource: boolean;
} {
  const resultModifiedTimeMs = getFileModifiedTimeMs(resultPath);
  const resultAgeMs = Date.now() - resultModifiedTimeMs;
  const trackedSourceState = shouldTrackCodeQlSourceFreshness(state, sourceRoot)
    ? getNewestCodeQlSourceState(sourceRoot)
    : null;
  const cachedSarifIsOlderThanTrackedSource = Boolean(
    trackedSourceState
    && trackedSourceState.newestSourceMtimeMs > resultModifiedTimeMs,
  );

  if (
    fs.existsSync(resultPath)
    && resultAgeMs >= 0
    && resultAgeMs <= CODEQL_REFRESH_MS
    && !cachedSarifIsOlderThanTrackedSource
  ) {
    const findingCount = countCodeQlSarifFindings(resultPath);
    return {
      note: `CodeQL autorun: reusing fresh SARIF at ${resultRelativePath} (${findingCount} finding(s)).`,
      trackedSourceState,
      cachedSarifIsOlderThanTrackedSource,
    };
  }

  return {
    note: null,
    trackedSourceState,
    cachedSarifIsOlderThanTrackedSource,
  };
}

async function ensureAutomaticCodeQlSarif(state: ControlPlaneState): Promise<string[]> {
  if (!shouldAutoRunCodeQl(state)) return [];

  const resultPath = resolveAutomaticCodeQlResultPath(state);
  const sourceRoot = resolveAutomaticCodeQlSourceRoot(state);
  const resultRelativePath = path.relative(state.repoRoot, resultPath).replace(/\\/g, '/');
  const freshSarifState = describeAutomaticCodeQlFreshSarif(
    state,
    resultPath,
    sourceRoot,
    resultRelativePath,
  );
  if (freshSarifState.note) {
    return [freshSarifState.note];
  }

  const codeqlBinary = resolveCodeQlBinaryPath(state);
  const queryPack = String(process.env.CONTROL_PLANE_CODEQL_QUERY_PACK || 'codeql/javascript-queries').trim() || 'codeql/javascript-queries';
  const language = String(process.env.CONTROL_PLANE_CODEQL_LANGUAGE || 'javascript').trim() || 'javascript';
  const codeQlTimeoutMs = parsePositiveIntegerEnv('CONTROL_PLANE_CODEQL_TIMEOUT_MS', 20 * 60 * 1000, 60_000);
  const databasePath = resolveAutomaticCodeQlDatabasePath(state);
  const lockPath = resolveAutomaticCodeQlLockPath(state);
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const temporaryResultPath = `${resultPath}.tmp-${process.pid}-${Date.now()}`;

  const lockResult = await acquireAutomaticCodeQlLock(
    state,
    lockPath,
    resultPath,
    sourceRoot,
    codeQlTimeoutMs,
  );
  if (!lockResult.acquired) {
    const freshAfterWait = describeAutomaticCodeQlFreshSarif(
      state,
      resultPath,
      sourceRoot,
      resultRelativePath,
    );
    if (freshAfterWait.note) {
      return [freshAfterWait.note];
    }
    return [`CodeQL autorun failed for ${resultRelativePath}: ${lockResult.reason}`];
  }

  try {
    const freshAfterLock = describeAutomaticCodeQlFreshSarif(
      state,
      resultPath,
      sourceRoot,
      resultRelativePath,
    );
    if (freshAfterLock.note) {
      return [freshAfterLock.note];
    }

    fs.rmSync(databasePath, { recursive: true, force: true });
    fs.rmSync(temporaryResultPath, { force: true });

    const command = [
      `rm -rf ${shellEscapeCommandArg(databasePath)}`,
      `${shellEscapeCommandArg(codeqlBinary)} database create ${shellEscapeCommandArg(databasePath)} --language=${shellEscapeCommandArg(language)} --build-mode=none --source-root=${shellEscapeCommandArg(sourceRoot)}`,
      `${shellEscapeCommandArg(codeqlBinary)} database analyze ${shellEscapeCommandArg(databasePath)} ${shellEscapeCommandArg(queryPack)} --format=sarifv2.1.0 --output=${shellEscapeCommandArg(temporaryResultPath)} --threads=0 --download --no-print-diagnostics-summary --no-print-metrics-summary --sarif-category=${shellEscapeCommandArg('control-plane-autonomous')}`,
    ].join(' && ');

    const result = await runShellCommand(command, path.resolve(state.repoRoot), {
      timeoutMs: codeQlTimeoutMs,
    });

    if (result.exitCode !== 0 || result.timedOut || !fs.existsSync(temporaryResultPath)) {
      const failurePreview = sanitizeLogLine(result.output).slice(0, 320);
      return [
        `CodeQL autorun failed for ${resultRelativePath}${result.timedOut ? ' (timed out)' : ''}: ${failurePreview || `exit ${result.exitCode}`}`,
      ];
    }

    fs.renameSync(temporaryResultPath, resultPath);

    const postRunFreshSarifState = describeAutomaticCodeQlFreshSarif(
      state,
      resultPath,
      sourceRoot,
      resultRelativePath,
    );
    const findingCount = countCodeQlSarifFindings(resultPath);
    const freshnessSuffix = postRunFreshSarifState.cachedSarifIsOlderThanTrackedSource
      ? ` after source changes newer than the cached SARIF (${path.relative(state.repoRoot, postRunFreshSarifState.trackedSourceState?.newestSourcePath || sourceRoot).replace(/\\/g, '/')})`
      : '';
    return [`CodeQL autorun: generated ${resultRelativePath} with ${findingCount} finding(s)${freshnessSuffix}.`];
  } finally {
    fs.rmSync(temporaryResultPath, { force: true });
    releaseAutomaticCodeQlLock(lockPath);
  }
}

function resolveAutomaticCodeQlSourceRootForSarif(repoRoot: string, sarifPath: string): string {
  const configured = String(process.env.CONTROL_PLANE_CODEQL_SOURCE_ROOT || '').trim();
  if (configured) return path.resolve(repoRoot, configured);

  const normalizedSarifPath = path.resolve(sarifPath);
  const fileName = path.basename(normalizedSarifPath).toLowerCase();
  if (fileName.includes('api-codeql-results')) {
    return path.resolve(repoRoot, 'apps', 'api');
  }
  if (fileName.includes('control-plane-results')) {
    return path.resolve(repoRoot, 'apps', 'langgraph-control-plane');
  }
  return repoRoot;
}

function resolveCodeQlFindingBasePath(
  repoRoot: string,
  sarifPath: string,
  rawUriBaseId: string | undefined,
  originalUriBaseIds: Record<string, any> | undefined,
): string {
  const normalizedUriBaseId = String(rawUriBaseId || '').trim();
  if (!normalizedUriBaseId) return '';

  if (normalizedUriBaseId === '%SRCROOT%') {
    return resolveAutomaticCodeQlSourceRootForSarif(repoRoot, sarifPath);
  }

  const baseDescriptor = originalUriBaseIds && typeof originalUriBaseIds === 'object'
    ? originalUriBaseIds[normalizedUriBaseId]
    : undefined;
  const baseUri = typeof baseDescriptor?.uri === 'string'
    ? baseDescriptor.uri.trim()
    : '';
  if (!baseUri) return '';

  try {
    if (baseUri.startsWith('file://')) {
      return fileURLToPath(baseUri);
    }
    if (path.isAbsolute(baseUri)) {
      return baseUri;
    }
    return path.resolve(path.dirname(sarifPath), decodeURIComponent(baseUri));
  } catch {
    return '';
  }
}

function normalizeCodeQlFindingPath(
  repoRoot: string,
  sarifPath: string,
  rawUri: string | undefined,
  rawUriBaseId?: string,
  originalUriBaseIds?: Record<string, any>,
): string {
  const uri = String(rawUri || '').trim();
  if (!uri) return '';

  let resolvedPath = '';
  try {
    if (uri.startsWith('file://')) {
      resolvedPath = fileURLToPath(uri);
    } else if (path.isAbsolute(uri)) {
      resolvedPath = uri;
    } else {
      const decoded = decodeURIComponent(uri);
      const fromBasePath = resolveCodeQlFindingBasePath(
        repoRoot,
        sarifPath,
        rawUriBaseId,
        originalUriBaseIds,
      );
      if (fromBasePath) {
        resolvedPath = path.resolve(fromBasePath, decoded);
      } else {
        const fromRepoRoot = path.resolve(repoRoot, decoded);
        resolvedPath = fs.existsSync(fromRepoRoot)
          ? fromRepoRoot
          : path.resolve(path.dirname(sarifPath), decoded);
      }
    }
  } catch {
    return '';
  }

  const relativePath = path.relative(repoRoot, resolvedPath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) return '';
  return relativePath;
}

function summarizeCodeQlSarif(state: ControlPlaneState, sarifPath: string): LogInsight | null {
  try {
    const raw = fs.readFileSync(sarifPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, any>;
    const runs = Array.isArray(parsed?.runs) ? parsed.runs : [];
    const lines: string[] = [];
    const seen = new Set<string>();

    for (const run of runs) {
      const rules = new Map<string, any>(
        Array.isArray(run?.tool?.driver?.rules)
          ? run.tool.driver.rules
              .map((rule: any) => [String(rule?.id || '').trim(), rule] as const)
              .filter(([ruleId]: readonly [string, any]) => Boolean(ruleId))
          : [],
      );
      const results = Array.isArray(run?.results) ? run.results : [];
      for (const result of results) {
        const message = sanitizeLogLine(
          typeof result?.message?.text === 'string'
            ? result.message.text
            : typeof result?.message?.markdown === 'string'
              ? result.message.markdown
              : '',
        );
        const ruleId = String(result?.ruleId || '').trim();
        const rule = ruleId ? rules.get(ruleId) : undefined;
        const level = String(
          result?.level
          || rule?.defaultConfiguration?.level
          || 'warning',
        ).trim().toLowerCase() || 'warning';
        const primaryLocation = Array.isArray(result?.locations) ? result.locations[0] : undefined;
        const physicalLocation = primaryLocation?.physicalLocation;
        const findingPath = normalizeCodeQlFindingPath(
          state.repoRoot,
          sarifPath,
          typeof physicalLocation?.artifactLocation?.uri === 'string'
            ? physicalLocation.artifactLocation.uri
            : '',
          typeof physicalLocation?.artifactLocation?.uriBaseId === 'string'
            ? physicalLocation.artifactLocation.uriBaseId
            : '',
          run?.originalUriBaseIds && typeof run.originalUriBaseIds === 'object'
            ? run.originalUriBaseIds as Record<string, any>
            : undefined,
        );
        if (
          findingPath
          && (
            /(?:^|\/)dist\//.test(findingPath)
            || findingPath.endsWith('.d.ts')
          )
        ) {
          continue;
        }
        const lineNumber = typeof physicalLocation?.region?.startLine === 'number'
          ? physicalLocation.region.startLine
          : null;
        const ruleLabel = String(
          rule?.shortDescription?.text
          || rule?.name
          || ruleId
          || 'unnamed-rule',
        ).trim();
        const pathLabel = findingPath || path.relative(state.repoRoot, sarifPath).replace(/\\/g, '/');
        const lineLabel = lineNumber ? `:${lineNumber}` : '';
        const summary = `CodeQL ${level} ${ruleId || ruleLabel} at ${pathLabel}${lineLabel} — ${message || ruleLabel}`;
        if (seen.has(summary)) continue;
        seen.add(summary);
        lines.push(summary);
        if (lines.length >= CODEQL_RESULT_LINE_LIMIT) break;
      }
      if (lines.length >= CODEQL_RESULT_LINE_LIMIT) break;
    }

    if (lines.length === 0) return null;
    return LogInsightSchema.parse({
      file: `codeql:${path.relative(state.repoRoot, sarifPath).replace(/\\/g, '/')}`,
      lines,
    });
  } catch {
    return null;
  }
}

function listRecentLogCandidatePaths(state: ControlPlaneState): string[] {
  const logDir = path.resolve(state.repoRoot, 'apps', 'api', 'logs');
  const seededCandidates = [
    path.resolve(state.repoRoot, 'apps', 'api', 'logs', 'probe-errors.jsonl'),
    path.resolve(state.repoRoot, 'apps', 'api', 'logs', 'fast-image-sync.log'),
    path.resolve(state.repoRoot, 'apps', 'api', 'logs', 'admin-keys.jsonl'),
    path.resolve(state.repoRoot, 'apps', 'api', 'logs', 'api-error.jsonl'),
    path.resolve(state.repoRoot, 'apps', 'api', 'logs', 'api-errors.jsonl'),
    path.resolve(state.repoRoot, 'apps', 'langgraph-control-plane', 'studio-server.log'),
  ];
  const discoveredCandidates = fs.existsSync(logDir)
    ? fs.readdirSync(logDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(?:jsonl|log|txt)$/i.test(entry.name))
        .map((entry) => path.resolve(logDir, entry.name))
        .sort((left, right) => getFileModifiedTimeMs(right) - getFileModifiedTimeMs(left))
        .slice(0, 8)
    : [];

  return Array.from(new Set([...seededCandidates, ...discoveredCandidates]));
}

function resolveLogInsights(state: ControlPlaneState, supplementalInsights: LogInsight[] = []): LogInsight[] {
  const codeQlInsights = listRecentCodeQlCandidatePaths(state)
    .map((filePath) => summarizeCodeQlSarif(state, filePath))
    .filter((entry): entry is LogInsight => Boolean(entry));
  const fileLogInsights = listRecentLogCandidatePaths(state)
    .map((filePath) => ({ file: path.relative(state.repoRoot, filePath), lines: readTailLines(filePath, DEFAULT_LOG_TAIL_LINE_COUNT) }))
    .filter((entry) => entry.lines.length > 0)
    .map((entry) => LogInsightSchema.parse(entry))
    .map((entry) => filterLogInsightForScope(state, entry))
    .filter((entry): entry is LogInsight => Boolean(entry));
  return [...codeQlInsights, ...supplementalInsights, ...fileLogInsights]
    .map((entry) => filterLogInsightForScope(state, entry))
    .filter((entry): entry is LogInsight => Boolean(entry));
}

function buildRecentFailedAutonomousEditsPayload(state: ControlPlaneState): Array<Record<string, unknown>> {
  const appliedFailures = state.appliedEdits
    .filter((edit) => edit.status === 'failed')
    .map((edit) => ({
      type: edit.type,
      path: edit.path,
      reason: edit.reason,
      message: redactSensitiveText(edit.message),
      find: typeof edit.find === 'string'
        ? truncateTextMiddle(edit.find, Math.min(1200, AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS))
        : undefined,
      replace: typeof edit.replace === 'string'
        ? truncateTextMiddle(edit.replace, Math.min(1200, AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS))
        : undefined,
      content: typeof (edit as any).content === 'string'
        ? truncateTextMiddle((edit as any).content, Math.min(1200, AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS))
        : undefined,
    }));

  const syntheticFailures = state.autonomousEditNotes
    .map((note) => String(note || '').trim())
    .map((note) => note.match(/Skipped autonomous (replace|write) proposal for ([^:]+):\s*(.+)$/i))
    .flatMap((match) => {
      if (!match) return [];
      const type = String(match[1] || '').trim().toLowerCase();
      const path = String(match[2] || '').trim();
      const message = redactSensitiveText(String(match[3] || '').trim());
      if (!path || !message) return [];
      return [{
        type,
        path,
        reason: '',
        message,
      }];
    });

  return [...appliedFailures, ...syntheticFailures].slice(-4);
}

function extractMeaningfulAnchorLines(text: string, maxCount: number = 4): string[] {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 12)
    .slice(0, maxCount);
}

function buildFailedAutonomousEditAnchorHints(state: ControlPlaneState): Record<string, string[]> {
  const hints: Record<string, string[]> = {};
  const appendHints = (normalizedPath: string, message: string, find?: string): void => {
    if (!normalizedPath) return;
    const nextHints = [
      ...(hints[normalizedPath] || []),
      ...(typeof find === 'string' ? extractMeaningfulAnchorLines(find, 4) : []),
    ];
    const firstAnchorMatch = message.match(/First anchor fragment:\s*(.+)$/s);
    if (firstAnchorMatch) {
      nextHints.push(String(firstAnchorMatch[1] || '').split('\n')[0].trim());
    }
    const excerptMatch = message.match(/Closest anchor match around line \d+:\n([\s\S]*)$/);
    if (excerptMatch) {
      nextHints.push(...extractMeaningfulAnchorLines(String(excerptMatch[1] || ''), 4));
    }
    hints[normalizedPath] = uniqueNormalizedStrings(nextHints).slice(0, 8);
  };

  for (const edit of state.appliedEdits.filter((entry) => entry.status === 'failed').slice(-4)) {
    const normalizedPath = String(edit.path || '').trim();
    if (!normalizedPath) continue;
    appendHints(normalizedPath, String(edit.message || ''), typeof edit.find === 'string' ? edit.find : undefined);
  }

  for (const note of state.autonomousEditNotes.map((entry) => String(entry || '').trim()).slice(-16)) {
    const match = note.match(/Skipped autonomous replace proposal for ([^:]+):\s*(.+)$/i);
    if (!match) continue;
    appendHints(String(match[1] || '').trim(), String(match[2] || '').trim());
  }
  return hints;
}

function buildFailedAutonomousEditRefreshContexts(
  state: ControlPlaneState,
  preferredAnchorsByPath: Record<string, string[]>,
): Array<{ path: string; content: string; truncated: boolean }> {
  const failedPaths = Array.from(new Set(
    state.appliedEdits
      .filter((edit) => edit.status === 'failed')
      .map((edit) => String(edit.path || '').trim())
      .filter(Boolean),
  ));
  if (failedPaths.length === 0) return [];

  return readAutonomousEditContext(
    state.repoRoot,
    getEffectiveScopes(state),
    state.editAllowlist,
    state.editDenylist,
    {
      maxCharsPerFile: Math.max(12_000, AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS * 4),
      preferredAnchorsByPath,
      preferredPaths: failedPaths,
      maxFiles: failedPaths.length,
    },
  ).map((file) => ({
    ...file,
    content: truncateTextMiddle(file.content, Math.max(AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS * 2, 3_200)),
  }));
}

function isCompileShapeAutonomousEditFailure(message: string): boolean {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) return false;
  return /unused local symbols|declared but its value is never read|cannot redeclare block-scoped variable|duplicate identifier|duplicate function implementation|same-file typescript diagnostics|typecheck|build validation|compile validation/.test(normalized);
}

function isAnchorMismatchAutonomousEditFailure(message: string): boolean {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) return false;
  return /replace target text was not found|closest anchor match around line|replace edits must target an existing candidate file|replace edits must include a find block|matched \d+ times/.test(normalized);
}

function collectSyntheticAutonomousFailedPaths(
  state: Pick<ControlPlaneState, 'autonomousEditNotes'>,
  matcher: (message: string) => boolean,
): Set<string> {
  return new Set(
    state.autonomousEditNotes
      .map((note) => String(note || '').trim())
      .map((note) => note.match(/Skipped autonomous (replace|write) proposal for ([^:]+):\s*(.+)$/i))
      .flatMap((match) => {
        if (!match) return [];
        const path = String(match[2] || '').trim();
        const message = String(match[3] || '').trim();
        if (!path || !matcher(message)) return [];
        return [path];
      }),
  );
}

function collectRecentCompileShapeFailedPaths(
  state: Pick<ControlPlaneState, 'appliedEdits' | 'autonomousEditNotes'>,
): Set<string> {
  return new Set(
    [
      ...state.appliedEdits
        .filter((edit) => edit.status === 'failed')
        .filter((edit) => isCompileShapeAutonomousEditFailure(String(edit.message || '')))
        .map((edit) => String(edit.path || '').trim())
        .filter(Boolean),
      ...collectSyntheticAutonomousFailedPaths(state, isCompileShapeAutonomousEditFailure),
    ],
  );
}

function collectRecentAnchorMismatchFailedPaths(
  state: Pick<ControlPlaneState, 'appliedEdits' | 'autonomousEditNotes'>,
): Set<string> {
  return new Set(
    [
      ...state.appliedEdits
        .filter((edit) => edit.status === 'failed')
        .filter((edit) => isAnchorMismatchAutonomousEditFailure(String(edit.message || '')))
        .map((edit) => String(edit.path || '').trim())
        .filter(Boolean),
      ...collectSyntheticAutonomousFailedPaths(state, isAnchorMismatchAutonomousEditFailure),
    ],
  );
}

function shouldPivotApiRoutingAwayFromGeminiValidation(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'appliedEdits' | 'autonomousEditNotes'>,
): boolean {
  const sourceText = [
    ...state.repairSignals,
    ...state.improvementSignals,
  ].join(' | ').toLowerCase();
  if (!signalTextHasGeminiCapabilityDriftFocus(sourceText)) {
    return false;
  }

  return collectRecentCompileShapeFailedPaths(state).has('apps/api/modules/geminiMediaValidation.ts');
}

function shouldPivotApiDataAwayFromRefreshModels(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'appliedEdits' | 'autonomousEditNotes'>,
): boolean {
  const sourceText = [
    ...state.repairSignals,
    ...state.improvementSignals,
  ].join(' | ').toLowerCase();
  const dataAvailabilityFocus = signalTextHasApiCatalogDriftFocus(sourceText)
    || signalTextHasApiAvailabilityFocus(sourceText)
    || /provider_cap_blocked|provider_model_removed|image generation unavailable|lyria-3-pro-preview/.test(sourceText);
  if (!dataAvailabilityFocus) {
    return false;
  }

  return collectRecentCompileShapeFailedPaths(state).has('apps/api/dev/refreshModels.ts');
}

function shouldPivotApiDataAwayFromModelUpdater(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'appliedEdits' | 'autonomousEditNotes'>,
): boolean {
  const sourceText = [
    ...state.repairSignals,
    ...state.improvementSignals,
  ].join(' | ').toLowerCase();
  const dataAvailabilityFocus = signalTextHasApiCatalogDriftFocus(sourceText)
    || signalTextHasApiAvailabilityFocus(sourceText)
    || /provider_cap_blocked|provider_model_removed|image generation unavailable|lyria-3-pro-preview/.test(sourceText);
  if (!dataAvailabilityFocus) {
    return false;
  }

  return (
    collectRecentCompileShapeFailedPaths(state).has('apps/api/modules/modelUpdater.ts')
    || collectRecentAnchorMismatchFailedPaths(state).has('apps/api/modules/modelUpdater.ts')
  );
}

function shouldPivotApiRuntimeAwayFromRequestQueue(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'appliedEdits' | 'autonomousEditNotes'>,
): boolean {
  const sourceText = [
    ...state.repairSignals,
    ...state.improvementSignals,
  ].join(' | ').toLowerCase();
  if (!/request queue|queue|provider attempt|timeout|quota|billing|invalid_api_key|unauthorized|resource_exhausted|retry storm|retry amplification|provider churn/.test(sourceText)) {
    return false;
  }

  return collectRecentCompileShapeFailedPaths(state).has('apps/api/modules/requestQueue.ts');
}

function shouldPivotApiPlatformAwayFromExperimentalService(
  state: Pick<ControlPlaneState, 'appliedEdits' | 'autonomousEditNotes'>,
): boolean {
  return collectRecentAnchorMismatchFailedPaths(state).has('apps/api/anygpt-experimental.service');
}

function reasonAcknowledgesCompileShapeFailure(reason: string): boolean {
  const normalized = String(reason || '').trim().toLowerCase();
  if (!normalized) return false;
  return /unused|stale declaration|stale symbol|remove.*declaration|remove.*symbol|cleanup|clean up|compile failure|build validation|typecheck|dead code|redeclare|duplicate declaration|duplicate variable|duplicate identifier|rename.*variable|rename.*declaration/.test(normalized);
}

function reasonAcknowledgesAnchorMismatchFailure(reason: string): boolean {
  const normalized = String(reason || '').trim().toLowerCase();
  if (!normalized) return false;
  return /anchor|replace target|closest match|rewrite|full file|full-file|write action|current file shape|refresh.*block|refresh.*anchor|service-unit refresh|execstartpost/.test(normalized);
}

function reasonAddsHelperWithoutImmediateWiring(reason: string): boolean {
  const normalized = String(reason || '').trim().toLowerCase();
  if (!normalized) return false;

  const addsHelper = /(?:add|adds|adding|introduce|introduces|introducing|create|creates|creating).{0,40}(?:helper|detector|predicate|utility|wrapper)|(?:helper|detector|predicate|utility|wrapper)/.test(normalized);
  if (!addsHelper) return false;

  return !/(?:wire|wired|wiring|use|uses|using|consume|consumes|consuming|invoke|invokes|invoking|call site|callsite|replace existing|reuse existing|inline|in-place|branch rewrite|existing branch|same patch)/.test(normalized);
}

function isRepeatedFailedEditProposal(
  edit: AutonomousEditAction,
  recentFailedEdits: Array<Record<string, unknown>>,
): boolean {
  const normalizedPath = String(edit.path || '').trim();
  const normalizedType = String(edit.type || '').trim();
  const normalizedReason = String(edit.reason || '').trim();
  if (!normalizedPath || !normalizedType) return false;

  return recentFailedEdits.some((failedEdit) => {
    if (String(failedEdit.path || '').trim() !== normalizedPath) return false;
    if (String(failedEdit.type || '').trim() !== normalizedType) return false;

    const failedMessage = String(failedEdit.message || '').trim();
    if (isCompileShapeAutonomousEditFailure(failedMessage)) {
      if (!reasonAcknowledgesCompileShapeFailure(normalizedReason)) {
        return true;
      }
      if (
        /unused local symbols|declared but its value is never read/i.test(failedMessage)
        && reasonAddsHelperWithoutImmediateWiring(normalizedReason)
      ) {
        return true;
      }
      return false;
    }

    if (normalizedType === 'replace') {
      return String(failedEdit.find || '').trim() === String(edit.find || '').trim();
    }

    if (normalizedType === 'write') {
      return String(failedEdit.content || '').trim() === String((edit as any).content || '').trim();
    }

    return false;
  });
}

function chooseStrongestAutonomousEditPath(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'autonomousOperationMode' | 'scopes' | 'effectiveScopes'>,
  touchedPaths: string[],
  proposalReasonByPath: Map<string, string>,
): string | null {
  const normalizedPaths = Array.from(new Set(
    touchedPaths
      .map((entry) => String(entry || '').trim())
      .filter(Boolean),
  ));
  if (normalizedPaths.length === 0) return null;

  const ranked = normalizedPaths
    .map((candidatePath, index) => {
      const reason = proposalReasonByPath.get(candidatePath) || '';
      return {
        path: candidatePath,
        score: scoreAutonomousEditPathFit(state as ControlPlaneState, candidatePath, reason),
        documentationPenalty: /\.(md|mdx|txt)$/i.test(candidatePath) ? 1 : 0,
        reasonLength: reason.length,
        index,
      };
    })
    .sort((left, right) =>
      right.score - left.score
      || left.documentationPenalty - right.documentationPenalty
      || right.reasonLength - left.reasonLength
      || left.index - right.index
    );

  return ranked[0]?.path || null;
}

function maybeNarrowAutonomousEditBatchToStrongestPath(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'autonomousOperationMode' | 'scopes' | 'effectiveScopes'>,
  edits: AutonomousEditAction[],
  proposalReasonByPath: Map<string, string>,
): { edits: AutonomousEditAction[]; note: string } | null {
  const touchedPaths = Array.from(new Set(
    edits
      .map((edit) => String(edit.path || '').trim())
      .filter(Boolean),
  ));
  if (touchedPaths.length <= 1) return null;
  if (
    state.autonomousOperationMode === 'repair'
    && isTightlyCoupledAutonomousEditBatch(touchedPaths)
  ) {
    return null;
  }

  const strongestPath = chooseStrongestAutonomousEditPath(state, touchedPaths, proposalReasonByPath);
  if (!strongestPath) return null;

  const narrowedEdits = edits.filter((edit) => String(edit.path || '').trim() === strongestPath);
  if (narrowedEdits.length === 0 || narrowedEdits.length === edits.length) {
    return null;
  }

  const deferredPaths = touchedPaths.filter((candidatePath) => candidatePath !== strongestPath);
  return {
    edits: narrowedEdits,
    note: `Narrowed autonomous edit batch to ${strongestPath} to preserve bounded single-path scope; deferred ${deferredPaths.join(', ')} for a later iteration.`,
  };
}

function filterInvalidAutonomousEditProposals(
  state: ControlPlaneState,
  edits: AutonomousEditAction[],
  existingCandidatePaths: Set<string>,
): { accepted: AutonomousEditAction[]; notes: string[] } {
  const accepted: AutonomousEditAction[] = [];
  const notes: string[] = [];
  const rejectedPathPreflightMessages = new Map<string, string>();
  const avoidProviderPathEdits = shouldAvoidProviderPathAutonomousEdits(state.repairSignals);
  const restrictToControlPlane = shouldRestrictAutonomousEditsToControlPlane(state);
  const proposalReasonByPath = new Map<string, string>();
  for (const edit of edits) {
    const normalizedPath = String(edit.path || '').trim();
    const normalizedReason = String(edit.reason || '').trim();
    if (!normalizedPath || !normalizedReason) continue;
    const reasonParts = [proposalReasonByPath.get(normalizedPath), normalizedReason]
      .filter((value): value is string => Boolean(value));
    proposalReasonByPath.set(normalizedPath, reasonParts.join(' | '));
  }
  const allowScopedProviderPathEdits = shouldAllowScopedProviderPathAutonomousEdits(
    state,
    edits.map((edit) => String(edit.path || '').trim()),
    proposalReasonByPath,
  );
  const sourceText = [
    ...state.repairSignals,
    ...state.improvementSignals,
    ...state.plannerNotes.slice(-12),
  ].join(' | ').toLowerCase();
  const pricingCoverageFocus = signalTextHasPricingCoverageFocus(sourceText);
  const availabilityFocus = signalTextHasApiAvailabilityFocus(sourceText);
  const capabilityAuditFocus = signalTextHasCapabilityAuditFocus(sourceText);
  const geminiCapabilityDriftFocus = signalTextHasGeminiCapabilityDriftFocus(sourceText);
  const compileShapeFailedPaths = collectRecentCompileShapeFailedPaths(state);
  const controlPlaneCompileShapePivotPaths = new Set<string>(
    Array.from(compileShapeFailedPaths).filter((candidatePath) =>
      candidatePath === 'apps/langgraph-control-plane/src/workflow.ts'
      || candidatePath === 'apps/langgraph-control-plane/src/index.ts'),
  );
  const apiRoutingGeminiValidationPivot = shouldPivotApiRoutingAwayFromGeminiValidation(state);
  const apiDataRefreshModelsPivot = shouldPivotApiDataAwayFromRefreshModels(state);
  const apiDataModelUpdaterPivot = shouldPivotApiDataAwayFromModelUpdater(state);
  const apiRuntimeRequestQueuePivot = shouldPivotApiRuntimeAwayFromRequestQueue(state);
  const apiPlatformExperimentalServicePivot = shouldPivotApiPlatformAwayFromExperimentalService(state);
  const contractPaths = state.autonomousContractPaths
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

  for (const edit of edits) {
    const check = checkAutonomousEditPath(
      state.repoRoot,
      edit.path,
      state.editAllowlist,
      state.editDenylist,
    );
    if (!check.allowed) {
      notes.push(`Skipped autonomous edit proposal for ${edit.path}: ${check.reason}`);
      continue;
    }

    if (avoidProviderPathEdits && !allowScopedProviderPathEdits && check.normalizedPath.startsWith('apps/api/providers/')) {
      notes.push(`Skipped autonomous edit proposal for ${check.normalizedPath}: active repair signals are provider-bound, so autonomous provider-file edits are blocked for this iteration.`);
      continue;
    }

    if (restrictToControlPlane && !check.normalizedPath.startsWith('apps/langgraph-control-plane/')) {
      notes.push(`Skipped autonomous edit proposal for ${check.normalizedPath}: current signals are externally caused or repetitive, so this iteration is restricted to control-plane-only edits.`);
      continue;
    }

    if (
      isApiDataAuditHelperPath(check.normalizedPath)
      && (pricingCoverageFocus || availabilityFocus)
      && !capabilityAuditFocus
    ) {
      notes.push(`Skipped autonomous edit proposal for ${check.normalizedPath}: active api-data signals target source-of-truth model/provider data, so audit-helper edits are deferred until the underlying data files are fixed.`);
      continue;
    }

    if (contractPaths.length > 0 && !contractPaths.includes(check.normalizedPath)) {
      notes.push(`Skipped autonomous edit proposal for ${check.normalizedPath}: it falls outside the current autonomous contract paths (${contractPaths.join(', ')}).`);
      continue;
    }

    if (
      geminiCapabilityDriftFocus &&
      check.normalizedPath === 'apps/api/modules/openaiProviderSelection.ts'
    ) {
      const reasonText = String(edit.reason || '').toLowerCase();
      if (
        /provider_cap_blocked|provider_model_removed|image generation unavailable|lyria-3-pro-preview|audio\/s16le|function calling is not enabled|tool_calling_not_enabled/.test(
          reasonText,
        )
      ) {
        notes.push(
          `Skipped autonomous edit proposal for ${check.normalizedPath}: the active api-routing signal is a Gemini capability/regional-drift family, so prefer apps/api/modules/geminiMediaValidation.ts or apps/api/providers/handler.ts over openaiProviderSelection.ts.`,
        );
        continue;
      }
    }

    if (
      apiRoutingGeminiValidationPivot
      && check.normalizedPath === 'apps/api/modules/geminiMediaValidation.ts'
    ) {
      const reasonText = String(edit.reason || '').toLowerCase();
      if (!reasonAcknowledgesCompileShapeFailure(reasonText)) {
        notes.push(
          `Skipped autonomous edit proposal for ${check.normalizedPath}: a recent api-routing attempt on this file failed with duplicate declarations, so pivot to apps/api/providers/handler.ts unless the next proposal explicitly removes stale declarations or duplicate symbols.`,
        );
        continue;
      }
    }

    if (
      apiDataRefreshModelsPivot
      && check.normalizedPath === 'apps/api/dev/refreshModels.ts'
    ) {
      const reasonText = String(edit.reason || '').toLowerCase();
      if (!reasonAcknowledgesCompileShapeFailure(reasonText)) {
        notes.push(
          `Skipped autonomous edit proposal for ${check.normalizedPath}: a recent api-data attempt on this file failed with unused locals, so pivot to apps/api/modules/modelUpdater.ts, apps/api/dev/updateproviders.ts, apps/api/dev/updatemodels.ts, or apps/api/routes/models.ts unless the next proposal explicitly removes or wires the stale declarations.`,
        );
        continue;
      }
    }

    if (
      apiDataModelUpdaterPivot
      && check.normalizedPath === 'apps/api/modules/modelUpdater.ts'
    ) {
      const reasonText = String(edit.reason || '').toLowerCase();
      if (
        !reasonAcknowledgesCompileShapeFailure(reasonText)
        && !reasonAcknowledgesAnchorMismatchFailure(reasonText)
      ) {
        notes.push(
          `Skipped autonomous edit proposal for ${check.normalizedPath}: recent api-data attempts on this file hit stale anchors or unused locals, so pivot to apps/api/models.json, apps/api/pricing.json, apps/api/dev/updateproviders.ts, apps/api/dev/updatemodels.ts, or apps/api/routes/models.ts unless the next proposal explicitly refreshes the anchors or cleans up the stale declarations.`,
        );
        continue;
      }
    }

    if (
      apiRuntimeRequestQueuePivot
      && check.normalizedPath === 'apps/api/modules/requestQueue.ts'
    ) {
      const reasonText = String(edit.reason || '').toLowerCase();
      if (!reasonAcknowledgesCompileShapeFailure(reasonText)) {
        notes.push(
          `Skipped autonomous edit proposal for ${check.normalizedPath}: a recent api-runtime attempt on this file failed with stale unused locals, so pivot to apps/api/modules/errorClassification.ts, apps/api/modules/requestIntake.ts, or apps/api/modules/errorLogger.ts unless the next proposal explicitly removes or wires the stale declarations.`,
        );
        continue;
      }
    }

    if (
      apiPlatformExperimentalServicePivot
      && check.normalizedPath === 'apps/api/anygpt-experimental.service'
    ) {
      const reasonText = String(edit.reason || '').toLowerCase();
      if (!reasonAcknowledgesAnchorMismatchFailure(reasonText)) {
        notes.push(
          `Skipped autonomous edit proposal for ${check.normalizedPath}: recent api-platform attempts on this service unit failed because the replace anchors no longer match the live file shape, so pivot to apps/api/server.ts, apps/api/server.launcher.bun.ts, or apps/api/ws/wsServer.ts unless the next proposal explicitly rewrites or refreshes the service file anchors.`,
        );
        continue;
      }
    }

    if (controlPlaneCompileShapePivotPaths.has(check.normalizedPath)) {
      const reasonText = String(edit.reason || '').toLowerCase();
      if (!reasonAcknowledgesCompileShapeFailure(reasonText)) {
        notes.push(
          `Skipped autonomous edit proposal for ${check.normalizedPath}: a recent control-plane attempt on this file failed with compile-shape diagnostics, so pivot to adjacent control-plane workflow or observability files unless the next proposal explicitly removes or wires the stale symbols.`,
        );
        continue;
      }
    }

    const priorPreflightFailure = rejectedPathPreflightMessages.get(check.normalizedPath);
    if (priorPreflightFailure) {
      notes.push(`Skipped autonomous ${edit.type} proposal for ${check.normalizedPath}: an earlier proposal for this path already failed preflight validation (${priorPreflightFailure}).`);
      continue;
    }

    if (edit.type === 'replace') {
      if (!existingCandidatePaths.has(check.normalizedPath)) {
        notes.push(`Skipped autonomous replace proposal for ${check.normalizedPath}: replace edits must target an existing candidate file from the current context.`);
        continue;
      }
      const absolutePath = path.resolve(state.repoRoot, check.normalizedPath);
      if (!fs.existsSync(absolutePath)) {
        notes.push(`Skipped autonomous replace proposal for ${check.normalizedPath}: target file does not exist.`);
        continue;
      }
      const find = typeof edit.find === 'string' ? edit.find : '';
      if (!find) {
        notes.push(`Skipped autonomous replace proposal for ${check.normalizedPath}: replace edits must include a find block.`);
        continue;
      }
    }

    const preflightFailure = preflightAutonomousEditAction(
      state.repoRoot,
      {
        ...edit,
        path: check.normalizedPath,
      },
      state.editAllowlist,
      state.editDenylist,
    );
    if (preflightFailure) {
      rejectedPathPreflightMessages.set(check.normalizedPath, preflightFailure.message);
      notes.push(`Skipped autonomous ${edit.type} proposal for ${check.normalizedPath}: ${preflightFailure.message}`);
      continue;
    }

    accepted.push({
      ...edit,
      path: check.normalizedPath,
    });
  }

  const narrowedBatch = maybeNarrowAutonomousEditBatchToStrongestPath(
    state,
    accepted,
    proposalReasonByPath,
  );
  if (narrowedBatch) {
    notes.push(narrowedBatch.note);
    return { accepted: narrowedBatch.edits, notes };
  }

  return { accepted, notes };
}

function buildDefaultAutonomousEditAgentFocus(operationMode: AutonomousOperationMode): string {
  return operationMode === 'repair'
    ? 'Fix the clearest code-local issue when possible, or pivot to the smallest resilience/observability improvement when the active signals are external or repetitive.'
    : 'Make the highest-value small experimental improvement available this iteration.';
}

function buildAutonomousEditAgentWorkloads(
  state: ControlPlaneState,
  operationMode: AutonomousOperationMode,
  candidateFiles: ReturnType<typeof readAutonomousEditContext>,
  failedPaths: Set<string>,
): AutonomousEditAgentWorkload[] {
  const aggressivePlanning = shouldUseAggressiveAutonomousPlanning(state);
  const aiBackpressureActive = hasRecentAiBackendBackpressure(state);
  const maxAgents = Math.max(
    1,
    Math.min(
      aiBackpressureActive
        ? 1
        : (aggressivePlanning ? AI_CODE_EDIT_AGENT_PARALLELISM : 1),
      candidateFiles.length,
    ),
  );
  const workloads: AutonomousEditAgentWorkload[] = [];
  const compileShapeFailedPaths = collectRecentCompileShapeFailedPaths(state);
  const anchorMismatchFailedPaths = collectRecentAnchorMismatchFailedPaths(state);
  const apiRoutingGeminiValidationPivot = shouldPivotApiRoutingAwayFromGeminiValidation(state);
  const apiDataRefreshModelsPivot = shouldPivotApiDataAwayFromRefreshModels(state);
  const apiDataModelUpdaterPivot = shouldPivotApiDataAwayFromModelUpdater(state);
  const apiRuntimeRequestQueuePivot = shouldPivotApiRuntimeAwayFromRequestQueue(state);
  const apiPlatformExperimentalServicePivot = shouldPivotApiPlatformAwayFromExperimentalService(state);
  const controlPlaneCompileShapePivotPaths = new Set<string>(
    Array.from(compileShapeFailedPaths).filter((candidatePath) =>
      candidatePath === 'apps/langgraph-control-plane/src/workflow.ts'
      || candidatePath === 'apps/langgraph-control-plane/src/index.ts'),
  );

  const addWorkload = (label: string, focus: string, files: ReturnType<typeof readAutonomousEditContext>): void => {
    if (workloads.length >= maxAgents) return;
    const dedupedFiles = Array.from(new Map(
      files
        .filter((file) => Boolean(String(file?.path || '').trim()))
        .map((file) => [file.path, file] as const),
    ).values());
    if (dedupedFiles.length === 0) return;

    const limitedFiles = dedupedFiles.slice(0, AI_CODE_EDIT_CANDIDATE_FILE_LIMIT);
    workloads.push({
      label,
      focus,
      candidateFiles: limitedFiles,
      candidatePaths: limitedFiles.map((file) => file.path).slice(0, AI_CODE_EDIT_CANDIDATE_PATH_LIMIT),
    });
  };

  const effectiveScopes = new Set(getEffectiveScopes(state));
  const globallyDeferredPaths = new Set<string>();
  if (effectiveScopes.has('api-data') && apiDataRefreshModelsPivot) {
    globallyDeferredPaths.add('apps/api/dev/refreshModels.ts');
  }
  if (effectiveScopes.has('api-data') && apiDataModelUpdaterPivot) {
    globallyDeferredPaths.add('apps/api/modules/modelUpdater.ts');
  }
  if (effectiveScopes.has('api-routing') && apiRoutingGeminiValidationPivot) {
    globallyDeferredPaths.add('apps/api/modules/geminiMediaValidation.ts');
  }
  if (effectiveScopes.has('api-runtime') && apiRuntimeRequestQueuePivot) {
    globallyDeferredPaths.add('apps/api/modules/requestQueue.ts');
  }
  if (effectiveScopes.has('api-platform') && apiPlatformExperimentalServicePivot) {
    globallyDeferredPaths.add('apps/api/anygpt-experimental.service');
  }
  for (const candidatePath of controlPlaneCompileShapePivotPaths) {
    globallyDeferredPaths.add(candidatePath);
  }
  const primaryCandidateFiles = candidateFiles.filter((file) => !globallyDeferredPaths.has(file.path));

  addWorkload(
    'primary',
    buildDefaultAutonomousEditAgentFocus(operationMode),
    primaryCandidateFiles.length > 0 ? primaryCandidateFiles : candidateFiles,
  );
  if (maxAgents === 1) return workloads;

  if (effectiveScopes.has('api-data')) {
    addWorkload(
      'api-data-source-of-truth',
      operationMode === 'repair'
        ? (
            apiDataRefreshModelsPivot || apiDataModelUpdaterPivot
              ? 'Prefer source-of-truth model/provider/pricing files over audit helpers when fixing api-data issues. A recent refreshModels.ts attempt failed with unused locals, so pivot to modelUpdater.ts, updateproviders.ts, updatemodels.ts, routes/models.ts, or canonical data files unless you are explicitly cleaning up the stale declarations.'
              : 'Prefer source-of-truth model/provider/pricing files over audit helpers when fixing api-data issues.'
          )
        : 'Prefer source-of-truth model/provider/pricing files over audit helpers when improving availability, provider sync, or pricing metadata.',
      candidateFiles.filter((file) =>
        isApiDataSourceOfTruthPath(file.path)
        && (!apiDataRefreshModelsPivot || file.path !== 'apps/api/dev/refreshModels.ts')
        && (!apiDataModelUpdaterPivot || file.path !== 'apps/api/modules/modelUpdater.ts')),
    );
  }

  if (effectiveScopes.has('api-data')) {
    addWorkload(
      'api-data-repair-pivot',
      operationMode === 'repair'
        ? (
            apiDataModelUpdaterPivot
              ? 'A recent modelUpdater.ts attempt failed with stale anchors or unused locals, so prefer direct source-of-truth catalog, pricing, provider update, or route exposure fixes instead of reusing the same modelUpdater replace shape.'
              : 'Prefer source-of-truth model/provider/pricing files over audit helpers when fixing api-data issues.'
          )
        : 'Prefer source-of-truth model/provider/pricing files over audit helpers when improving availability, provider sync, or pricing metadata.',
      candidateFiles.filter((file) => [
        'apps/api/models.json',
        'apps/api/pricing.json',
        'apps/api/dev/updateproviders.ts',
        'apps/api/dev/updatemodels.ts',
        'apps/api/routes/models.ts',
      ].includes(file.path)),
    );
  }

  if (effectiveScopes.has('api-routing')) {
    const routingSourceText = [
      ...state.repairSignals,
      ...state.improvementSignals,
      ...state.plannerNotes,
    ].join(' | ').toLowerCase();
    const geminiCapabilityDriftFocus = signalTextHasGeminiCapabilityDriftFocus(
      routingSourceText,
    );
    addWorkload(
      'api-routing',
      operationMode === 'repair'
        ? (
            apiRoutingGeminiValidationPivot
              ? 'Focus on routing-time capability gating, provider selection, skip reasons, and retry-worthlessness improvements. A recent geminiMediaValidation.ts attempt failed with duplicate declarations, so pivot to apps/api/providers/handler.ts or route-support hot paths instead of retrying the same stale replace block unless you are explicitly cleaning up duplicate symbols.'
              : 'Focus on routing-time capability gating, provider selection, skip reasons, and retry-worthlessness improvements.'
          )
        : 'Prefer small routing, selection, and compatibility-gating improvements in the API hot path.',
      candidateFiles.filter((file) => [
        'apps/api/providers/handler.ts',
        'apps/api/providers/gemini.ts',
        'apps/api/providers/openrouter.ts',
        ...(!geminiCapabilityDriftFocus
          ? ['apps/api/modules/openaiProviderSelection.ts']
          : []),
        'apps/api/modules/openaiRouteSupport.ts',
        'apps/api/modules/openaiRouteUtils.ts',
        'apps/api/modules/openaiResponsesFormat.ts',
        ...(!apiRoutingGeminiValidationPivot
          ? ['apps/api/modules/geminiMediaValidation.ts']
          : []),
        'apps/api/routes/openai.ts',
      ].includes(file.path)),
    );
  }

  if (effectiveScopes.has('api-runtime')) {
    addWorkload(
      'api-runtime',
      operationMode === 'repair'
        ? (
            apiRuntimeRequestQueuePivot
              ? 'Focus on queue, intake, error-classification, and runtime failure-origin improvements. A recent requestQueue.ts attempt failed with stale unused locals, so pivot to errorClassification.ts, requestIntake.ts, or errorLogger.ts unless you are explicitly cleaning up the stale declarations.'
              : 'Focus on queue, intake, error-classification, and runtime failure-origin improvements.'
          )
        : 'Prefer small runtime resilience or observability improvements in queue/intake/classification paths.',
      candidateFiles.filter((file) => [
        'apps/api/modules/errorClassification.ts',
        ...(!apiRuntimeRequestQueuePivot
          ? ['apps/api/modules/requestQueue.ts']
          : []),
        'apps/api/modules/requestIntake.ts',
        'apps/api/modules/errorLogger.ts',
        'apps/api/modules/middlewareFactory.ts',
        'apps/api/modules/rateLimit.ts',
        'apps/api/modules/rateLimitRedis.ts',
      ].includes(file.path)),
    );
  }

  if (effectiveScopes.has('api-platform')) {
    addWorkload(
      'api-platform',
      operationMode === 'repair'
        ? (
            apiPlatformExperimentalServicePivot
              ? 'Focus on experimental API entrypoint, launcher, websocket, and startup-health improvements. Recent anygpt-experimental.service attempts failed because the replace anchors no longer match the live file shape, so pivot to server.ts, server.launcher.bun.ts, or ws/wsServer.ts unless you are explicitly rewriting the service file with refreshed anchors.'
              : 'Focus on experimental API entrypoint, service-unit, websocket, and startup-health improvements.'
          )
        : 'Prefer bounded experimental platform health, startup, or service wiring improvements.',
      candidateFiles.filter((file) => [
        'apps/api/server.ts',
        'apps/api/server.launcher.bun.ts',
        'apps/api/ws/wsServer.ts',
        'apps/api/anygpt-api.service',
        ...(!apiPlatformExperimentalServicePivot
          ? ['apps/api/anygpt-experimental.service']
          : []),
      ].includes(file.path)),
    );
  }

  const refreshableFailedPaths = new Set(
    Array.from(failedPaths).filter((candidatePath) =>
      !compileShapeFailedPaths.has(candidatePath)
      && !anchorMismatchFailedPaths.has(candidatePath)),
  );
  if (refreshableFailedPaths.size > 0) {
    addWorkload(
      'refresh-failed-paths',
      'Revisit previously failing edit targets with the refreshed live blocks and propose a safer bounded patch.',
      candidateFiles.filter((file) => refreshableFailedPaths.has(file.path)),
    );
  }

  if (effectiveScopes.has('api') || effectiveScopes.has('api-experimental') || effectiveScopes.has('repo')) {
    addWorkload(
      'api-hot-paths',
      operationMode === 'repair'
        ? 'Look for the smallest API/provider/routing/resilience change that improves the monitored experimental lane.'
        : 'Look specifically for a small experimental API throughput, routing, model-availability, or observability improvement.',
      candidateFiles.filter((file) => file.path.startsWith('apps/api/')),
    );
  }

  if (effectiveScopes.has('control-plane') || effectiveScopes.has('repo')) {
    addWorkload(
      'control-plane',
      operationMode === 'repair'
        ? (
            controlPlaneCompileShapePivotPaths.size > 0
              ? 'If direct repair is ambiguous, improve the control-plane heuristics, observability, or autonomous recovery logic instead. Recent workflow.ts/index.ts attempts failed with stale compile-shape symbols, so pivot to adjacent control-plane files unless you are explicitly cleaning up those symbols.'
              : 'If direct repair is ambiguous, improve the control-plane heuristics, observability, or autonomous recovery logic instead.'
          )
        : 'Look specifically for a small control-plane orchestration, observability, or workflow-hardening improvement.',
      candidateFiles.filter((file) =>
        file.path.startsWith('apps/langgraph-control-plane/')
        && !controlPlaneCompileShapePivotPaths.has(file.path)),
    );
  }

  if (effectiveScopes.has('repo') || effectiveScopes.has('repo-surface')) {
    addWorkload(
      'repo-surface',
      'Look specifically for a small repo/workspace/homepage/UI cleanup or developer-workflow hardening improvement.',
      candidateFiles.filter((file) => !file.path.startsWith('apps/api/') && !file.path.startsWith('apps/langgraph-control-plane/')),
    );
  }

  if (effectiveScopes.has('workspace-surface')) {
    addWorkload(
      'workspace-surface',
      'Prefer one bounded root-workspace or developer-workflow improvement with direct operator payoff.',
      candidateFiles.filter((file) => !file.path.startsWith('apps/') || file.path.startsWith('scripts/')),
    );
  }

  if (effectiveScopes.has('homepage-surface')) {
    addWorkload(
      'homepage-surface',
      'Prefer a homepage-visible static-asset or browser-shell improvement, especially favicon or asset-path fixes.',
      candidateFiles.filter((file) => file.path.startsWith('apps/homepage/')),
    );
  }

  if (effectiveScopes.has('ui-surface')) {
    addWorkload(
      'ui-surface',
      'Prefer a UI shell or static-asset improvement with direct browser-visible payoff.',
      candidateFiles.filter((file) => file.path.startsWith('apps/ui/')),
    );
  }

  return workloads;
}

function buildRedisConnectionUrl(db: string): string {
  const rawUrl = String(process.env.CONTROL_PLANE_REDIS_URL || process.env.REDIS_URL || '127.0.0.1:6380').trim();
  const username = String(process.env.CONTROL_PLANE_REDIS_USERNAME || process.env.REDIS_USERNAME || 'default').trim();
  const password = String(process.env.CONTROL_PLANE_REDIS_PASSWORD || process.env.REDIS_PASSWORD || '').trim();
  const tls = String(process.env.CONTROL_PLANE_REDIS_TLS || process.env.REDIS_TLS || 'false').trim().toLowerCase() === 'true';
  const scheme = tls ? 'rediss' : 'redis';
  const normalized = rawUrl.includes('://') ? rawUrl : `${scheme}://${rawUrl}`;
  const url = new URL(normalized);
  if (username) url.username = username;
  if (password) url.password = password;
  url.pathname = `/${db}`;
  return url.toString();
}

function normalizeRedisDumpPayload(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  throw new Error(`Redis DUMP returned a non-binary payload (${typeof payload}).`);
}

async function cloneProductionRedisToExperimental(): Promise<string> {
  const preference = String(process.env.CONTROL_PLANE_DATA_SOURCE_PREFERENCE || 'redis').trim().toLowerCase();
  if (preference !== 'redis') {
    return 'Redis cloning skipped because CONTROL_PLANE_DATA_SOURCE_PREFERENCE is not redis.';
  }

  const sourceDb = String(process.env.CONTROL_PLANE_SOURCE_REDIS_DB || CONTROL_PLANE_SOURCE_REDIS_DB);
  const targetDb = String(process.env.CONTROL_PLANE_TARGET_REDIS_DB || CONTROL_PLANE_TARGET_REDIS_DB);
  const source = createClient({ url: buildRedisConnectionUrl(sourceDb) });
  const target = createClient({ url: buildRedisConnectionUrl(targetDb) });
  let copied = 0;
  let copyMethod: 'copy' | 'dump-restore' = 'copy';

  try {
    await withTimeout(source.connect(), REDIS_CLONE_CONNECT_TIMEOUT_MS, `Redis source connect DB ${sourceDb}`);
    await withTimeout(target.connect(), REDIS_CLONE_CONNECT_TIMEOUT_MS, `Redis target connect DB ${targetDb}`);
    await withTimeout(target.flushDb(), REDIS_CLONE_COMMAND_TIMEOUT_MS, `Redis target flush DB ${targetDb}`);

    const iterator = source.scanIterator()[Symbol.asyncIterator]();
    while (true) {
      const nextKey = await withTimeout(
        iterator.next(),
        REDIS_CLONE_SCAN_TIMEOUT_MS,
        `Redis clone scan DB ${sourceDb}`,
      );
      if (nextKey.done) break;
      const key = nextKey.value;
      if (copyMethod === 'copy') {
        try {
          const copiedResult = await withTimeout(
            source.sendCommand<number>(['COPY', key, key, 'DB', targetDb, 'REPLACE']),
            REDIS_CLONE_COMMAND_TIMEOUT_MS,
            `Redis COPY ${key}`,
          );
          if (copiedResult === 1) copied += 1;
          continue;
        } catch {
          copyMethod = 'dump-restore';
        }
      }

      try {
        const serializedValue = await withTimeout(
          source.sendCommand<Buffer | Uint8Array | ArrayBuffer | null>(
            ['DUMP', key],
            commandOptions({ returnBuffers: true }),
          ),
          REDIS_CLONE_COMMAND_TIMEOUT_MS,
          `Redis DUMP ${key}`,
        );
        if (!serializedValue) continue;
        const serializedBuffer = normalizeRedisDumpPayload(serializedValue);
        const ttlMs = await withTimeout(
          source.sendCommand<number>(['PTTL', key]),
          REDIS_CLONE_COMMAND_TIMEOUT_MS,
          `Redis PTTL ${key}`,
        );
        await withTimeout(
          target.sendCommand([
            'RESTORE',
            key,
            ttlMs > 0 ? String(ttlMs) : '0',
            serializedBuffer,
            'REPLACE',
          ]),
          REDIS_CLONE_COMMAND_TIMEOUT_MS,
          `Redis RESTORE ${key}`,
        );
        copied += 1;
      } catch (restoreError: any) {
        const serializedRestoreError = restoreError?.stack
          || restoreError?.message
          || JSON.stringify(restoreError)
          || String(restoreError);
        throw new Error(`Redis clone fallback failed for key ${key}: ${serializedRestoreError}`);
      }
    }
  } finally {
    await source.quit().catch(() => undefined);
    await target.quit().catch(() => undefined);
  }

  const methodLabel = copyMethod === 'copy' ? 'COPY' : 'DUMP/RESTORE fallback';
  return `Cloned Redis/Dragonfly DB ${sourceDb} -> DB ${targetDb} (${copied} keys via ${methodLabel}).`;
}

function loadMcpServers(configPath: string): LoadedMcpServerConfig[] {
  if (!fs.existsSync(configPath)) return [];
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object'
      ? parsed.mcpServers
      : {};
    return Object.entries(servers).map(([name, config]: [string, any]) => {
      const normalizedArgs = coerceStringArray(config?.args);
      const normalizedCommand = normalizeMcpCommand(String(config?.command || ''), normalizedArgs);
      return ({
      name,
      command: normalizedCommand.command,
      args: normalizedCommand.args,
      type: typeof config?.type === 'string' && config.type.trim().length > 0 ? config.type.trim() : 'stdio',
      disabled: config?.disabled === true,
      alwaysAllow: coerceStringArray(config?.alwaysAllow),
      disabledTools: coerceStringArray(config?.disabledTools),
      env: coerceStringRecord(config?.env),
      cwd: typeof config?.cwd === 'string' && config.cwd.trim().length > 0 ? config.cwd.trim() : undefined,
    });
    });
  } catch {
    return [];
  }
}

function extractUrlsFromText(value: string): string[] {
  const matches = String(value || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return uniqueNormalizedStrings(
    matches.map((entry) => {
      try {
        const parsed = new URL(entry);
        return parsed.toString();
      } catch {
        return '';
      }
    }),
  );
}

function resolveConfiguredMcpTargetUrls(state: Pick<ControlPlaneState, 'goal' | 'mcpTargetUrls'>): string[] {
  const configuredUrls = splitConfiguredRepoPaths(process.env.CONTROL_PLANE_MCP_TARGET_URLS)
    .map((entry) => {
      try {
        return new URL(entry).toString();
      } catch {
        return '';
      }
    });
  return uniqueNormalizedStrings([
    ...state.mcpTargetUrls,
    ...configuredUrls,
    ...extractUrlsFromText(state.goal),
  ]);
}

function mcpInspectionHasTool(inspection: McpInspection | undefined, toolName: string): boolean {
  return Boolean(
    inspection?.status === 'connected'
    && inspection.tools.some((tool) => tool.name === toolName),
  );
}

function shouldPlanBraveSearchForGoal(goal: string): boolean {
  return /research|search|look up|lookup|latest|docs?|documentation|website|github|langgraph|openclaw|browse/i.test(
    String(goal || ''),
  );
}

function collectMcpPlanningSourceText(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'plannerNotes'
    | 'buildAgentInsights'
    | 'qualityAgentInsights'
    | 'deployAgentInsights'
    | 'autonomousContractSummary'
    | 'autonomousContractChecks'
    | 'autonomousContractPaths'
  >,
): string {
  return [
    state.goal,
    state.repairIntentSummary,
    ...state.repairSignals,
    state.improvementIntentSummary,
    ...state.improvementSignals,
    ...state.plannerNotes.slice(-20),
    ...state.buildAgentInsights.slice(-8),
    ...state.qualityAgentInsights.slice(-8),
    ...state.deployAgentInsights.slice(-8),
    state.autonomousContractSummary,
    ...state.autonomousContractChecks,
    ...state.autonomousContractPaths,
  ].join(' | ').toLowerCase();
}

function shouldPlanSignalDrivenBraveSearch(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'plannerNotes'
    | 'buildAgentInsights'
    | 'qualityAgentInsights'
    | 'deployAgentInsights'
    | 'autonomousContractSummary'
    | 'autonomousContractChecks'
    | 'autonomousContractPaths'
  >,
): boolean {
  const sourceText = collectMcpPlanningSourceText(state);
  return /provider_model_removed|provider_cap_blocked|image generation unavailable|tool_choice|tool choice|unsupported capability|unsupported modality|provider routing|pricing coverage|resource has been exhausted|quota exhausted|listmodels failed|responses endpoint|request failed with status code 500|request failed with status code 503|openrouter|gemini|lyria-3|qwen\/qwen3\.5-plus|mimo-v2-pro/.test(sourceText);
}

function shouldPlanResearchScoutBraveSearch(
  state: Pick<
    ControlPlaneState,
    | 'scopes'
    | 'effectiveScopes'
  >,
): boolean {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  return effectiveScopes.has('research-scout');
}

function shouldUseLightweightResearchScoutInspect(
  state: Pick<ControlPlaneState, 'scopes' | 'effectiveScopes'>,
): boolean {
  const effectiveScopes = getEffectiveScopes(state as ControlPlaneState);
  return effectiveScopes.length === 1
    && effectiveScopes[0] === 'research-scout'
    && parseBooleanEnv('CONTROL_PLANE_RESEARCH_SCOUT_LIGHTWEIGHT_INSPECT', true);
}

type ResearchScoutTrustedSource = {
  family: 'control-plane' | 'api';
  url: string;
  title: string;
};

const RESEARCH_SCOUT_TRUSTED_SOURCE_PACKS: Record<'control-plane' | 'api', ResearchScoutTrustedSource[]> = {
  'control-plane': [
    { family: 'control-plane', url: 'https://docs.temporal.io/', title: 'Temporal docs' },
    { family: 'control-plane', url: 'https://modelcontextprotocol.io/docs', title: 'Model Context Protocol docs' },
    { family: 'control-plane', url: 'https://qdrant.tech/documentation/', title: 'Qdrant documentation' },
    { family: 'control-plane', url: 'https://github.com/langchain-ai/langgraph', title: 'LangGraph GitHub' },
    { family: 'control-plane', url: 'https://www.langchain.com/langgraph', title: 'LangGraph overview' },
  ],
  api: [
    { family: 'api', url: 'https://platform.openai.com/docs', title: 'OpenAI docs' },
    { family: 'api', url: 'https://ai.google.dev/gemini-api/docs', title: 'Gemini API docs' },
    { family: 'api', url: 'https://openrouter.ai/docs', title: 'OpenRouter docs' },
    { family: 'api', url: 'https://docs.anthropic.com/en/docs', title: 'Anthropic docs' },
    { family: 'api', url: 'https://arxiv.org/', title: 'arXiv papers' },
  ],
};

function inferResearchScoutQueryFamilyFromText(
  query: unknown,
): 'control-plane' | 'api' | 'generic' {
  const normalized = String(query || '').toLowerCase();
  if (/mcp|model context protocol|orchestration|durable execution|checkpoint|state graph|state machine|workflow|runner|control plane|governance|evaluation|observability|semantic memory|agent memory|human[- ]in[- ]the[- ]loop|langgraph|langchain|vector memory|hybrid search/.test(normalized)) {
    return 'control-plane';
  }
  if (/large language model|gateway|api routing|provider selection|quota|capability|retry|routing resilience|provider|responses api|openrouter|openai api|gemini api|anthropic api|rate limit|error codes/.test(normalized)) {
    return 'api';
  }
  return 'generic';
}

function buildResearchScoutBraveQueries(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
  >,
): string[] {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  const queries: string[] = [];

  if (effectiveScopes.has('research-scout') || effectiveScopes.has('control-plane') || effectiveScopes.has('repo')) {
    queries.push(
      truncateTextMiddle(
        'site:temporal.io durable execution workflow orchestration agents docs',
        240,
      ),
    );
    queries.push(
      truncateTextMiddle(
        'site:modelcontextprotocol.io docs agent tools orchestration workflow mcp',
        240,
      ),
    );
    queries.push(
      truncateTextMiddle(
        'site:qdrant.tech hybrid search metadata filtering embeddings semantic memory agent retrieval',
        240,
      ),
    );
    queries.push(
      truncateTextMiddle(
        'site:arxiv.org llm agents orchestration memory evaluation durable workflow paper',
        240,
      ),
    );
  }

  if (effectiveScopes.has('research-scout') || hasApiFamilyScope(effectiveScopes) || effectiveScopes.has('repo')) {
    queries.push(
      truncateTextMiddle(
        '"OpenRouter" "OpenAI API" "Gemini API" docs provider routing retry rate limits capability gating implementation patterns',
        240,
      ),
    );
    queries.push(
      truncateTextMiddle(
        'site:platform.openai.com/docs responses api rate limits retries error codes',
        240,
      ),
    );
    queries.push(
      truncateTextMiddle(
        'site:ai.google.dev gemini api invalid argument model capability audio mime type generatecontent',
        240,
      ),
    );
    queries.push(
      truncateTextMiddle(
        'site:openrouter.ai docs models providers routing rate limits errors',
        240,
      ),
    );
    queries.push(
      truncateTextMiddle(
        'site:docs.anthropic.com claude api rate limits errors tool use docs',
        240,
      ),
    );
    queries.push(
      truncateTextMiddle(
        'site:arxiv.org large language model gateway routing inference paper',
        240,
      ),
    );
  }

  return uniqueNormalizedStrings(queries).slice(0, 8);
}

function buildResearchScoutFallbackQueries(
  family: 'control-plane' | 'api' | 'generic',
): string[] {
  if (family === 'control-plane') {
    return [
      truncateTextMiddle(
        'site:modelcontextprotocol.io docs tools agents workflow orchestration',
        240,
      ),
      truncateTextMiddle(
        'site:qdrant.tech hybrid search metadata filtering vector memory docs',
        240,
      ),
      truncateTextMiddle(
        '"LangGraph" orchestration framework docs stateful agents workflow guide',
        240,
      ),
    ];
  }
  if (family === 'api') {
    return [
      truncateTextMiddle(
        'site:openrouter.ai docs providers models rate limits routing',
        240,
      ),
      truncateTextMiddle(
        'site:platform.openai.com/docs api rate limits retries error codes',
        240,
      ),
      truncateTextMiddle(
        'site:ai.google.dev gemini api docs invalid argument rate limits model capability',
        240,
      ),
      truncateTextMiddle(
        'site:docs.anthropic.com claude api docs rate limits tool use errors',
        240,
      ),
    ];
  }
  return [
    truncateTextMiddle(
      'developer docs implementation patterns reliability workflow API routing',
      240,
    ),
  ];
}

function extractSignalDrivenSearchHints(entries: string[]): string[] {
  const hints: string[] = [];
  const pushHint = (value: string): void => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized || hints.includes(normalized)) return;
    hints.push(normalized);
  };

  for (const entry of entries) {
    const normalized = String(entry || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;

    for (const modelMatch of normalized.match(/\b(?:gemini(?:-[a-z0-9.-]+)?|lyria-3-(?:clip|pro)-preview|gpt-5\.4|gpt-5-pro-2025-10-06|qwen\/qwen3\.5-plus-[0-9-]+|mimo-v2-pro)\b/gi) || []) {
      pushHint(modelMatch);
    }
    if (/does not support generatecontent/i.test(normalized)) pushHint('does not support generateContent');
    if (/unsupported input mime type.*audio\/s16le/i.test(normalized)) pushHint('unsupported audio/s16le input');
    if (/function calling is not enabled/i.test(normalized)) pushHint('function calling not enabled');
    if (/image generation unavailable in country|image generation unavailable in provider region/i.test(normalized)) pushHint('image generation unavailable in provider region');
    if (/provider_cap_blocked/i.test(normalized)) pushHint('provider_cap_blocked');
    if (/provider_model_removed/i.test(normalized)) pushHint('provider_model_removed');
    if (/resource has been exhausted|quota exceeded|quota exhausted/i.test(normalized)) pushHint('quota exhausted');
    if (/tool[_ -]?calling|tool_choice/i.test(normalized)) pushHint('tool calling compatibility');
    if (/request failed with status code 500/i.test(normalized)) pushHint('upstream 500');
    if (/request failed with status code 503/i.test(normalized)) pushHint('upstream 503');
    if (/pricing coverage|pricing gap|missing pricing/i.test(normalized)) pushHint('pricing coverage gap');
  }

  return hints.slice(0, 8);
}

function buildSignalDrivenBraveQuery(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'repairSignals'
    | 'improvementSignals'
    | 'plannerNotes'
  >,
): string {
  const candidateSignals = [
    ...state.repairSignals,
    ...state.improvementSignals,
    ...state.plannerNotes,
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .filter((entry) => /provider_model_removed|provider_cap_blocked|image generation unavailable|tool_choice|tool choice|unsupported capability|provider routing|pricing coverage|resource has been exhausted|openrouter|gemini|lyria-3|qwen\/qwen3\.5-plus|mimo-v2-pro|gpt-5\.4|gpt-5-pro-2025-10-06/i.test(entry))
    .slice(0, 2);

  const providerHints = Array.from(new Set(
    candidateSignals
      .flatMap((entry) => entry.match(/\b(?:gemini|openrouter|openai|deepseek|qwen|xiaomi|lyria-3(?:-clip|-pro)?|mimo-v2-pro|gpt-5\.4|gpt-5-pro-2025-10-06)\b/gi) || [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean),
  )).slice(0, 6);
  const symptomHints = extractSignalDrivenSearchHints(candidateSignals);

  return truncateTextMiddle(
    [...providerHints, ...symptomHints]
      .map((entry) => String(entry || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' '),
    240,
  );
}

function resolveSignalDrivenMcpTargetUrls(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'mcpTargetUrls'
    | 'experimentalApiBaseUrl'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'plannerNotes'
    | 'buildAgentInsights'
    | 'qualityAgentInsights'
    | 'deployAgentInsights'
    | 'autonomousContractSummary'
    | 'autonomousContractChecks'
    | 'autonomousContractPaths'
  >,
): string[] {
  const configuredUrls = resolveConfiguredMcpTargetUrls(state);
  if (configuredUrls.length > 0) return configuredUrls;

  const sourceText = collectMcpPlanningSourceText(state);
  const baseUrl = String(state.experimentalApiBaseUrl || '').trim().replace(/\/+$/, '');
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  const targets: string[] = [];

  if (effectiveScopes.has('homepage-surface')) {
    targets.push(DEFAULT_HOMEPAGE_SURFACE_URL);
  }
  if (effectiveScopes.has('ui-surface')) {
    targets.push(DEFAULT_UI_SURFACE_URL);
  }

  if (
    baseUrl
    && hasApiFamilyScope(effectiveScopes)
    && (
      /model-availability|provider_model_removed|provider_cap_blocked|pricing coverage|tool_choice|provider routing|openapi|apiBaseUrl|experimental api/.test(sourceText)
      || state.autonomousContractPaths.some((candidatePath) => candidatePath.startsWith('apps/api/'))
    )
  ) {
    targets.push(`${baseUrl}/openapi.json`);
  }

  return uniqueNormalizedStrings(targets);
}

function shouldPlanPlaywrightBrowserActions(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'effectiveScopes'
    | 'scopes'
    | 'repairSignals'
    | 'improvementSignals'
    | 'autonomousContractSummary'
    | 'autonomousContractChecks'
    | 'autonomousContractPaths'
  >,
): boolean {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  if (effectiveScopes.has('ui-surface') || effectiveScopes.has('homepage-surface')) {
    return true;
  }

  const sourceText = [
    state.goal,
    ...state.repairSignals,
    ...state.improvementSignals,
    state.autonomousContractSummary,
    ...state.autonomousContractChecks,
    ...state.autonomousContractPaths,
  ].join(' | ').toLowerCase();

  return /browser|playwright|favicon|console|network requests|network failures|snapshot|page load|shell render|ui smoke|homepage-visible/.test(sourceText);
}

function buildMcpPlannedAction(input: {
  id: string;
  server: string;
  tool: string;
  title: string;
  reason: string;
  arguments?: Record<string, unknown>;
  risk?: z.infer<typeof McpActionRiskSchema>;
  alwaysAllow?: boolean;
}): McpPlannedAction {
  return McpPlannedActionSchema.parse({
    id: input.id,
    server: input.server,
    tool: input.tool,
    title: input.title,
    reason: input.reason,
    arguments: input.arguments || {},
    risk: input.risk || 'low',
    alwaysAllow: input.alwaysAllow === true,
  });
}

function buildDeterministicMcpActionPlan(
  state: Pick<
    ControlPlaneState,
    | 'repoRoot'
    | 'goal'
    | 'mcpConfigPath'
    | 'mcpActionEnabled'
    | 'maxMcpActions'
    | 'mcpTargetUrls'
    | 'mcpInspections'
    | 'experimentalApiBaseUrl'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairIntentSummary'
    | 'repairSignals'
    | 'improvementIntentSummary'
    | 'improvementSignals'
    | 'plannerNotes'
    | 'buildAgentInsights'
    | 'qualityAgentInsights'
    | 'deployAgentInsights'
    | 'autonomousContractSummary'
    | 'autonomousContractChecks'
    | 'autonomousContractPaths'
  >,
): McpPlannedAction[] {
  if (!state.mcpActionEnabled || state.maxMcpActions <= 0) return [];

  const inspectionsByServer = new Map(
    state.mcpInspections.map((inspection) => [inspection.server, inspection] as const),
  );
  const configsByServer = new Map(
    loadMcpServers(resolveMcpConfigPath(state as ControlPlaneState)).map((server) => [server.name, server] as const),
  );
  const actions: McpPlannedAction[] = [];
  const configuredTargetUrls = resolveConfiguredMcpTargetUrls(state);
  const urls = resolveSignalDrivenMcpTargetUrls(state);
  const allowPlaywrightBrowserActions = shouldPlanPlaywrightBrowserActions(state);
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));

  const braveInspection = inspectionsByServer.get('brave-search');
  const braveConfig = configsByServer.get('brave-search');
  if (
    braveInspection
    && braveConfig
    && (
      mcpInspectionHasTool(braveInspection, 'brave_web_search')
      || mcpInspectionHasTool(braveInspection, 'searxng_web_search')
    )
    && (shouldPlanBraveSearchForGoal(state.goal) || shouldPlanSignalDrivenBraveSearch(state) || shouldPlanResearchScoutBraveSearch(state))
  ) {
    const plannedResearchQueries = shouldPlanResearchScoutBraveSearch(state)
      ? buildResearchScoutBraveQueries(state)
      : [];
    if (plannedResearchQueries.length > 0) {
      const preferredTool = mcpInspectionHasTool(braveInspection, 'searxng_web_search')
        ? 'searxng_web_search'
        : 'brave_web_search';
      for (const [index, query] of plannedResearchQueries.entries()) {
        actions.push(buildMcpPlannedAction({
          id: `mcp-brave-idea-scout-${index + 1}`,
          server: 'brave-search',
          tool: preferredTool,
          title: inferResearchScoutQueryFamilyFromText(query) === 'control-plane'
            ? 'Research control-plane improvement ideas with SearXNG'
            : inferResearchScoutQueryFamilyFromText(query) === 'api'
              ? 'Research API improvement ideas with SearXNG'
              : 'Research implementation ideas with SearXNG',
          reason: 'The research-scout lane searches the web with SearXNG for practical implementation ideas, then maps them back to in-scope files as suggestions for other lanes.',
          arguments: { query },
          risk: 'low',
          alwaysAllow: braveConfig.alwaysAllow.includes(preferredTool),
        }));
      }
    } else {
      actions.push(buildMcpPlannedAction({
        id: 'mcp-brave-web-search',
        server: 'brave-search',
        tool: 'brave_web_search',
        title: shouldPlanBraveSearchForGoal(state.goal)
          ? 'Research goal context with Brave Search'
          : 'Research active provider/model uncertainty with Brave Search',
        reason: shouldPlanBraveSearchForGoal(state.goal)
          ? 'The goal references external docs/websites or discovery work, so a bounded web search can provide operator context.'
          : `The active signals and autonomous contract indicate provider/model uncertainty; gather external compatibility context before committing to a code change${state.autonomousContractSummary ? ` (${state.autonomousContractSummary})` : ''}.`,
        arguments: {
          query: buildSignalDrivenBraveQuery(state),
        },
        risk: 'low',
        alwaysAllow: braveConfig.alwaysAllow.includes('brave_web_search'),
      }));
    }
  }

  const playwrightInspection = inspectionsByServer.get('playwright');
  const playwrightConfig = configsByServer.get('playwright');
  if (playwrightInspection && playwrightConfig && urls.length > 0 && allowPlaywrightBrowserActions) {
    const targetUrl = urls[0];
    if (mcpInspectionHasTool(playwrightInspection, 'browser_install')) {
      actions.push(buildMcpPlannedAction({
        id: 'mcp-playwright-install',
        server: 'playwright',
        tool: 'browser_install',
        title: 'Ensure Playwright browser dependencies are installed',
        reason: 'Install the browser runtime before navigation so bounded browser inspection can succeed in long-running autonomous runs.',
        arguments: {},
        risk: 'low',
        alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_install'),
      }));
    }
    if (mcpInspectionHasTool(playwrightInspection, 'browser_navigate')) {
      actions.push(buildMcpPlannedAction({
        id: 'mcp-playwright-navigate',
        server: 'playwright',
        tool: 'browser_navigate',
        title: `Open browser target ${targetUrl}`,
        reason: effectiveScopes.has('homepage-surface')
          ? 'The homepage-surface lane must inspect the live homepage target before any browser-visible edit is allowed.'
          : effectiveScopes.has('ui-surface')
            ? 'The ui-surface lane must inspect the live UI target before any browser-visible edit is allowed.'
            : configuredTargetUrls.length > 0
          ? 'The goal includes an explicit target URL, so the control plane can inspect it with the Playwright MCP browser.'
          : 'The active API signals and autonomous contract target the experimental API surface, so inspect the live endpoint before code changes are applied.',
        arguments: { url: targetUrl },
        risk: 'low',
        alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_navigate'),
      }));
    }
    if (mcpInspectionHasTool(playwrightInspection, 'browser_snapshot')) {
      actions.push(buildMcpPlannedAction({
        id: 'mcp-playwright-snapshot',
        server: 'playwright',
        tool: 'browser_snapshot',
        title: `Capture browser snapshot for ${targetUrl}`,
        reason: 'Capture a structured browser snapshot after navigation so the control plane can persist the visible state in its run summary.',
        arguments: {},
        risk: 'low',
        alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_snapshot'),
      }));
    }
    if (mcpInspectionHasTool(playwrightInspection, 'browser_network_requests')) {
      actions.push(buildMcpPlannedAction({
        id: 'mcp-playwright-network-requests',
        server: 'playwright',
        tool: 'browser_network_requests',
        title: `Capture network activity for ${targetUrl}`,
        reason: 'Capture network activity from the inspected surface so the control plane can verify that the targeted API/UI endpoint responded as expected before code changes are applied.',
        arguments: {},
        risk: 'low',
        alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_network_requests'),
      }));
    }
  }

  return actions.slice(0, Math.max(0, state.maxMcpActions));
}

function getPendingMcpActions(
  state: Pick<ControlPlaneState, 'plannedMcpActions' | 'executedMcpActions'>,
  options?: { safeOnly?: boolean },
): McpPlannedAction[] {
  const executedIds = new Set(
    (state.executedMcpActions || []).map((action) => String(action.id || '').trim()).filter(Boolean),
  );
  return (state.plannedMcpActions || []).filter((action) => {
    if (executedIds.has(action.id)) return false;
    if (options?.safeOnly && !(action.alwaysAllow && action.risk === 'low')) return false;
    return true;
  });
}

function shouldRunPreplanMcpActionsForState(
  state: Pick<ControlPlaneState, 'executePlan' | 'mcpActionEnabled' | 'plannedMcpActions' | 'executedMcpActions'>,
): boolean {
  return state.executePlan && state.mcpActionEnabled && getPendingMcpActions(state, { safeOnly: true }).length > 0;
}

function shouldRunMcpActionsForState(
  state: Pick<ControlPlaneState, 'executePlan' | 'mcpActionEnabled' | 'plannedMcpActions' | 'executedMcpActions'>,
): boolean {
  return state.executePlan && state.mcpActionEnabled && getPendingMcpActions(state).length > 0;
}

function isUnsafeProductionDeployCommand(command: string): boolean {
  const lower = String(command || '').toLowerCase();
  return lower.includes('systemctl') && (
    lower.includes('anygpt.service')
    || lower.includes('anygpt-api.service')
    || lower.includes('restart anygpt-api')
    || lower.includes('restart anygpt.service')
  );
}

function getDefaultDeployCommand(state: ControlPlaneState): string {
  const scopes = getEffectiveScopes(state);
  if (hasApiFamilyScope(scopes)) {
    return SAFE_EXPERIMENTAL_DEPLOY_COMMAND;
  }
  return 'echo "No default deploy command for this scope. Provide --deploy-command to enable execution."';
}

type ExperimentalClientConnection = {
  pid: number;
  command: string;
  endpoints: string[];
};

function resolveExperimentalApiPort(rawBaseUrl: string | undefined): number {
  const normalized = String(rawBaseUrl || '').trim();
  if (!normalized) return DEFAULT_EXPERIMENTAL_API_PORT;

  try {
    const parsed = new URL(normalized);
    if (parsed.port) {
      const port = Number(parsed.port);
      if (Number.isFinite(port) && port > 0) return Math.floor(port);
    }
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return DEFAULT_EXPERIMENTAL_API_PORT;
  }
}

function parseEstablishedExperimentalClientConnections(
  raw: string,
  port: number,
): ExperimentalClientConnection[] {
  const clients = new Map<number, ExperimentalClientConnection>();
  let currentPid = 0;
  let currentCommand = '';

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('p')) {
      const parsedPid = Number(line.slice(1).trim());
      currentPid = Number.isFinite(parsedPid) && parsedPid > 0 ? Math.floor(parsedPid) : 0;
      continue;
    }
    if (line.startsWith('c')) {
      currentCommand = line.slice(1).trim();
      continue;
    }
    if (!line.startsWith('n') || currentPid <= 0) continue;

    const endpoint = line.slice(1).trim();
    const parts = endpoint.split('->');
    if (parts.length !== 2) continue;
    const [localEndpoint, remoteEndpoint] = parts;
    if (!remoteEndpoint.endsWith(`:${port}`) || localEndpoint.endsWith(`:${port}`)) {
      continue;
    }

    const existing = clients.get(currentPid) ?? {
      pid: currentPid,
      command: currentCommand || 'unknown',
      endpoints: [],
    };
    if (!existing.command && currentCommand) existing.command = currentCommand;
    if (!existing.endpoints.includes(endpoint)) existing.endpoints.push(endpoint);
    clients.set(currentPid, existing);
  }

  return Array.from(clients.values());
}

async function listActiveExperimentalClientConnections(
  state: ControlPlaneState,
): Promise<ExperimentalClientConnection[]> {
  const port = resolveExperimentalApiPort(state.experimentalApiBaseUrl);
  const result = await runShellCommand(
    `if command -v lsof >/dev/null 2>&1; then lsof -nP -Fpcn -iTCP:${port} -sTCP:ESTABLISHED || true; fi`,
    path.resolve(state.repoRoot),
    { timeoutMs: EXPERIMENTAL_RESTART_CLIENT_INSPECTION_TIMEOUT_MS },
  );
  if (result.timedOut || !result.output.trim()) return [];

  return parseEstablishedExperimentalClientConnections(result.output, port)
    .filter((client) => client.pid !== process.pid);
}

async function inspectMcpNode(state: ControlPlaneState, runtime?: Runtime): Promise<Partial<ControlPlaneState>> {
  const configPath = resolveMcpConfigPath(state);
  const mcpServerConfigs = loadMcpServers(configPath);
  const mcpServers = mcpServerConfigs.map((config) => sanitizeMcpServer(config));
  const mcpInspections: McpInspection[] = [];
  const codeQlNotes = await ensureAutomaticCodeQlSarif(state);
  const gitHubCodeQlSync = await fetchGitHubCodeQlSync(state);
  const gitHubDependabotSync = await fetchGitHubDependabotSync(state);
  const logInsights = resolveLogInsights(state, [...gitHubCodeQlSync.insights, ...gitHubDependabotSync.insights]);
  const langSmithConfig = resolveLangSmithRuntimeConfig();
  const lightweightResearchScoutInspect = shouldUseLightweightResearchScoutInspect(state);
  const effectiveLangSmithEnabled = Boolean(langSmithConfig) && !lightweightResearchScoutInspect;
  const evaluationGatePolicy = resolveStateEvaluationGatePolicy(state);
  const governanceProfile = resolveControlPlaneGovernanceProfile(state.repoRoot);
  const promptIdentifier = String(state.promptIdentifier || DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER).trim()
    || DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER;
  const promptRef = String(state.promptRef || '').trim();
  const promptChannel = normalizePromptChannel(state.promptChannel) || DEFAULT_CONTROL_PLANE_PROMPT_CHANNEL;
  const promptSyncEnabled = state.promptSyncEnabled !== false;
  const promptSyncChannel = normalizePromptChannel(state.promptSyncChannel) || DEFAULT_CONTROL_PLANE_PROMPT_SYNC_CHANNEL;
  const promptPromoteChannel = normalizePromptChannel(state.promptPromoteChannel);
  const projectGovernanceMetadata = buildControlPlaneLangSmithProjectMetadata(
    promptIdentifier,
    promptSyncChannel,
    evaluationGatePolicy,
    state.experimentalApiBaseUrl,
    state.experimentalServiceName,
    governanceProfile.name,
  );
  const localPromptBundle = getDefaultControlPlanePromptBundle();
  let controlPlanePrompts = localPromptBundle;
  let selectedPromptReference = '';
  let selectedPromptSource: ControlPlanePromptSelectionSource = 'local';
  let selectedPromptChannel = '';
  let selectedPromptCommitHash = '';
  let selectedPromptMetadata: Record<string, unknown> = {};
  let selectedPromptAvailableChannels: string[] = [];
  let promptRollbackReference = '';
  let promptSyncUrl = '';
  let promptPromotionUrl = '';
  let promptPromotionReason = '';
  let promptPromotionBlockedReason = '';
  const promptSelectionNotes: string[] = [];
  const semanticMemoryNotes = await readSemanticMemoryNotes(runtime?.store, state).catch(() => [] as Array<z.infer<typeof SemanticMemoryNoteSchema>>);
  let langSmithSnapshot: Awaited<ReturnType<typeof collectLangSmithClientSnapshot>> | null = null;
  let langSmithProject: z.infer<typeof LangSmithProjectSummarySchema> | null = null;
  let langSmithAccessibleWorkspaces: Array<z.infer<typeof LangSmithWorkspaceSummarySchema>> = [];
  let langSmithGovernance: z.infer<typeof LangSmithGovernanceSummarySchema> | null = null;
  let governanceGateResult: ControlPlaneGovernanceGateResult = GovernanceGateResultSchema.parse({
    ...DEFAULT_GOVERNANCE_GATE_RESULT,
    target: governanceProfile.gateTarget,
  });
  const langSmithGovernanceMutations: Array<z.infer<typeof LangSmithGovernanceMutationSchema>> = [];
  const langSmithNotes: string[] = [];
  let langSmithEvaluations: Array<z.infer<typeof LangSmithEvaluationSummarySchema>> = [];
  let observabilityTags: string[] = [];
  let observabilityMetadata: Record<string, unknown> = {};
  let controlPlaneRunDataset: z.infer<typeof LangSmithDatasetSummarySchema> | null = null;
  let seededDataset: z.infer<typeof LangSmithDatasetSummarySchema> | null = null;
  const plannerNotes = mcpServers.length > 0
    ? [`MCP config detected at ${configPath} with servers: ${mcpServers.map((server) => server.name).join(', ')}`]
    : [`No MCP config found at ${configPath}; workflow will use shell jobs only.`];
  plannerNotes.push(...codeQlNotes);
  plannerNotes.push(...gitHubCodeQlSync.notes);
  plannerNotes.push(...gitHubDependabotSync.notes);

  if (effectiveLangSmithEnabled && langSmithConfig) {
    try {
      const governanceMutation = await syncLangSmithProjectGovernance(langSmithConfig, {
        description: CONTROL_PLANE_LANGSMITH_PROJECT_DESCRIPTION,
        metadata: projectGovernanceMetadata,
      }).catch(() => null);
      if (governanceMutation) {
        langSmithGovernanceMutations.push(LangSmithGovernanceMutationSchema.parse(governanceMutation));
      }
      langSmithSnapshot = await collectLangSmithClientSnapshot(langSmithConfig);
      if (langSmithSnapshot) {
        langSmithProject = langSmithSnapshot.currentProject
          ? LangSmithProjectSummarySchema.parse(langSmithSnapshot.currentProject)
          : null;
        langSmithAccessibleWorkspaces = (langSmithSnapshot.accessibleWorkspaces || [])
          .map((workspace) => LangSmithWorkspaceSummarySchema.parse(workspace));
        langSmithNotes.push(
          `LangSmith workspace ${langSmithSnapshot.workspace?.displayName || 'unknown'} project ${langSmithSnapshot.projectName} with ${langSmithSnapshot.recentProjects.length} project(s), ${langSmithSnapshot.recentRuns.length} recent run(s), ${langSmithSnapshot.datasets.length} dataset(s), ${langSmithSnapshot.prompts.length} prompt(s), ${langSmithSnapshot.annotationQueues.length} annotation queue(s), and ${langSmithSnapshot.feedback.length} feedback item(s).`,
        );
        langSmithNotes.push(...summarizeLangSmithQueueFeedbackSnapshot(langSmithSnapshot));

        const controlPlaneDatasetName = `${langSmithSnapshot.projectName}-control-plane-runs`;
        controlPlaneRunDataset = await createControlPlaneRunDatasetFromProject(langSmithConfig, controlPlaneDatasetName).catch(() => null);
        if (controlPlaneRunDataset?.name) {
          langSmithNotes.push(`LangSmith dataset ready: ${controlPlaneRunDataset.name}`);
        }

        const seededDatasetName = `${langSmithSnapshot.projectName}-control-plane-seed`;
        seededDataset = await ensureLangSmithExamplesDataset(
          langSmithConfig,
          seededDatasetName,
          [
            {
              inputs: {
                goal: state.goal,
                scopes: getEffectiveScopes(state),
                task: 'Summarize current control-plane priorities',
              },
              outputs: {
                answer: 'Prioritize safe control-plane planning, log analysis, MCP inspection, and experimental-only operations.',
              },
              metadata: { source: 'control-plane-seed' },
            },
          ],
          {
            description: 'Seed examples for control-plane evaluation and experimentation',
          },
        ).catch(() => null);
        if (seededDataset?.name) {
          langSmithNotes.push(`LangSmith seed dataset ready: ${seededDataset.name}`);
        }

        if (promptSyncEnabled) {
          promptSyncUrl = await ensureLangSmithPrompt(
            langSmithConfig,
            promptIdentifier,
            buildControlPlanePromptManifest(promptIdentifier, localPromptBundle),
            {
              description: CONTROL_PLANE_PROMPT_DESCRIPTION,
              tags: uniqueNormalizedStrings([...CONTROL_PLANE_PROMPT_TAGS, promptSyncChannel, 'sync']),
              readme: CONTROL_PLANE_PROMPT_README,
              channel: promptSyncChannel,
              metadata: {
                source: 'anygpt-langgraph-control-plane',
                promptIdentifier,
                channels: CONTROL_PLANE_PROMPT_LIFECYCLE_CHANNELS,
                channel: promptSyncChannel,
                requestedChannel: promptChannel,
                syncChannel: promptSyncChannel,
                promoteChannel: promptPromoteChannel || undefined,
                governanceProfile: governanceProfile.name,
                evaluationGateMode: evaluationGatePolicy.mode,
                evaluationGateTarget: evaluationGatePolicy.target,
                experimentalApiBaseUrl: state.experimentalApiBaseUrl,
                experimentalServiceName: state.experimentalServiceName,
              },
            },
          ).catch(() => null) || '';
          if (promptSyncUrl) {
            promptSelectionNotes.push(`LangSmith prompt synced to ${buildLangSmithPromptReference(promptIdentifier, promptSyncChannel)}.`);
          } else {
            promptSelectionNotes.push(`LangSmith prompt sync was enabled for ${buildLangSmithPromptReference(promptIdentifier, promptSyncChannel)} but no URL was returned.`);
          }
        } else {
          promptSelectionNotes.push(`LangSmith prompt sync disabled for ${promptIdentifier}; using existing prompt versions only.`);
        }

        const promptPullCandidates = [
          promptRef
            ? {
                source: 'explicit' as const,
                ref: promptRef,
                label: `explicit ref ${promptRef}`,
              }
            : null,
          promptChannel
            ? {
                source: 'channel' as const,
                ref: buildLangSmithPromptReference(promptIdentifier, promptChannel),
                label: `channel ${promptChannel}`,
              }
            : null,
          {
            source: 'latest' as const,
            ref: promptIdentifier,
            label: `latest prompt ${promptIdentifier}`,
          },
        ].filter(Boolean) as Array<{ source: ControlPlanePromptSelectionSource; ref: string; label: string }>;

        const attemptedPromptRefs = new Set<string>();
        for (const candidate of promptPullCandidates) {
          if (!candidate.ref || attemptedPromptRefs.has(candidate.ref)) continue;
          attemptedPromptRefs.add(candidate.ref);

          const pulledPrompt = await pullLangSmithPromptCommit(langSmithConfig, candidate.ref).catch(() => null);
          if (!pulledPrompt) {
            promptSelectionNotes.push(`LangSmith prompt ${candidate.label} unavailable; continuing fallback selection.`);
            continue;
          }

          const extractedPromptBundle = extractControlPlanePromptBundleFromCommit(pulledPrompt);
          if (!extractedPromptBundle) {
            promptSelectionNotes.push(`LangSmith prompt ${candidate.ref} returned an unsupported manifest; continuing fallback selection.`);
            continue;
          }

          controlPlanePrompts = extractedPromptBundle;
          selectedPromptReference = candidate.ref;
          selectedPromptSource = candidate.source;
          selectedPromptCommitHash = extractPromptCommitHash(pulledPrompt);
          selectedPromptMetadata = extractPromptMetadataFromCommit(pulledPrompt);
          selectedPromptAvailableChannels = extractPromptChannelsFromCommit(pulledPrompt);
          selectedPromptChannel = candidate.source === 'channel'
            ? normalizePromptChannel(promptChannel)
            : normalizePromptChannel(String((selectedPromptMetadata as any)?.channel || '')) || inferPromptChannelFromReference(candidate.ref);
          promptRollbackReference = selectedPromptCommitHash
            ? buildLangSmithPromptReference(promptIdentifier, selectedPromptCommitHash)
            : candidate.ref;
          break;
        }

        if (selectedPromptReference) {
          promptSelectionNotes.push(`LangSmith prompt selected: ${selectedPromptReference}${selectedPromptCommitHash ? ` @ ${selectedPromptCommitHash}` : ''} (${selectedPromptSource}).`);
        }

        if (seededDataset?.name) {
          const baselineSeedEvaluation = selectBaselineEvaluation(state.langSmithEvaluations, seededDataset.name);
          const evaluation = await runLangSmithDatasetEvaluation(
            langSmithConfig,
            seededDataset.name,
            async (inputs: Record<string, any>) => ({
              answer: [
                `Control-plane goal: ${String(inputs?.goal || '').trim() || 'unknown goal'}`,
                `scopes=${Array.isArray(inputs?.scopes) ? inputs.scopes.join(',') : ''}`,
              ].join(' | '),
            }),
            `${langSmithSnapshot.projectName}-control-plane-eval`,
            [
              (run: any, example: any) => {
                const prediction = String(run?.outputs?.answer || '');
                const goal = String(example?.inputs?.goal || '').trim();
                const scopes = Array.isArray(example?.inputs?.scopes)
                  ? example.inputs.scopes.map((scope: unknown) => String(scope || '').trim()).filter(Boolean)
                  : [];
                const hasGoalContext = goal ? prediction.includes(goal) : prediction.length > 0;
                const scopesTracked = scopes.length === 0 || scopes.every((scope: string) => prediction.includes(scope));
                return [
                  {
                    key: evaluationGatePolicy.metricKey,
                    score: hasGoalContext ? 1 : 0,
                    comment: `prediction_length=${prediction.length}`,
                  },
                  {
                    key: 'scopes_echoed',
                    score: scopesTracked ? 1 : 0,
                    comment: `scope_count=${scopes.length}`,
                  },
                  {
                    key: 'prompt_commit_tracked',
                    score: selectedPromptCommitHash ? 1 : 0,
                    comment: `prompt_commit=${selectedPromptCommitHash || 'local'}`,
                  },
                ];
              },
            ],
            {
              metadata: {
                goal: state.goal,
                scopes: getEffectiveScopes(state),
                thread_id: state.threadId,
                prompt_identifier: promptIdentifier,
                prompt_ref: selectedPromptReference || promptIdentifier,
                prompt_channel: selectedPromptChannel || promptChannel,
                prompt_source: selectedPromptSource,
                prompt_commit_hash: selectedPromptCommitHash || undefined,
                governance_profile: governanceProfile.name,
                eval_gate_mode: evaluationGatePolicy.mode,
                eval_gate_target: evaluationGatePolicy.target,
                autonomous: state.autonomous,
              },
              scorecardName: evaluationGatePolicy.scorecardName,
              aggregationMode: evaluationGatePolicy.aggregationMode,
              primaryMetricKey: evaluationGatePolicy.metricKey,
              requiredMetricKeys: evaluationGatePolicy.requiredMetricKeys,
              metricThresholds: {
                [evaluationGatePolicy.metricKey]: evaluationGatePolicy.minMetricAverageScore,
                ...evaluationGatePolicy.additionalMetricThresholds,
              },
              metricWeights: evaluationGatePolicy.metricWeights,
              minimumWeightedScore: evaluationGatePolicy.minimumWeightedScore,
              baselineEvaluation: baselineSeedEvaluation
                ? {
                    ...baselineSeedEvaluation,
                    experimentName: baselineSeedEvaluation.experimentName || baselineSeedEvaluation.datasetName,
                  }
                : undefined,
              baselineExperimentName: baselineSeedEvaluation?.experimentName || evaluationGatePolicy.baselineExperimentName || undefined,
            },
          ).catch(() => null);
          if (evaluation) {
            langSmithEvaluations.push(LangSmithEvaluationSummarySchema.parse(evaluation));
            langSmithNotes.push(`LangSmith evaluation recorded: ${evaluation.experimentName} on ${evaluation.datasetName}`);
          }
        }
      }
    } catch (error: any) {
      langSmithNotes.push(`LangSmith snapshot unavailable: ${redactSensitiveText(error?.message || String(error))}`);
    }
  } else if (langSmithConfig && lightweightResearchScoutInspect) {
    langSmithNotes.push('LangSmith fast path: skipped full LangSmith snapshot, evaluation, and governance work for research-scout so browser discovery can start faster.');
    promptSelectionNotes.push(`Using local control-plane prompt bundle fallback for ${promptIdentifier} because research-scout lightweight inspect mode is enabled.`);
  } else {
    if (promptSyncEnabled) {
      promptSelectionNotes.push(`Prompt sync requested for ${buildLangSmithPromptReference(promptIdentifier, promptSyncChannel)} but LangSmith runtime integration is disabled.`);
    }
    if (promptPromoteChannel) {
      promptSelectionNotes.push(`Prompt promotion requested for ${buildLangSmithPromptReference(promptIdentifier, promptPromoteChannel)} but LangSmith runtime integration is disabled.`);
    }
  }

  const evaluationGateResult = resolveEvaluationGateResult(
    evaluationGatePolicy,
    langSmithEvaluations,
    effectiveLangSmithEnabled,
  );
  langSmithNotes.push(evaluationGateResult.reason);
  const blockedActions = describeEvaluationGateBlockedActions(evaluationGateResult);
  if (blockedActions.length > 0) {
    langSmithNotes.push(`Evaluation gate blocked: ${blockedActions.join(', ')}`);
  }

  const mergedLangSmithDatasets = [...(langSmithSnapshot?.datasets || [])];
  for (const dataset of [controlPlaneRunDataset, seededDataset]) {
    if (!dataset?.name) continue;
    if (!mergedLangSmithDatasets.some((entry) => entry.name === dataset.name)) {
      mergedLangSmithDatasets.unshift(LangSmithDatasetSummarySchema.parse(dataset));
    }
  }

  const mergedLangSmithPrompts = [...(langSmithSnapshot?.prompts || [])];
  if (
    promptIdentifier
    && (promptSyncUrl || promptPromotionUrl || selectedPromptSource !== 'local')
    && !mergedLangSmithPrompts.some((prompt) => prompt.identifier === promptIdentifier)
  ) {
    mergedLangSmithPrompts.unshift(LangSmithPromptSummarySchema.parse({
      identifier: promptIdentifier,
      description: CONTROL_PLANE_PROMPT_DESCRIPTION,
      updatedAt: new Date().toISOString(),
      commitHash: selectedPromptCommitHash || undefined,
      channels: uniqueNormalizedStrings([...selectedPromptAvailableChannels, promptSyncChannel, selectedPromptChannel].filter(Boolean)),
      metadata: selectedPromptMetadata,
    }));
  }

  if (langSmithConfig && langSmithSnapshot) {
    const governanceSnapshot = await collectLangSmithGovernanceSnapshot(langSmithConfig, {
      snapshot: {
        ...langSmithSnapshot,
        accessibleWorkspaces: langSmithAccessibleWorkspaces,
        currentProject: langSmithProject,
        datasets: mergedLangSmithDatasets,
        prompts: mergedLangSmithPrompts,
      },
      promptIdentifier,
        expectedDatasetNames: [`${langSmithSnapshot.projectName}-control-plane-runs`, `${langSmithSnapshot.projectName}-control-plane-seed`],
        requiredProjectMetadata: projectGovernanceMetadata,
        queueBacklogWarnThreshold: governanceProfile.queueBacklogWarnThreshold,
        evaluations: langSmithEvaluations.map((evaluation) => LangSmithEvaluationSummarySchema.parse(evaluation)),
        minimumFeedbackCount: governanceProfile.minimumFeedbackCount,
        minimumEvaluationResults: governanceProfile.minimumEvaluationResults,
        minimumSuccessfulEvaluations: governanceProfile.minimumSuccessfulEvaluations,
        blockOnWarn: governanceProfile.blockAutonomousOnWarn,
        requirePromptCommit: governanceProfile.requirePromptCommit,
        mutations: langSmithGovernanceMutations,
      }).catch(() => null);

    if (governanceSnapshot) {
      langSmithGovernance = LangSmithGovernanceSummarySchema.parse(governanceSnapshot);
      langSmithNotes.push(...summarizeLangSmithGovernanceSnapshot(governanceSnapshot));
    }
  }

  governanceGateResult = resolveGovernanceGateResult(
    governanceProfile,
    langSmithGovernance,
    effectiveLangSmithEnabled,
  );
  langSmithNotes.push(governanceGateResult.reason);
  const governanceBlockedActions = describeGovernanceGateBlockedActions(governanceGateResult);
  if (governanceBlockedActions.length > 0) {
    langSmithNotes.push(`Governance gate blocked: ${governanceBlockedActions.join(', ')}`);
  }

  if (!selectedPromptReference.trim()) {
    selectedPromptReference = promptIdentifier;
    selectedPromptChannel = promptChannel;
    selectedPromptAvailableChannels = uniqueNormalizedStrings([...selectedPromptAvailableChannels, ...CONTROL_PLANE_PROMPT_LIFECYCLE_CHANNELS, promptChannel]);
    selectedPromptMetadata = {
      source: 'local',
      channel: promptChannel,
      channels: CONTROL_PLANE_PROMPT_LIFECYCLE_CHANNELS,
    };
    promptSelectionNotes.push(`Using local control-plane prompt bundle fallback for ${promptIdentifier}.`);
  }

  if (promptRollbackReference) {
    promptSelectionNotes.push(`Prompt rollback reference: ${promptRollbackReference}`);
  }

  if (promptPromoteChannel) {
    promptPromotionReason = `Promote ${selectedPromptReference || promptIdentifier} to ${buildLangSmithPromptReference(promptIdentifier, promptPromoteChannel)} after evaluation ${evaluationGateResult.status} and governance ${governanceGateResult.status}.`;
    const promotionAllowed = !evaluationGateResult.blocksAutonomousEdits
      && !evaluationGateResult.blocksExecution
      && !governanceGateResult.blocksAutonomousEdits
      && !governanceGateResult.blocksExecution;

    if (!langSmithConfig) {
      promptPromotionBlockedReason = `Prompt promotion requested for ${buildLangSmithPromptReference(promptIdentifier, promptPromoteChannel)} but LangSmith runtime integration is disabled.`;
      promptSelectionNotes.push(promptPromotionBlockedReason);
    } else if (!promotionAllowed) {
      promptPromotionBlockedReason = `Prompt promotion blocked by active gates: ${[evaluationGateResult.reason, governanceGateResult.reason].filter(Boolean).join(' | ')}`;
      promptSelectionNotes.push(promptPromotionBlockedReason);
    } else {
      promptPromotionUrl = await ensureLangSmithPrompt(
        langSmithConfig,
        promptIdentifier,
        buildControlPlanePromptManifest(promptIdentifier, controlPlanePrompts),
        {
          description: CONTROL_PLANE_PROMPT_DESCRIPTION,
          tags: uniqueNormalizedStrings([...CONTROL_PLANE_PROMPT_TAGS, promptPromoteChannel, 'promotion']),
          readme: CONTROL_PLANE_PROMPT_README,
          parentCommitHash: selectedPromptCommitHash || undefined,
          channel: promptPromoteChannel,
          metadata: {
            source: 'anygpt-langgraph-control-plane',
            promptIdentifier,
            channels: CONTROL_PLANE_PROMPT_LIFECYCLE_CHANNELS,
            channel: promptPromoteChannel,
            selectedPromptReference,
            selectedPromptCommitHash: selectedPromptCommitHash || undefined,
            promptRollbackReference: promptRollbackReference || undefined,
            promotionReason: promptPromotionReason,
            governanceProfile: governanceProfile.name,
            evaluationGateStatus: evaluationGateResult.status,
            governanceGateStatus: governanceGateResult.status,
          },
        },
      ).catch(() => null) || '';

      if (promptPromotionUrl) {
        promptSelectionNotes.push(`LangSmith prompt promoted to ${buildLangSmithPromptReference(promptIdentifier, promptPromoteChannel)}: ${promptPromotionUrl}`);
      } else {
        promptPromotionBlockedReason = `LangSmith prompt promotion requested for ${buildLangSmithPromptReference(promptIdentifier, promptPromoteChannel)} but no URL was returned.`;
        promptSelectionNotes.push(promptPromotionBlockedReason);
      }
    }
  }

  observabilityTags = buildControlPlaneObservabilityTags(
    {
      scopes: state.scopes,
      effectiveScopes: state.effectiveScopes,
      scopeExpansionReason: state.scopeExpansionReason,
      scopeExpansionMode: state.scopeExpansionMode,
      autonomous: state.autonomous,
      continuous: state.continuous,
      promptIdentifier,
      selectedPromptReference,
      selectedPromptSource,
      selectedPromptChannel,
      governanceProfile: governanceProfile.name,
      evaluationGatePolicy,
    },
    mergedLangSmithDatasets.slice(0, 3).map((dataset) => dataset.name),
  );
  observabilityMetadata = buildControlPlaneObservabilityMetadata(state, {
    prompt_identifier: promptIdentifier,
    prompt_ref: selectedPromptReference || promptIdentifier,
    prompt_channel: selectedPromptChannel || promptChannel,
    prompt_source: selectedPromptSource,
    prompt_commit_hash: selectedPromptCommitHash || undefined,
    prompt_rollback_reference: promptRollbackReference || undefined,
    prompt_sync_channel: promptSyncChannel,
    prompt_promote_channel: promptPromoteChannel || undefined,
    prompt_promotion_reason: promptPromotionReason || undefined,
    prompt_promotion_blocked_reason: promptPromotionBlockedReason || undefined,
    governance_profile: governanceProfile.name,
    evaluation_gate_status: evaluationGateResult.status,
    governance_gate_status: governanceGateResult.status,
    sampled_dataset_names: mergedLangSmithDatasets.map((dataset) => dataset.name),
    sampled_prompt_identifiers: mergedLangSmithPrompts.map((prompt) => prompt.identifier),
  });

  langSmithNotes.push(...promptSelectionNotes);

  plannerNotes.push(...langSmithNotes);

  for (const config of mcpServerConfigs) {
    mcpInspections.push(await inspectMcpServer(config, state.repoRoot));
  }

  const connectedServers = mcpInspections.filter((inspection) => inspection.status === 'connected');
  const failedServers = mcpInspections.filter((inspection) => inspection.status === 'failed');
  const discoveredToolCount = connectedServers.reduce((total, inspection) => total + inspection.tools.length, 0);

  if (connectedServers.length > 0) {
    plannerNotes.push(`Connected to ${connectedServers.length} MCP server(s) and discovered ${discoveredToolCount} tool(s).`);
    for (const inspection of connectedServers) {
      const toolNames = inspection.tools.map((tool) => tool.name).join(', ') || 'none';
      plannerNotes.push(`MCP server ${inspection.server} tools: ${toolNames}`);
    }
  }

  if (failedServers.length > 0) {
    for (const inspection of failedServers) {
      plannerNotes.push(`MCP server ${inspection.server} inspection failed: ${inspection.message}`);
    }
  }

  if (logInsights.length > 0) {
    plannerNotes.push(`Loaded ${logInsights.length} log input(s) for planning and fix guidance.`);
  }

    const { scopes: effectiveScopes, reason: scopeExpansionReason } = resolveEffectiveScopes(state);

    return {
      effectiveScopes,
      scopeExpansionReason,
      mcpConfigPath: configPath,
      mcpServers,
      mcpInspections,
      logInsights,
      promptIdentifier,
      promptRef,
      promptChannel,
      promptSyncEnabled,
      promptSyncChannel,
      promptPromoteChannel,
      controlPlanePrompts,
      selectedPromptReference,
      selectedPromptSource,
      selectedPromptChannel,
      selectedPromptCommitHash,
      selectedPromptMetadata,
      selectedPromptAvailableChannels,
      promptRollbackReference,
      promptSyncUrl,
      promptPromotionUrl,
      promptPromotionReason,
      promptPromotionBlockedReason,
      promptSelectionNotes,
      semanticMemoryNotes,
      governanceProfile: governanceProfile.name,
      langSmithEnabled: effectiveLangSmithEnabled,
      langSmithProjectName: langSmithProject?.name || langSmithSnapshot?.projectName || langSmithConfig?.projectName || '',
      langSmithWorkspace: langSmithSnapshot?.workspace || null,
      langSmithAccessibleWorkspaces,
      langSmithProject,
      langSmithProjects: langSmithSnapshot?.recentProjects || [],
      langSmithRuns: langSmithSnapshot?.recentRuns || [],
      langSmithDatasets: mergedLangSmithDatasets,
      langSmithPrompts: mergedLangSmithPrompts,
      langSmithAnnotationQueues: langSmithSnapshot?.annotationQueues || [],
      langSmithAnnotationQueueItems: langSmithSnapshot?.annotationQueueItems || [],
      langSmithFeedback: langSmithSnapshot?.feedback || [],
      langSmithEvaluations,
      langSmithGovernance,
      governanceGateResult,
      langSmithNotes,
      observabilityTags,
      observabilityMetadata,
      evaluationGatePolicy,
      evaluationGateResult,
      plannerNotes,
    };
}

async function plannerAgentNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const scopes = getEffectiveScopes(state);
  const notes = [...state.plannerNotes];
  const unsupportedScopes = scopes.filter((scope) => !SCOPE_COMMANDS[scope]);
  if (unsupportedScopes.length > 0) {
    notes.push(`Unsupported scopes need manual mapping: ${unsupportedScopes.join(', ')}`);
  }
  if (state.scopeExpansionReason.trim()) {
    notes.push(`Adaptive scope expansion: ${state.scopeExpansionReason}`);
  }
  if (hasApiFamilyScope(scopes)) {
    notes.push(`API jobs are pinned to experimental-safe build/test defaults and isolated control-plane data files under ${CONTROL_PLANE_DATA_DIR}.`);
    notes.push(`Default deploy target is ${SAFE_EXPERIMENTAL_DEPLOY_COMMAND}; production service restarts targeting anygpt.service are intentionally blocked.`);
    notes.push(`Experimental test jobs clone Redis/Dragonfly DB ${CONTROL_PLANE_SOURCE_REDIS_DB} into DB ${CONTROL_PLANE_TARGET_REDIS_DB} before execution by default.`);
  }

  for (const insight of state.logInsights) {
    if (insight.lines.length === 0) continue;
    notes.push(`Log input ${insight.file}: ${insight.lines[insight.lines.length - 1]}`);
  }

  if (scopes.length === 1 && scopes[0] === 'research-scout') {
    const mergedNotes = appendUniqueNotes(notes, [
      'Research scout deterministic mode: search planning is generated from trusted-source packs and queued requests first; AI synthesis is deferred until web evidence exists.',
    ]);
    return {
      effectiveScopes: scopes,
      plannerNotes: mergedNotes,
      aiAgentEnabled: state.aiAgentEnabled,
      aiAgentBackend: state.aiAgentBackend,
      aiAgentModel: state.aiAgentModel,
      plannerAgentInsights: [],
      lastAiFailureClass: state.lastAiFailureClass,
    };
  }

  const aiPlanner = await callAiNotesAgent(
    'planner',
    state,
    {
      ...buildSharedAiAgentPayload(state),
      currentNotes: compactStringArrayForAi(notes, AI_AGENT_CONTEXT_NOTE_LIMIT),
    },
    state.controlPlanePrompts.planner,
  );

  const prefixedAiNotes = aiPlanner.notes.map((note) => `AI planner agent: ${note}`);
  const mergedNotes = appendUniqueNotes(notes, prefixedAiNotes);
  if (aiPlanner.error) {
    mergedNotes.push(`AI planner agent unavailable: ${aiPlanner.error}`);
  }
  if (aiPlanner.backpressure) {
    const retrySuffix = aiPlanner.retryAfterSeconds
      ? ` Retry after about ${aiPlanner.retryAfterSeconds}s.`
      : '';
    mergedNotes.push(`AI backend backpressure detected during planner stage; throttle follow-up AI work for this lane.${retrySuffix}`);
  }

  return {
    effectiveScopes: scopes,
    plannerNotes: mergedNotes,
    aiAgentEnabled: state.aiAgentEnabled || aiPlanner.enabled,
    aiAgentBackend: state.aiAgentBackend || aiPlanner.backend,
    aiAgentModel: state.aiAgentModel || aiPlanner.model,
    plannerAgentInsights: aiPlanner.notes,
    lastAiFailureClass: aiPlanner.error ? (aiPlanner.failureClass || 'backend-error') : state.lastAiFailureClass,
  };
}

async function planMcpActionsNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!state.mcpActionEnabled || state.maxMcpActions <= 0) {
    return {
      plannedMcpActions: [],
      executedMcpActions: [],
      mcpActionNotes: [],
    };
  }

  const plannedMcpActions = buildDeterministicMcpActionPlan(state);
  const notes: string[] = [];

  if (plannedMcpActions.length === 0) {
    notes.push('No bounded MCP actions were planned for this run.');
  } else {
    for (const action of plannedMcpActions) {
      notes.push(
        `Planned MCP action ${action.server}.${action.tool} (${action.risk}${action.alwaysAllow ? ', always-allow' : ''}): ${action.reason}`,
      );
    }
  }

  return {
    plannedMcpActions,
    executedMcpActions: [],
    mcpActionNotes: notes,
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

async function buildAgentNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const buildJobs = buildScopeJobs(getEffectiveScopes(state), 'build');
  if (getEffectiveScopes(state).length === 1 && getEffectiveScopes(state)[0] === 'research-scout') {
    return {
      buildJobs,
      plannerNotes: appendUniqueNotes(state.plannerNotes, ['Research scout skipped generic build-agent advice; evidence synthesis happens after web results are collected.']),
      aiAgentEnabled: state.aiAgentEnabled,
      aiAgentBackend: state.aiAgentBackend,
      aiAgentModel: state.aiAgentModel,
      buildAgentInsights: [],
      lastAiFailureClass: state.lastAiFailureClass,
    };
  }
  if (hasRecentAiBackendBackpressure(state)) {
    const notes = appendUniqueNotes(
      state.plannerNotes,
      ['AI build agent skipped because the shared AI backend is under queue pressure; preserving capacity for a later retry.'],
    );
    return {
      buildJobs,
      plannerNotes: notes,
      aiAgentEnabled: state.aiAgentEnabled,
      aiAgentBackend: state.aiAgentBackend,
      aiAgentModel: state.aiAgentModel,
      buildAgentInsights: [],
      lastAiFailureClass: 'backpressure',
    };
  }
  const aiBuild = await callAiNotesAgent(
    'build',
    state,
    {
      ...buildSharedAiAgentPayload(state),
      buildJobs,
    },
    state.controlPlanePrompts.build,
  );

  const plannerNotes = appendUniqueNotes(state.plannerNotes, [
    ...aiBuild.notes.map((note) => `AI build agent: ${note}`),
    ...(aiBuild.error ? [`AI build agent unavailable: ${aiBuild.error}`] : []),
    ...(aiBuild.backpressure
      ? [`AI backend backpressure detected during build stage; later AI-heavy work in this lane should back off${aiBuild.retryAfterSeconds ? ` for about ${aiBuild.retryAfterSeconds}s` : ''}.`]
      : []),
  ]);
  return {
    buildJobs,
    plannerNotes,
    aiAgentEnabled: state.aiAgentEnabled || aiBuild.enabled,
    aiAgentBackend: state.aiAgentBackend || aiBuild.backend,
    aiAgentModel: state.aiAgentModel || aiBuild.model,
    buildAgentInsights: aiBuild.notes,
    lastAiFailureClass: aiBuild.error ? (aiBuild.failureClass || 'backend-error') : state.lastAiFailureClass,
  };
}

async function qualityAgentNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const testJobs = buildScopeJobs(getEffectiveScopes(state), 'test');
  if (getEffectiveScopes(state).length === 1 && getEffectiveScopes(state)[0] === 'research-scout') {
    return {
      testJobs,
      plannerNotes: appendUniqueNotes(state.plannerNotes, ['Research scout skipped generic quality-agent advice; search/result quality is evaluated after website evidence is collected.']),
      aiAgentEnabled: state.aiAgentEnabled,
      aiAgentBackend: state.aiAgentBackend,
      aiAgentModel: state.aiAgentModel,
      qualityAgentInsights: [],
      lastAiFailureClass: state.lastAiFailureClass,
    };
  }
  if (hasRecentAiBackendBackpressure(state)) {
    const notes = appendUniqueNotes(
      state.plannerNotes,
      ['AI quality agent skipped because the shared AI backend is under queue pressure; preserving capacity for repair planning.'],
    );
    return {
      testJobs,
      plannerNotes: notes,
      aiAgentEnabled: state.aiAgentEnabled,
      aiAgentBackend: state.aiAgentBackend,
      aiAgentModel: state.aiAgentModel,
      qualityAgentInsights: [],
      lastAiFailureClass: 'backpressure',
    };
  }
  const aiQuality = await callAiNotesAgent(
    'quality',
    state,
    {
      ...buildSharedAiAgentPayload(state),
      testJobs,
    },
    state.controlPlanePrompts.quality,
  );

  const plannerNotes = appendUniqueNotes(state.plannerNotes, [
    ...aiQuality.notes.map((note) => `AI quality agent: ${note}`),
    ...(aiQuality.error ? [`AI quality agent unavailable: ${aiQuality.error}`] : []),
    ...(aiQuality.backpressure
      ? [`AI backend backpressure detected during quality stage; later AI-heavy work in this lane should back off${aiQuality.retryAfterSeconds ? ` for about ${aiQuality.retryAfterSeconds}s` : ''}.`]
      : []),
  ]);
  return {
    testJobs,
    plannerNotes,
    aiAgentEnabled: state.aiAgentEnabled || aiQuality.enabled,
    aiAgentBackend: state.aiAgentBackend || aiQuality.backend,
    aiAgentModel: state.aiAgentModel || aiQuality.model,
    qualityAgentInsights: aiQuality.notes,
    lastAiFailureClass: aiQuality.error ? (aiQuality.failureClass || 'backend-error') : state.lastAiFailureClass,
  };
}

async function deployAgentNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const deployJobs: PlannedJob[] = [];

  if (state.allowDeploy) {
    const chosenCommand = state.deployCommand.trim() || getDefaultDeployCommand(state);
    deployJobs.push({
      id: 'deploy',
      target: 'repo',
      kind: 'deploy',
      title: 'Deploy repository changes',
      command: isUnsafeProductionDeployCommand(chosenCommand)
        ? 'echo "Blocked unsafe deploy command that targeted the production AnyGPT service"'
        : chosenCommand,
      });
  }

  if (getEffectiveScopes(state).length === 1 && getEffectiveScopes(state)[0] === 'research-scout') {
    return {
      deployJobs,
      plannerNotes: appendUniqueNotes(state.plannerNotes, ['Research scout skipped generic deploy-agent advice; it is a suggestion-only lane and does not need pre-search deployment planning.']),
      aiAgentEnabled: state.aiAgentEnabled,
      aiAgentBackend: state.aiAgentBackend,
      aiAgentModel: state.aiAgentModel,
      deployAgentInsights: [],
      lastAiFailureClass: state.lastAiFailureClass,
    };
  }

  if (hasRecentAiBackendBackpressure(state)) {
    const notes = appendUniqueNotes(
      state.plannerNotes,
      ['AI deploy agent skipped because the shared AI backend is under queue pressure; preserving capacity for repair planning.'],
    );
    return {
      deployJobs,
      plannerNotes: notes,
      aiAgentEnabled: state.aiAgentEnabled,
      aiAgentBackend: state.aiAgentBackend,
      aiAgentModel: state.aiAgentModel,
      deployAgentInsights: [],
      lastAiFailureClass: 'backpressure',
    };
  }

  const aiDeploy = await callAiNotesAgent(
    'deploy',
    state,
    {
      ...buildSharedAiAgentPayload(state),
      deployJobs,
    },
    state.controlPlanePrompts.deploy,
  );

  const plannerNotes = appendUniqueNotes(state.plannerNotes, [
    ...aiDeploy.notes.map((note) => `AI deploy agent: ${note}`),
    ...(aiDeploy.error ? [`AI deploy agent unavailable: ${aiDeploy.error}`] : []),
    ...(aiDeploy.backpressure
      ? [`AI backend backpressure detected during deploy stage; later AI-heavy work in this lane should back off${aiDeploy.retryAfterSeconds ? ` for about ${aiDeploy.retryAfterSeconds}s` : ''}.`]
      : []),
  ]);
  return {
    deployJobs,
    plannerNotes,
    aiAgentEnabled: state.aiAgentEnabled || aiDeploy.enabled,
    aiAgentBackend: state.aiAgentBackend || aiDeploy.backend,
    aiAgentModel: state.aiAgentModel || aiDeploy.model,
    deployAgentInsights: aiDeploy.notes,
    lastAiFailureClass: aiDeploy.error ? (aiDeploy.failureClass || 'backend-error') : state.lastAiFailureClass,
  };
}

async function repairIntentNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const repairIntent = deriveRepairIntent(state);
  const autonomousOperationMode: AutonomousOperationMode = !state.autonomousEditEnabled
    ? 'idle'
    : (hasActionableRepairSignals(repairIntent.signals) ? 'repair' : 'improvement');
  const improvementIntent = autonomousOperationMode === 'improvement'
    ? deriveImprovementIntent(state)
    : { summary: '', signals: [] };
  const previousFailedPaths = Array.from(new Set(
    state.appliedEdits
      .filter((edit) => edit.status === 'failed')
      .map((edit) => String(edit.path || '').trim())
      .filter(Boolean),
  ));

  const notes = [
    `Autonomous lane: ${autonomousOperationMode}`,
    `Repair intent: ${repairIntent.summary}`,
    ...repairIntent.signals.map((signal) => `Repair signal: ${signal}`),
  ];
  if (previousFailedPaths.length > 0) {
    notes.push(`Previous failed autonomous edit targets: ${previousFailedPaths.join(', ')}`);
  }
  if (improvementIntent.summary.trim()) {
    notes.push(`Improvement intent: ${improvementIntent.summary}`);
  }
  notes.push(...improvementIntent.signals.map((signal) => `Improvement signal: ${signal}`));

  return {
    autonomousOperationMode,
    repairIntentSummary: repairIntent.summary,
    repairSignals: repairIntent.signals,
    improvementIntentSummary: improvementIntent.summary,
    improvementSignals: improvementIntent.signals,
    repairStatus: state.autonomousEditEnabled && autonomousOperationMode === 'repair' ? 'planned' : 'not-needed',
    repairDecisionReason: '',
    repairPromotedPaths: [],
    repairRollbackPaths: [],
    repairSmokeJobs: [],
    repairSmokeResults: [],
    postRepairValidationJobs: [],
    postRepairValidationResults: [],
    postRepairValidationStatus: 'not-needed',
    experimentalRestartStatus: 'not-needed',
    experimentalRestartReason: '',
    repairSessionManifest: null,
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

async function autonomousEditPlannerNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!state.autonomousEditEnabled) {
    return {
      proposedEdits: [],
      appliedEdits: [],
      autonomousEditNotes: [],
      repairStatus: 'not-needed',
    };
  }

  const effectiveScopes = getEffectiveScopes(state);
  if (effectiveScopes.includes('research-scout')) {
    const notes = [
      'Research scout lane: web research suggestions only; autonomous code edits are intentionally disabled for this lane.',
    ];
    return {
      autonomousOperationMode: 'improvement',
      proposedEdits: [],
      appliedEdits: [],
      autonomousEditNotes: notes,
      autonomousEditReviewDecision: 'approved',
      autonomousEditReviewReason: 'Research scout suggestions do not apply code edits.',
      repairStatus: 'not-needed',
      repairDecisionReason: 'Research scout lane contributes suggestions and semantic-memory notes only.',
      repairPromotedPaths: [],
      repairRollbackPaths: [],
      repairSmokeJobs: [],
      repairSmokeResults: [],
      postRepairValidationJobs: [],
      postRepairValidationResults: [],
      postRepairValidationStatus: 'not-needed',
      experimentalRestartStatus: 'not-needed',
      experimentalRestartReason: '',
      repairSessionManifest: null,
      repairNotes: appendUniqueNotes(state.repairNotes, notes),
      plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
    };
  }
  const surfaceBrowserBlockingReason = getSurfaceBrowserBlockingReason(state);
  if (surfaceBrowserBlockingReason) {
    const notes = [
      surfaceBrowserBlockingReason,
      'Autonomous edit planner deferred this browser-visible lane until a reachable surface can be inspected with Playwright.',
    ];
    return {
      autonomousOperationMode: 'improvement',
      proposedEdits: [],
      appliedEdits: [],
      autonomousEditNotes: notes,
      autonomousEditReviewDecision: 'approved',
      autonomousEditReviewReason: surfaceBrowserBlockingReason,
      repairStatus: 'not-needed',
      repairDecisionReason: surfaceBrowserBlockingReason,
      repairPromotedPaths: [],
      repairRollbackPaths: [],
      repairSmokeJobs: [],
      repairSmokeResults: [],
      postRepairValidationJobs: [],
      postRepairValidationResults: [],
      postRepairValidationStatus: 'not-needed',
      experimentalRestartStatus: 'not-needed',
      experimentalRestartReason: '',
      repairSessionManifest: null,
      repairNotes: appendUniqueNotes(state.repairNotes, notes),
      plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
      healthClass: 'waiting_evidence',
      evidenceStatus: 'missing',
      validationRequired: true,
      deferReason: surfaceBrowserBlockingReason,
    };
  }
  const failedEditAnchorHints = buildFailedAutonomousEditAnchorHints(state);
  const recentFailedEdits = buildRecentFailedAutonomousEditsPayload(state);
  const candidateFiles = readAutonomousEditContext(
    state.repoRoot,
    effectiveScopes,
    state.editAllowlist,
    state.editDenylist,
    {
      preferredAnchorsByPath: failedEditAnchorHints,
    },
  );
  const failedRefreshContexts = buildFailedAutonomousEditRefreshContexts(state, failedEditAnchorHints);
  const failedPaths = new Set(Object.keys(failedEditAnchorHints));
  const compileShapeFailedPaths = collectRecentCompileShapeFailedPaths(state);
  const apiRoutingGeminiValidationPivot = shouldPivotApiRoutingAwayFromGeminiValidation(state);
  const currentThreadId = String(state.threadId || '').trim();
  const autonomousSkillBundle = resolveAutonomousSkillBundle({
    effectiveScopes,
    goal: state.goal,
    repairSignals: state.repairSignals,
    improvementSignals: state.improvementSignals,
    autonomousContractPaths: state.autonomousContractPaths,
  });
  const skillReferencedCandidatePaths = new Set(
    [...autonomousSkillBundle.alwaysLoaded, ...autonomousSkillBundle.loaded]
      .flatMap((skill) => [...skill.references, ...(skill.contract?.preferredPaths || [])])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean),
  );
  const localhostApiRefusalSignal = [...state.repairSignals, ...state.improvementSignals].some((signal) => {
    const normalized = String(signal || '').toLowerCase();
    return normalized.includes('apps/api/logs/provider-unique-errors.jsonl')
      && normalized.includes('http://localhost:3101/v1/responses')
      && normalized.includes('econnrefused');
  });
  const localhostTouchedPathSet = [
    ...new Set([
      ...candidateFiles.map((file) => String(file?.path || '').trim()).filter(Boolean),
      'apps/langgraph-control-plane/src/workflow.ts',
      ...Array.from(failedPaths).map((entry) => String(entry || '').trim()).filter(Boolean),
    ]),
  ];
  const localhostTouchedPathSummary = localhostTouchedPathSet.length
    ? localhostTouchedPathSet.join(', ')
    : 'apps/langgraph-control-plane/src/workflow.ts';
  const localhostApiNoRunDeferReason = localhostApiRefusalSignal
    ? `Thread ${currentThreadId || 'current control-plane thread'} is carrying a bounded control-plane observability/workflow-hardening change only. The active goal remains to continuously monitor, fix, and improve AnyGPT with bounded safe control-plane changes, while the active repair signal is still apps/api/logs/provider-unique-errors.jsonl reporting openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses. The direct fix remains blocked out of scope in the apps/api provider/runtime routing subsystem because the localhost API target is not serving, and retrying the same openai sendMessage combination is unlikely to help until that blocked apps/api runtime is serving again. Treat apps/api/logs/provider-unique-errors.jsonl as monitoring evidence for this blocked subsystem, not proof that the underlying localhost apps/api issue was repaired from control-plane scope. This bounded control-plane iteration is touching or considering the following control-plane path set: ${localhostTouchedPathSummary}. Startup logs that register graphs, start workers, or report server-running before flushing to persistent storage and exiting are partial readiness evidence only, not completed validation. Pending-only LangSmith visibility for this thread, sibling-thread pending runs, pending same-thread runs without completion, or completed runs from other threads are partial observability only and do not satisfy this iteration for thread ${currentThreadId || 'current control-plane thread'}. Cross-thread LangSmith activity does not satisfy validation for this control-plane iteration, and sibling-thread pending-run growth should be surfaced as shared observability/readiness noise rather than treated as successful validation for this control-plane thread. No fresh same-thread LangSmith control-plane run/trace with explicit goal context or fresh same-thread control-plane smoke/typecheck result has been emitted for this bounded change yet, so do not treat governance pass, evaluation pass, startup readiness hints, pending-only visibility, or cross-thread activity as a substitute for validation. Preserve this clear operator-facing no-run defer reason unless and until this same thread emits at least one fresh LangSmith control-plane run/trace with explicit goal context and the touched control-plane path set passes smoke/typecheck; otherwise keep the defer reason visible instead of implying successful validation from partial readiness or partial observability alone.`
    : '';
  const candidatePrioritySources = [
    ...(localhostApiRefusalSignal
      ? [
        'Active repair signal is a scope-blocked localhost API refusal in apps/api/logs/provider-unique-errors.jsonl: openai sendMessage ECONNREFUSED against http://localhost:3101/v1/responses. Treat the blocked subsystem as apps/api provider/runtime routing, avoid implying that apps/api was fixed from control-plane scope, and prefer one bounded control-plane observability, workflow-hardening, or explicit no-run defer-reason improvement. Retrying the same openai sendMessage combination is unlikely to help until the localhost API target is serving again.',
        `Operator-facing no-run defer reason for this same-thread control-plane iteration: ${localhostApiNoRunDeferReason}`,
      ]
      : []),
    ...(apiRoutingGeminiValidationPivot
      ? ['Recent api-routing compile-shape failure in apps/api/modules/geminiMediaValidation.ts: pivot the next bounded repair toward apps/api/providers/handler.ts or apps/api/modules/openaiRouteSupport.ts instead of retrying the stale Gemini validation replace block unchanged.']
      : []),
    ...autonomousSkillBundle.loaded.map((skill) => `${skill.id}: ${skill.description} References: ${skill.references.join(', ')}`),
    `Current control-plane thread priority: emit or surface at least one fresh LangSmith control-plane run/trace for thread ${currentThreadId || 'unknown'} with explicit goal context for this iteration before proposing broader improvement work; if no run can be emitted, preserve a clear operator-facing defer reason. Treat a missing fresh run for the current iteration as an observability gap, not by itself a deploy or rollback trigger. Do not count recent LangSmith runs from other threads or scopes as satisfying this iteration's control-plane observability success condition. When concurrent pending runs exist in other threads, require correlation by exact thread id before treating any sampled run as evidence for this iteration, and prefer the same-thread fresh run or an explicit no-run defer reason over broad speculative changes. If sampled recent runs are only from other threads or scopes, explicitly say that observability for thread ${currentThreadId || 'unknown'} is still unconfirmed and require either one fresh same-thread control-plane run/trace with explicit goal context or a clear no-run defer reason before calling the iteration successful. If sampled recent runs already include same-thread control-plane entries for ${currentThreadId || 'unknown'} but they are still pending, treat that as partial observability evidence rather than as zero-run health; explicitly surface that a same-thread run exists but has not completed yet, avoid claiming success from it, and preserve the next validation requirement as either one completed fresh same-thread control-plane run/trace with explicit goal context and passed smoke/typecheck or a clear operator-facing defer reason explaining why completion was not observed. If recent sampled runs are mostly from other threads or scopes while one or more same-thread control-plane runs for ${currentThreadId || 'unknown'} are pending or only indirectly visible in logs/embedded error context, explicitly call that out as same-thread pending-run visibility rather than summarizing the situation as zero recent runs; require the summary or defer reason to name that pending-run state so operators can distinguish observability lag from true no-run absence. When no fresh completed same-thread control-plane run is visible for ${currentThreadId || 'unknown'} in the current iteration, explicitly classify that as a same-thread control-plane observability gap or pending-run visibility gap, not as proof of runtime failure and not as a deploy/rollback trigger by itself; require the summary to mention any available readiness evidence such as graph registration, worker startup, server-running logs, LangSmith metadata wiring, prompt fallback telemetry, or pending-run visibility before choosing between a bounded edit and a no-run defer reason. When recent LangSmith samples are available, explicitly count how many sampled runs belong to the current thread ${currentThreadId || 'unknown'} and how many of those are pending versus completed; if sampled runs are mostly from other threads or same-thread runs are still pending, require the summary or defer reason to say that directly instead of collapsing the situation into a generic zero-run statement. When recent LangSmith samples are available, require the summary or defer reason to include a compact same-thread observability line in plain language for ${currentThreadId || 'unknown'} in the form same-thread sampled runs=<n>, completed=<n>, pending=<n>, other-thread sampled runs=<n>; if completed is 0, explicitly classify the situation as a same-thread observability gap or pending-run visibility gap rather than proof of runtime failure. When same-thread sampled runs are 0 for ${currentThreadId || 'unknown'}, require the summary and any no-op/defer outcome to say that older runs or runs from other threads do not satisfy this iteration's validation evidence, and require an explicit operator-facing no-run defer reason instead of implying success from cross-thread activity alone. When same-thread sampled runs are present but pending > 0 or completed is still 0 for ${currentThreadId || 'unknown'}, require the summary or defer reason to explicitly classify that state as partial observability evidence with pending-run visibility for the current thread, name the exact pending thread ${currentThreadId || 'unknown'}, include the compact same-thread observability line, and preserve a clear operator-facing no-run defer reason instead of claiming validation success from pending activity alone. When same-thread sampled runs are 0 for ${currentThreadId || 'unknown'} but other-thread sampled runs are present, require the summary and each edit reason to explicitly say that cross-thread activity does not satisfy this iteration's validation evidence for the current control-plane thread and to preserve a clear operator-facing no-run defer reason instead of implying success. When same-thread sampled runs are still 0 for ${currentThreadId || 'unknown'} but pending same-thread activity is visible, require the summary and each edit reason to name that exact current thread as partial observability evidence only, not completed validation, and to preserve a clear operator-facing no-run defer reason until at least one fresh same-thread LangSmith control-plane run/trace is completed with explicit goal context. If recent LangSmith activity is mostly from sibling or unrelated threads while ${currentThreadId || 'unknown'} still has no fresh completed control-plane run, require the summary and each edit reason to explicitly say that cross-thread activity does not satisfy validation for ${currentThreadId || 'unknown'} and to keep the same-thread no-run defer reason. When startup evidence shows graph registration, worker startup, or server-running logs but also shows early exit or flushing to persistent storage, require the summary to classify that as partial readiness evidence rather than completed validation and to keep the same-thread no-run defer requirement unless a fresh same-thread LangSmith control-plane run/trace is also present. When LangSmith feedback includes contains_goal_context=0 or repair_smoke_passed=0, restate the active user goal in plain language in the summary and in every edit reason, and do not treat a fresh run as sufficient unless that same-thread run/trace clearly carries the current control-plane goal context for this iteration. Before any experimental mutation, require a quick readiness check that the control-plane runtime is actually serving and that pending concurrent runners are not creating misleading health signals or shared-workspace contention; use known control-plane serving evidence such as graph registration, worker startup, server-running logs, or experimental API health when available. If logs also show the runtime exiting or flushing to persistent storage soon after startup, require the summary to classify that as partial readiness evidence rather than completed validation. If readiness is unclear, prefer a bounded operator-facing no-run defer reason over speculative mutation. When the current control-plane thread has no fresh completed LangSmith run/trace but sampled LangSmith data shows pending same-thread visibility, require the summary and each edit reason to name that exact pending thread as partial observability evidence only, not completed validation, and to include the compact same-thread observability line when it is available. When that pending same-thread visibility appears together with startup logs that show graph registration, worker startup, or server-running evidence followed by an immediate flush, exit, or shutdown, require the summary and each edit reason to explicitly classify the state as combined partial observability plus partial readiness only, to include the compact same-thread observability line when it is available, and to preserve a clear operator-facing no-run defer reason for the current thread instead of claiming successful validation. During quiet control-plane improvement iterations where governance is passing, no code-local repair target is present, and no fresh same-thread LangSmith control-plane run/trace exists yet for the current thread, prefer one smallest bounded README-only or operator-facing observability/workflow-hardening edit over speculative source mutations, and require the summary and each edit reason to say that this is a smoke-safer control-plane improvement chosen because same-thread validation is still missing. When the active repair signal is scope-blocked apps/api provider/runtime routing drift such as apps/api/logs/provider-unique-errors.jsonl showing openai sendMessage ECONNREFUSED for http://localhost:3101/v1/responses, and current-thread evidence is only partial readiness or partial observability, prefer a README-only or other operator-facing defer-reason improvement before broader source mutations unless a clear control-plane-local defect is visible in the candidate files. When that localhost ECONNREFUSED signal is active and apps/langgraph-control-plane/README.md is in the allowed candidate set, prefer that README-only/operator-facing defer-reason path first because it is the smoke-safer bounded control-plane improvement under missing same-thread validation. When that localhost ECONNREFUSED signal is active for thread 8bd76091-7a92-4314-abf8-926521f7bacf:control-plane and no fresh same-thread LangSmith control-plane run/trace with explicit goal context plus passed smoke/typecheck exists yet, require the summary and each edit reason to explicitly say the blocked subsystem is apps/api provider/runtime routing, that the direct fix is out of scope for this bounded control-plane iteration, that startup logs with graph registration, worker startup, or server-running followed by flush/exit are partial readiness evidence only, and that pending-only or cross-thread LangSmith activity is partial observability only. In that state, prefer the smallest README-only or operator-facing defer-reason improvement in allowed control-plane files over source-code mutations unless a clear control-plane-local defect is visible.`,
    currentThreadId
      ? `Current-thread observability guard: when summarizing recent LangSmith activity for this control-plane iteration, explicitly prefer runs whose threadId exactly matches ${currentThreadId}. If only other-thread or other-scope runs are fresh, record that as supporting context only and preserve a no-run defer reason for this control-plane thread instead of claiming observability success.`
      : 'Current-thread observability guard: if the control-plane threadId is unavailable, do not infer observability success from unrelated recent LangSmith runs; preserve a clear operator-facing defer reason explaining that no current-thread run identity was available for validation.',
    `When LangSmith recent runs include many pending entries from other threads or scopes, treat that as shared observability noise rather than proof that the current control-plane thread already produced a fresh validating run. Prefer notes, summaries, and bounded edits that explicitly distinguish the current thread ${state.threadId || 'unknown'} from cross-thread pending activity, and do not count other-thread pending runs as satisfying this iteration's validation target.`,
    `Observability success condition for this control-plane iteration: confirm at least one fresh LangSmith control-plane run/trace tied to thread ${state.threadId || 'unknown'} and the active goal, or preserve a clear no-run defer reason explaining why no run was emitted. Zero fresh runs is a monitoring gap, not by itself a deploy or rollback trigger.`,
    `Before proposing broader control-plane improvements, prefer one bounded step that either increases the chance of producing a fresh LangSmith control-plane run/trace for thread ${state.threadId || 'unknown'} or makes the no-run defer reason explicit to operators; do not treat upstream/provider-bound OpenAI or OpenRouter failures outside control-plane scope as a local control-plane regression by default.`,
    `Thread-local observability guard: when sampled LangSmith runs are healthy overall but mostly belong to other threads, prioritize a bounded control-plane change that increases the chance of producing or surfacing a fresh run/trace for the current thread ${state.threadId || 'unknown'} before broader cleanup work.`,
    `When recent LangSmith activity includes runs from multiple threads, treat only runs whose threadId exactly matches ${state.threadId || 'unknown'} or ends with :control-plane as primary observability evidence for this control-plane iteration; do not let healthy non-control-plane thread runs satisfy the fresh-run success condition for the active control-plane goal.`,
    `When recent signals are otherwise healthy but provider logs show repeated OpenAI/OpenRouter 401, 402, quota, invalid_api_key, or 500 churn outside control-plane scope, classify that as upstream/provider-bound drift blocked in apps/api provider routing/probing; repeating the same provider-method combination is unlikely to help immediately, so prefer bounded control-plane observability, prioritization, cooldown, or explicit defer-reason improvements.`,
    ...state.repairSignals,
    ...state.improvementSignals,
    ...state.plannerNotes,
    ...state.buildAgentInsights,
    ...state.qualityAgentInsights,
    ...state.deployAgentInsights,
    'Control-plane observability success condition for this iteration: confirm at least one fresh LangSmith control-plane run/trace with goal context and a passed smoke/typecheck result, or preserve a clear operator-facing defer reason explaining why no run was emitted.',
  ].slice(-40);
  const candidatePriorityPathPattern = /(?:apps\/[A-Za-z0-9._/-]+|[A-Za-z0-9._/-]+)(?:\.(?:ts|js|json|md|mts|service|jsonl|log|txt)|\/(?:package\.json|langgraph\.json|README\.md)|\/(?:governance-profiles\.json))/g;
  const referencedCandidatePaths = new Set<string>();
  for (const sourceText of candidatePrioritySources) {
    for (const match of String(sourceText || '').match(candidatePriorityPathPattern) || []) {
      referencedCandidatePaths.add(match);
    }
  }
  const signalPrioritySources = [
    ...state.repairSignals,
    ...state.improvementSignals,
  ].slice(-20);
  const signalReferencedCandidatePaths = new Set<string>();
  for (const sourceText of signalPrioritySources) {
    for (const match of String(sourceText || '').match(/apps\/[A-Za-z0-9._/-]+\.(?:ts|js|json|md|mts|service)/g) || []) {
      signalReferencedCandidatePaths.add(match);
    }
  }

  const prioritizedCandidateFiles = [...candidateFiles]
    .sort((left, right) => {
      const leftSignalReferenced = signalReferencedCandidatePaths.has(left.path);
      const rightSignalReferenced = signalReferencedCandidatePaths.has(right.path);
      if (leftSignalReferenced !== rightSignalReferenced) {
        return leftSignalReferenced ? -1 : 1;
      }

      const leftReferenced = referencedCandidatePaths.has(left.path);
      const rightReferenced = referencedCandidatePaths.has(right.path);
      if (leftReferenced !== rightReferenced) {
        return leftReferenced ? -1 : 1;
      }
      const leftSkillReferenced = skillReferencedCandidatePaths.has(left.path);
      const rightSkillReferenced = skillReferencedCandidatePaths.has(right.path);
      if (leftSkillReferenced !== rightSkillReferenced) {
        return leftSkillReferenced ? -1 : 1;
      }
      const rank = (candidatePath: string): number => {
        if (apiRoutingGeminiValidationPivot && candidatePath === 'apps/api/providers/handler.ts') {
          return -20;
        }
        if (failedPaths.has(candidatePath)) {
          if (compileShapeFailedPaths.has(candidatePath)) {
            if (apiRoutingGeminiValidationPivot && candidatePath === 'apps/api/modules/geminiMediaValidation.ts') {
              return 40;
            }
            return 20;
          }
          return -10;
        }
        if (signalReferencedCandidatePaths.has(candidatePath)) return -2;
        if (referencedCandidatePaths.has(candidatePath)) return 0;
        const hotPathIndex = [
          'apps/langgraph-control-plane/src/workflow.ts',
          'apps/langgraph-control-plane/src/index.ts',
          'apps/api/providers/handler.ts',
          'apps/api/providers/openrouter.ts',
          'apps/api/providers/openai.ts',
          'apps/api/providers/gemini.ts',
          'apps/api/modules/requestQueue.ts',
          'apps/api/modules/openaiProviderSelection.ts',
          'apps/api/modules/openaiRequestSupport.ts',
          'apps/api/modules/openaiRouteUtils.ts',
          'apps/api/routes/openai.ts',
          'apps/langgraph-control-plane/src/workflow.ts',
          'apps/langgraph-control-plane/src/index.ts',
        ].indexOf(candidatePath);
        if (hotPathIndex >= 0) return 10 + hotPathIndex;
        if (candidatePath.startsWith('apps/api/')) return 100;
        return 200;
      };
      return rank(left.path) - rank(right.path);
    })
    .slice(0, AI_CODE_EDIT_CANDIDATE_FILE_LIMIT)
    .map((file) => ({
      ...file,
      content: truncateTextMiddle(
        file.content,
        failedPaths.has(file.path)
          ? Math.max(AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS * 2, 3_200)
          : AI_CODE_EDIT_CANDIDATE_FILE_MAX_CHARS,
      ),
    }));
  const existingCandidatePathSet = new Set(prioritizedCandidateFiles.map((file) => file.path));

  if (candidateFiles.length === 0) {
    const notes = ['AI autonomous edit agent: no allowed candidate files were available for autonomous code changes.'];
    return {
      proposedEdits: [],
      appliedEdits: [],
      autonomousEditNotes: notes,
      repairStatus: 'not-needed',
      plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
    };
  }

  const runtimeOverride = loadRuntimeAutonomousEditPlanOverride(state);
  const operationMode: AutonomousOperationMode = state.autonomousOperationMode === 'repair' || state.autonomousOperationMode === 'improvement'
    ? state.autonomousOperationMode
    : (hasActionableRepairSignals(state.repairSignals) ? 'repair' : 'improvement');
  const plannerWorkloads = buildAutonomousEditAgentWorkloads(state, operationMode, prioritizedCandidateFiles, failedPaths);
  const plannerStrategy = runtimeOverride.plan
    ? 'runtime-override'
    : (plannerWorkloads.length > 1 ? 'parallel-focus-fanout' : 'single-primary-agent');
  const plannerFocuses = runtimeOverride.plan
    ? [`runtime-override: ${runtimeOverride.source || 'inline plan'}`]
    : plannerWorkloads.map((workload) => `${workload.label}: ${workload.focus}`);
  const aiBackpressureActive = hasRecentAiBackendBackpressure(state);
  const aggressiveExperimentalBias = shouldUseAggressiveAutonomousPlanning(state);
  const sharedAiPayload = buildSharedAiAgentPayload({
    ...state,
    autonomousPlannerAgentCount: runtimeOverride.plan ? 1 : plannerWorkloads.length,
    autonomousPlannerFocuses: plannerFocuses,
    autonomousPlannerStrategy: plannerStrategy,
  } as ControlPlaneState);
  const aiEditPlans = runtimeOverride.plan
    ? [{
        enabled: false,
        model: state.aiAgentModel,
        backend: runtimeOverride.source || 'runtime override',
        summary: runtimeOverride.plan.summary,
        edits: runtimeOverride.plan.edits,
        agentLabel: 'runtime-override',
        agentFocus: runtimeOverride.source || 'runtime override',
        candidatePaths: Array.from(existingCandidatePathSet).slice(0, AI_CODE_EDIT_CANDIDATE_PATH_LIMIT),
      }]
    : await Promise.all(
        plannerWorkloads.map((workload) => callAiCodeEditAgent(state, {
          threadId: state.threadId,
          goal: state.goal,
          scopes: effectiveScopes,
          allowlist: state.editAllowlist,
          denylist: state.editDenylist,
          maxEditActions: state.maxEditActions,
          currentPlannerNotes: compactStringArrayForAi(state.plannerNotes, AI_AGENT_CONTEXT_NOTE_LIMIT),
          operationMode,
          agentLabel: workload.label,
          agentFocus: workload.focus,
          aggressiveExperimentalBias,
          repairIntent: {
            summary: truncateTextMiddle(state.repairIntentSummary, AI_AGENT_PAYLOAD_STRING_MAX_CHARS),
            signals: compactStringArrayForAi(state.repairSignals, AI_AGENT_SIGNAL_PAYLOAD_LIMIT),
            actionableSignalCount: countActionableRepairSignals(state.repairSignals),
            externalSignalCount: countExternallyCausedRepairSignals(state.repairSignals),
          },
          improvementIntent: {
            summary: truncateTextMiddle(state.improvementIntentSummary, AI_AGENT_PAYLOAD_STRING_MAX_CHARS),
            signals: compactStringArrayForAi(state.improvementSignals, AI_AGENT_SIGNAL_PAYLOAD_LIMIT),
          },
          autonomousContract: {
            summary: truncateTextMiddle(state.autonomousContractSummary, AI_AGENT_PAYLOAD_STRING_MAX_CHARS),
            checks: compactStringArrayForAi(state.autonomousContractChecks, 6),
            paths: state.autonomousContractPaths.slice(0, 8),
          },
          previousRepairStatus: state.repairStatus,
          previousRepairDecisionReason: truncateTextMiddle(state.repairDecisionReason, AI_AGENT_PAYLOAD_STRING_MAX_CHARS),
          previousAutonomousEditNotes: compactStringArrayForAi(
            state.autonomousEditNotes.filter((note) => /autonomous edit failed|replace target text was not found|matched \d+ times|provider-bound|blocked for this iteration|introduced unused local symbols|declared but its value is never read|duplicate package\.json scripts/i.test(note)),
            12,
          ),
          previousFailedEdits: recentFailedEdits,
          previousFailedEditAnchorHints: failedEditAnchorHints,
          failedEditRefreshContexts: failedRefreshContexts,
          autonomousCandidatePaths: workload.candidatePaths,
          autonomousCandidateFiles: workload.candidateFiles,
          sharedPayload: sharedAiPayload,
        })),
      );

  const notes: string[] = [];
  notes.push(`Autonomous edit planner strategy: ${plannerStrategy} (${runtimeOverride.plan ? 1 : plannerWorkloads.length} agent(s)).`);
  if (aiBackpressureActive) {
    notes.push('AI backend backpressure is active; autonomous edit planning was throttled to one focused agent for this lane.');
  }
  notes.push(...plannerFocuses.map((focus) => `Autonomous edit planner focus: ${focus}`));
  if (runtimeOverride.plan) {
    notes.push(`Runtime autonomous edit plan override loaded from ${runtimeOverride.source}.`);
  }
  if (runtimeOverride.error) {
    notes.push(`Runtime autonomous edit plan override invalid: ${runtimeOverride.error}`);
  }
  for (const aiEditPlan of aiEditPlans) {
    if (aiEditPlan.summary?.trim()) {
      notes.push(`AI autonomous ${operationMode} agent ${aiEditPlan.agentLabel || 'primary'}: ${aiEditPlan.summary.trim()}`);
    }
    if (aiEditPlan.error) {
      notes.push(`AI autonomous ${operationMode} agent ${aiEditPlan.agentLabel || 'primary'} unavailable: ${aiEditPlan.error}`);
    }
  }

  const dedupedPlannedEdits: AutonomousEditAction[] = [];
  const seenEditPaths = new Set<string>();
  const appendAcceptedEdits = (
    edits: AutonomousEditAction[],
    candidatePathSet: Set<string>,
    label: string,
  ): void => {
    const filteredPlan = filterInvalidAutonomousEditProposals(state, edits, candidatePathSet);
    notes.push(...filteredPlan.notes.map((note) => `${label}: ${note}`));
    for (const edit of filteredPlan.accepted) {
      const normalizedEditPath = String(edit?.path || '').trim();
      if (!normalizedEditPath) continue;
      if (isRepeatedFailedEditProposal(edit, recentFailedEdits)) {
        notes.push(`${label}: Skipped repeated failed autonomous edit proposal for ${normalizedEditPath}; waiting for a refreshed block proposal.`);
        continue;
      }
      if (seenEditPaths.has(normalizedEditPath)) continue;
      seenEditPaths.add(normalizedEditPath);
      dedupedPlannedEdits.push(edit);
      if (dedupedPlannedEdits.length >= state.maxEditActions) break;
    }
  };

  for (const aiEditPlan of aiEditPlans) {
    appendAcceptedEdits(
      aiEditPlan.edits,
      new Set((aiEditPlan.candidatePaths || []).length > 0 ? aiEditPlan.candidatePaths : Array.from(existingCandidatePathSet)),
      `AI autonomous ${operationMode} agent ${aiEditPlan.agentLabel || 'primary'}`,
    );
    if (dedupedPlannedEdits.length >= state.maxEditActions) break;
  }

  const deterministicFallbackPlan = !runtimeOverride.plan && dedupedPlannedEdits.length === 0
    ? buildDeterministicAutonomousFallbackPlan(state, operationMode, candidateFiles)
    : null;
  if (deterministicFallbackPlan) {
    notes.push(`Deterministic autonomous ${operationMode} fallback: ${deterministicFallbackPlan.summary}`);
    appendAcceptedEdits(
      deterministicFallbackPlan.edits,
      existingCandidatePathSet,
      `Deterministic autonomous ${operationMode} fallback`,
    );
  }

  const proposedEdits = dedupedPlannedEdits;
  for (const edit of proposedEdits) {
    notes.push(`AI autonomous edit proposal: ${edit.type} ${edit.path} — ${edit.reason}`);
  }
  if (proposedEdits.length === 0 && aiEditPlans.some((plan) => !plan.error)) {
    notes.push(
      operationMode === 'repair' && countActionableRepairSignals(state.repairSignals) > 0
        ? `No bounded repair edit was proposed despite ${countActionableRepairSignals(state.repairSignals)} actionable repair signal(s).`
        : 'No bounded improvement edit was proposed for this iteration.',
    );
  }

  return {
    autonomousOperationMode: operationMode,
    proposedEdits,
    appliedEdits: [],
    autonomousEditNotes: notes,
    autonomousEditReviewDecision: 'pending',
    autonomousEditReviewReason: '',
    autonomousPlannerAgentCount: runtimeOverride.plan ? 1 : plannerWorkloads.length,
    autonomousPlannerFocuses: plannerFocuses,
    autonomousPlannerStrategy: plannerStrategy,
    repairStatus: proposedEdits.length > 0 ? 'planned' : (operationMode === 'repair' ? 'idle' : 'not-needed'),
    repairDecisionReason: '',
    repairPromotedPaths: [],
    repairRollbackPaths: [],
    repairSmokeJobs: [],
    repairSmokeResults: [],
    postRepairValidationJobs: [],
    postRepairValidationResults: [],
    postRepairValidationStatus: 'not-needed',
    experimentalRestartStatus: 'not-needed',
    experimentalRestartReason: '',
    repairSessionManifest: null,
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
    aiAgentEnabled: state.aiAgentEnabled || aiEditPlans.some((plan) => plan.enabled),
    aiAgentBackend: state.aiAgentBackend || aiEditPlans.find((plan) => plan.backend)?.backend || '',
    aiAgentModel: state.aiAgentModel || aiEditPlans.find((plan) => plan.model)?.model || '',
  };
}

async function approvalGateNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const pendingApprovals = buildApprovalRequests(state);

  if (pendingApprovals.length === 0) {
    return {
      pendingApprovals,
      approvalGranted: true,
      approvalMessage: 'No risky operations require approval.',
    };
  }

  if (state.approvalMode === 'auto') {
    return {
      pendingApprovals,
      approvalGranted: true,
      approvalMessage: `Auto-approved ${pendingApprovals.length} risky operation(s).`,
    };
  }

  const decision = interrupt({
    type: 'approval_required',
    thread_id: state.threadId,
    message: `Approval is required for ${pendingApprovals.length} risky operation(s). Resume with \"approve\" to continue or \"deny\" to stop.`,
    operations: pendingApprovals,
  });
  const resolved = resolveApprovalDecision(decision);

  return {
    pendingApprovals,
    approvalGranted: resolved.approved,
    approvalMessage: resolved.message,
  };
}

function buildAutonomousEditReviewRejectionPatch(
  state: ControlPlaneState,
  reason: string,
  options?: { proposedEdits?: AutonomousEditAction[] },
): Partial<ControlPlaneState> {
  return {
    ...(options && 'proposedEdits' in options ? { proposedEdits: options.proposedEdits || [] } : {}),
    autonomousEditReviewDecision: 'rejected',
    autonomousEditReviewReason: reason,
    autonomousEditNotes: appendUniqueNotes(state.autonomousEditNotes, [reason]),
    plannerNotes: appendUniqueNotes(state.plannerNotes, [reason]),
    repairStatus: state.autonomousOperationMode === 'repair' ? 'idle' : 'not-needed',
    repairDecisionReason: reason,
  };
}

async function reviewAutonomousEditsNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!state.autonomousEditEnabled || state.proposedEdits.length === 0) {
    return {
      autonomousEditReviewDecision: 'approved',
      autonomousEditReviewReason: state.autonomousEditEnabled ? 'No autonomous edits required review.' : 'Autonomous edits are disabled.',
    };
  }

  const touchedPaths = Array.from(new Set(state.proposedEdits.map((edit) => String(edit.path || '').trim()).filter(Boolean)));
  const providerPathTouches = touchedPaths.filter((candidatePath) => candidatePath.startsWith('apps/api/providers/'));
  const nonControlPlaneTouches = touchedPaths.filter((candidatePath) => !candidatePath.startsWith('apps/langgraph-control-plane/'));
  const contractPaths = state.autonomousContractPaths
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  const offContractTouches = contractPaths.length > 0
    ? touchedPaths.filter((candidatePath) => !contractPaths.includes(candidatePath))
    : [];
  const providerBoundSignals = shouldAvoidProviderPathAutonomousEdits(state.repairSignals);
  const restrictToControlPlane = shouldRestrictAutonomousEditsToControlPlane(state);
  const recentFailures = Math.max(
    state.recentRepairValidationFailureCount,
    state.repairSmokeResults.filter((job) => job.status === 'failed').length
      + state.postRepairValidationResults.filter((job) => job.status === 'failed').length,
  );
  const isBroadPlan = touchedPaths.length > 2 || state.proposedEdits.length > 2;
  const proposalReasonByPath = new Map<string, string>();
  for (const edit of state.proposedEdits) {
    const normalizedPath = String(edit.path || '').trim();
    const normalizedReason = String(edit.reason || '').trim();
    if (!normalizedPath || !normalizedReason) continue;
    const reasonParts = [proposalReasonByPath.get(normalizedPath), normalizedReason]
      .filter((value): value is string => Boolean(value));
    proposalReasonByPath.set(normalizedPath, reasonParts.join(' | '));
  }
  const allowScopedProviderPathEdits = shouldAllowScopedProviderPathAutonomousEdits(
    state,
    touchedPaths,
    proposalReasonByPath,
  );
  const weakestPathFitScore = touchedPaths.length > 0
    ? Math.min(...touchedPaths.map((candidatePath) => scoreAutonomousEditPathFit(state, candidatePath, proposalReasonByPath.get(candidatePath) || '')))
    : 0;

  if (providerBoundSignals && !allowScopedProviderPathEdits && providerPathTouches.length > 0) {
    const reason = `Rejected autonomous edit batch before apply: provider-bound repair signals are active, so provider-file edits are not allowed (${providerPathTouches.join(', ')}).`;
    return buildAutonomousEditReviewRejectionPatch(state, reason, {
      proposedEdits: state.proposedEdits.filter((edit) => !String(edit.path || '').trim().startsWith('apps/api/providers/')),
    });
  }

  if (restrictToControlPlane && nonControlPlaneTouches.length > 0) {
    const reason = `Rejected autonomous edit batch before apply: current signals are externally caused or repetitive, so only control-plane edits are allowed for this iteration.`;
    return buildAutonomousEditReviewRejectionPatch(state, reason);
  }

  if (recentFailures > 0 && isBroadPlan) {
    const reason = `Rejected autonomous edit batch before apply: recent repair validation failures are present, so only narrowly scoped follow-up edits are allowed.`;
    return buildAutonomousEditReviewRejectionPatch(state, reason);
  }

  if (offContractTouches.length > 0) {
    const reason = `Rejected autonomous edit batch before apply: proposed edits must stay inside the autonomous contract paths (${contractPaths.join(', ')}); off-contract paths were proposed (${offContractTouches.join(', ')}).`;
    return buildAutonomousEditReviewRejectionPatch(state, reason);
  }

  if (state.autonomousOperationMode === 'repair' && touchedPaths.length > 1 && !isTightlyCoupledAutonomousEditBatch(touchedPaths)) {
    const reason = 'Rejected autonomous edit batch before apply: repair iterations may use multiple edits only for tightly coupled file pairs.';
    return buildAutonomousEditReviewRejectionPatch(state, reason);
  }

  if (weakestPathFitScore < 2) {
    const reason = `Rejected autonomous edit batch before apply: the proposed path fit score (${weakestPathFitScore}) is too weak for the active signals, so a more clearly justified change is required.`;
    return buildAutonomousEditReviewRejectionPatch(state, reason);
  }

  const reviewPayload = {
    threadId: state.threadId,
    operationMode: state.autonomousOperationMode,
    repairSignals: state.repairSignals,
    improvementSignals: state.improvementSignals,
    touchedPaths,
    proposedEdits: state.proposedEdits,
    weakestPathFitScore,
    providerBoundSignals,
    restrictToControlPlane,
    autonomousContract: {
      summary: state.autonomousContractSummary,
      checks: state.autonomousContractChecks,
      paths: contractPaths,
    },
    recentFailures,
    existingPlannerNotes: compactStringArrayForAi(state.plannerNotes, 12),
  };

  if (state.autonomousOperationMode === 'improvement' && touchedPaths.length > 1) {
    const aiReview = await callAiAutonomousEditReviewer(state, reviewPayload);
    if (!aiReview.enabled || !aiReview.approved || aiReview.confidence === 'low') {
      const reason = aiReview.reason || 'Rejected autonomous edit batch before apply: improvement iterations must stay single-path unless a high-confidence review broadens scope.';
      return buildAutonomousEditReviewRejectionPatch(state, reason);
    }
  }

  const reason = touchedPaths.length > 0
    ? `Autonomous edit batch approved after bounded review for ${touchedPaths.join(', ')}.`
    : 'Autonomous edit batch approved after bounded review.';
  return {
    autonomousEditReviewDecision: 'approved',
    autonomousEditReviewReason: reason,
    autonomousEditNotes: appendUniqueNotes(state.autonomousEditNotes, [reason]),
  };
}

async function executePlannedMcpActions(
  state: ControlPlaneState,
  plannedActions: McpPlannedAction[],
): Promise<Partial<ControlPlaneState>> {
  if (plannedActions.length === 0) {
    return {
      executedMcpActions: state.executedMcpActions,
    };
  }

  const configsByServer = new Map(
    loadMcpServers(resolveMcpConfigPath(state)).map((server) => [server.name, server] as const),
  );
  const inspectionsByServer = new Map(
    state.mcpInspections.map((inspection) => [inspection.server, inspection] as const),
  );
  const actionsByServer = new Map<string, McpPlannedAction[]>();
  for (const action of plannedActions) {
    const bucket = actionsByServer.get(action.server) || [];
    bucket.push(action);
    actionsByServer.set(action.server, bucket);
  }

  const executedMcpActions: McpExecutedAction[] = [...state.executedMcpActions];
  const notes: string[] = [];

  for (const [serverName, actions] of actionsByServer.entries()) {
    const config = configsByServer.get(serverName);
    const inspection = inspectionsByServer.get(serverName);

    if (!config) {
      for (const action of actions) {
        executedMcpActions.push(McpExecutedActionSchema.parse({
          ...action,
          status: 'failed',
          outputSummary: `MCP server ${serverName} is not configured.`,
          outputPreview: `MCP server ${serverName} is not configured.`,
        }));
      }
      notes.push(`MCP action group ${serverName} failed: server is not configured.`);
      continue;
    }

    if (config.disabled) {
      for (const action of actions) {
        executedMcpActions.push(McpExecutedActionSchema.parse({
          ...action,
          status: 'skipped',
          outputSummary: `MCP server ${serverName} is disabled in config.`,
          outputPreview: `MCP server ${serverName} is disabled in config.`,
        }));
      }
      notes.push(`MCP action group ${serverName} skipped: server is disabled in config.`);
      continue;
    }

    if (inspection?.status !== 'connected') {
      for (const action of actions) {
        executedMcpActions.push(McpExecutedActionSchema.parse({
          ...action,
          status: 'failed',
          outputSummary: `MCP server ${serverName} is not connected.`,
          outputPreview: inspection?.message || `MCP server ${serverName} is not connected.`,
        }));
      }
      notes.push(`MCP action group ${serverName} failed: ${inspection?.message || 'server is not connected.'}`);
      continue;
    }

    try {
      await withConnectedMcpClient(
        config,
        state.repoRoot,
        `MCP action group ${serverName}`,
        async (client) => {
          for (const action of actions) {
            if (!mcpInspectionHasTool(inspection, action.tool)) {
              const message = `Tool ${action.tool} is not available on MCP server ${serverName}.`;
              executedMcpActions.push(McpExecutedActionSchema.parse({
                ...action,
                status: 'skipped',
                outputSummary: message,
                outputPreview: message,
              }));
              notes.push(`MCP action skipped: ${serverName}.${action.tool} — ${message}`);
              continue;
            }

            try {
              const result = await withTimeout(
                client.callTool({
                  name: action.tool,
                  arguments: action.arguments,
                } as any),
                MCP_ACTION_TIMEOUT_MS,
                `MCP action ${serverName}.${action.tool}`,
              );
              const summarized = summarizeMcpCallResult(result);
              const outputLinks = extractMcpResultLinks(result);
              executedMcpActions.push(McpExecutedActionSchema.parse({
                ...action,
                status: summarized.failed ? 'failed' : 'success',
                outputSummary: summarized.summary,
                outputPreview: summarized.preview,
                outputLinks,
              }));
              notes.push(`MCP action ${summarized.failed ? 'failed' : 'success'}: ${serverName}.${action.tool} — ${summarized.summary}`);
            } catch (error: any) {
              const message = redactSensitiveText(error?.message || String(error));
              executedMcpActions.push(McpExecutedActionSchema.parse({
                ...action,
                status: 'failed',
                outputSummary: truncateTextMiddle(message, 320),
                outputPreview: truncateTextMiddle(message, MCP_ACTION_OUTPUT_PREVIEW_MAX_CHARS),
              }));
              notes.push(`MCP action failed: ${serverName}.${action.tool} — ${truncateTextMiddle(message, 320)}`);
            }
          }
        },
      );
    } catch (error: any) {
      const message = redactSensitiveText(error?.message || String(error));
      for (const action of actions) {
        if (executedMcpActions.some((entry) => entry.id === action.id)) continue;
        executedMcpActions.push(McpExecutedActionSchema.parse({
          ...action,
          status: 'failed',
          outputSummary: truncateTextMiddle(message, 320),
          outputPreview: truncateTextMiddle(message, MCP_ACTION_OUTPUT_PREVIEW_MAX_CHARS),
        }));
      }
      notes.push(`MCP action group ${serverName} failed before tool execution: ${truncateTextMiddle(message, 320)}`);
    }
  }

  return {
    executedMcpActions,
    mcpActionNotes: appendUniqueNotes(state.mcpActionNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

async function preplanMcpActionsNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!shouldRunPreplanMcpActionsForState(state)) {
    return {
      executedMcpActions: state.executedMcpActions,
    };
  }

  return executePlannedMcpActions(
    state,
    getPendingMcpActions(state, { safeOnly: true }),
  );
}

async function runMcpActionsNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!shouldRunMcpActionsForState(state)) {
    return {
      executedMcpActions: state.executedMcpActions,
    };
  }

  const patch = await executePlannedMcpActions(
    state,
    getPendingMcpActions(state),
  );
  const browserInspectionNotes = buildResearchScoutWebsiteInspectionNotes({
    executedMcpActions: patch.executedMcpActions || state.executedMcpActions,
  });
  if (browserInspectionNotes.length === 0) {
    return patch;
  }

  return {
    ...patch,
    plannerNotes: appendUniqueNotes(state.plannerNotes, browserInspectionNotes),
    repairNotes: appendUniqueNotes(state.repairNotes, browserInspectionNotes),
    recentAutonomousLearningNotes: appendUniqueNotes(state.recentAutonomousLearningNotes, browserInspectionNotes).slice(-12),
    mcpActionNotes: appendUniqueNotes(state.mcpActionNotes, browserInspectionNotes),
  };
}

function buildWebIdeaScoutSuggestions(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairSignals'
    | 'improvementSignals'
    | 'autonomousContractPaths'
    | 'executedMcpActions'
  >,
): string[] {
  const successfulSearches = state.executedMcpActions
    .filter((action) => {
      if (!(action.server === 'brave-search' && action.status === 'success')) return false;
      const family = inferResearchScoutQueryFamily(action);
      const links = extractResearchScoutActionLinks(action);
      const topLink = links
        .map((link) => ({
          ...link,
          score: scoreResearchScoutLink(action, link),
          hostname: getResearchScoutHostname(link.url),
        }))
        .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))[0];
      if (!topLink) return false;
      if (isResearchScoutNavigationTrap(topLink.url, topLink.hostname, [topLink.title, topLink.description].join(' | '))) return false;
      if (isResearchScoutUndesiredHost(topLink.hostname, family)) return false;
      if (!isResearchScoutPreferredTechnicalHost(topLink.hostname, family) && topLink.score < (family === 'api' ? 10 : 9)) return false;
      return true;
    })
    .slice(-3);
  if (successfulSearches.length === 0) return [];

  const candidatePaths = getResearchScoutCandidatePaths(state);

  const notes: string[] = [];
  for (const action of successfulSearches) {
    const sourceText = [
      action.title,
      action.outputSummary,
      action.outputPreview,
    ]
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .join(' | ');
    if (!sourceText) continue;

    const ranked = rankResearchScoutCandidatePaths(state, candidatePaths, sourceText);

    const topPaths = ranked.slice(0, 2).map((entry) => entry.path);
    if (topPaths.length === 0) {
      notes.push(
        `Web idea scout: ${truncateTextMiddle(action.outputSummary || action.title, 180)} — no practical in-scope mapping was found for the current contract or loaded skill references.`,
      );
      continue;
    }

    const bestScore = ranked[0]?.score || 0;
    const practicality = bestScore >= 7 ? 'high' : bestScore >= 4 ? 'medium' : 'low';
    notes.push(
      `Web idea scout: ${truncateTextMiddle(action.outputSummary || action.title, 180)} — possible fit ${topPaths.join(', ')} (practicality: ${practicality}; mapped from current contract/skill references).`,
    );
  }

  return Array.from(new Set(notes)).slice(0, 4);
}

function appendUniqueMcpActions(
  existing: McpPlannedAction[],
  additions: McpPlannedAction[],
): McpPlannedAction[] {
  const merged: McpPlannedAction[] = [...existing];
  const seenIds = new Set(
    existing.map((action) => String(action.id || '').trim()).filter(Boolean),
  );
  for (const action of additions) {
    const id = String(action.id || '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    merged.push(action);
  }
  return merged;
}

type ResearchScoutVisitedPageRecord = {
  key: string;
  url: string;
  hostname: string;
  family: 'control-plane' | 'api' | 'generic';
  keywords: string[];
  mappedPaths: string[];
  totalScore: number;
  quality: 'high' | 'medium' | 'low';
  firstVisitedAt: string;
  lastVisitedAt: string;
  visitCount: number;
};

type ResearchScoutVisitedPageHistory = {
  visitedUrls: Set<string>;
  hostVisitCounts: Map<string, number>;
  keywordSet: Set<string>;
};

type ResearchScoutWebsiteObservation = {
  url: string;
  hostname: string;
  family: 'control-plane' | 'api' | 'generic';
  searchTitle: string;
  searchDescription: string;
  searchScore: number;
  pageTitle: string;
  pageSummary: string;
  pagePreview: string;
  pageText: string;
};

type ResearchScoutWebsiteFinding = ResearchScoutWebsiteObservation & {
  keywords: string[];
  mappedPaths: string[];
  practicalityScore: number;
  informationScore: number;
  authorityScore: number;
  noveltyScore: number;
  semanticNoveltyScore: number;
  nearestNeighborUrl: string;
  nearestNeighborScore: number;
  diversityScore: number;
  totalScore: number;
  quality: 'high' | 'medium' | 'low';
};

function getResearchScoutCandidatePaths(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairSignals'
    | 'improvementSignals'
    | 'autonomousContractPaths'
  >,
): string[] {
  const effectiveScopes = getEffectiveScopes(state as ControlPlaneState);
  const skillBundle = resolveAutonomousSkillBundle({
    effectiveScopes,
    goal: state.goal,
    repairSignals: state.repairSignals,
    improvementSignals: state.improvementSignals,
    autonomousContractPaths: state.autonomousContractPaths,
  });
  return Array.from(new Set(
    [
      ...state.autonomousContractPaths,
      ...[...skillBundle.alwaysLoaded, ...skillBundle.loaded].flatMap((skill) => [
        ...skill.references,
        ...(skill.contract?.preferredPaths || []),
      ]),
    ]
      .map((entry) => String(entry || '').trim())
      .filter(Boolean),
  ));
}

function rankResearchScoutCandidatePaths(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairSignals'
    | 'improvementSignals'
    | 'autonomousContractPaths'
  >,
  candidatePaths: string[],
  sourceText: string,
): Array<{ path: string; score: number }> {
  const effectiveScopes = getEffectiveScopes(state as ControlPlaneState);
  const skillBundle = resolveAutonomousSkillBundle({
    effectiveScopes,
    goal: state.goal,
    repairSignals: state.repairSignals,
    improvementSignals: state.improvementSignals,
    autonomousContractPaths: state.autonomousContractPaths,
  });
  return candidatePaths
    .map((candidatePath) => {
      const baseScore = scoreAutonomousEditPathFit(state as ControlPlaneState, candidatePath, sourceText);
      const skillReferenced = [...skillBundle.alwaysLoaded, ...skillBundle.loaded]
        .some((skill) =>
          skill.references.includes(candidatePath)
          || (skill.contract?.preferredPaths || []).includes(candidatePath));
      const contractReferenced = state.autonomousContractPaths.includes(candidatePath);
      return {
        path: candidatePath,
        score: baseScore + (skillReferenced ? 2 : 0) + (contractReferenced ? 1 : 0),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function getResearchScoutPageMemoryNamespace(
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
): string[] {
  return [...getControlPlaneSemanticMemoryNamespace(state), 'research-scout-pages'];
}

async function readResearchScoutVisitedPageRecords(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
): Promise<ResearchScoutVisitedPageRecord[]> {
  if (!store) return [];
  const namespace = getResearchScoutPageMemoryNamespace(state);
  const items = await store.search(namespace, {
    limit: 96,
  }).catch(() => [] as SearchItem[]);

  const seenUrls = new Set<string>();
  const records: ResearchScoutVisitedPageRecord[] = [];
  for (const item of items) {
    const value = item.value && typeof item.value === 'object'
      ? item.value as Record<string, unknown>
      : {};
    const url = normalizeHttpUrl(value.pageUrl || item.key);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    records.push({
      key: String(item.key || url),
      url,
      hostname: getResearchScoutHostname(url),
      family: value.family === 'control-plane' || value.family === 'api' ? value.family : 'generic',
      keywords: Array.isArray(value.keywords)
        ? value.keywords.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
      mappedPaths: Array.isArray(value.mappedPaths)
        ? value.mappedPaths.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [],
      totalScore: Number(value.totalScore) || 0,
      quality: value.quality === 'high' || value.quality === 'medium' ? value.quality : 'low',
      firstVisitedAt: String(value.firstVisitedAt || ''),
      lastVisitedAt: String(value.lastVisitedAt || ''),
      visitCount: Math.max(1, Math.floor(Number(value.visitCount) || 1)),
    });
  }

  return records;
}

function buildResearchScoutVisitedPageHistory(
  records: ResearchScoutVisitedPageRecord[],
): ResearchScoutVisitedPageHistory {
  const visitedUrls = new Set<string>();
  const hostVisitCounts = new Map<string, number>();
  const keywordSet = new Set<string>();

  for (const record of records) {
    if (record.url) visitedUrls.add(record.url);
    if (record.hostname) {
      hostVisitCounts.set(
        record.hostname,
        (hostVisitCounts.get(record.hostname) || 0) + Math.max(1, record.visitCount),
      );
    }
    for (const keyword of record.keywords) {
      const normalized = String(keyword || '').trim().toLowerCase();
      if (normalized) keywordSet.add(normalized);
    }
  }

  return {
    visitedUrls,
    hostVisitCounts,
    keywordSet,
  };
}

function buildResearchScoutPageSearchText(
  input: {
    family: 'control-plane' | 'api' | 'generic';
    pageTitle?: string;
    searchTitle?: string;
    searchDescription?: string;
    pageSummary?: string;
    pagePreview?: string;
    mappedPaths?: string[];
    keywords?: string[];
    hostname?: string;
  },
): string {
  return truncateTextMiddle(
    [
      input.family,
      input.hostname,
      input.pageTitle,
      input.searchTitle,
      input.searchDescription,
      input.pageSummary,
      input.pagePreview,
      Array.isArray(input.keywords) ? input.keywords.join(' ') : '',
      Array.isArray(input.mappedPaths) ? input.mappedPaths.join(' ') : '',
    ]
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .join('\n'),
    1_200,
  );
}

function tokenizeResearchText(value: string): string[] {
  const ignored = new Set(['the', 'and', 'for', 'with', 'that', 'from', 'this', 'into', 'using', 'ideas', 'idea', 'agent', 'agents', 'api', 'apis', 'docs', 'guide', 'developer', 'developers', 'implementation', 'patterns']);
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

function extractUrlsFromTextPreview(text: string): string[] {
  const matches = String(text || '').match(/https?:\/\/\S+/g) || [];
  const normalized = matches
    .map((entry) => normalizeHttpUrl(entry.replace(/[),.;]+$/g, '')))
    .filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, 4);
}

function extractResearchScoutActionLinks(
  action: Pick<McpExecutedAction, 'outputLinks' | 'outputPreview' | 'outputSummary' | 'title'>,
): Array<{ url: string; title: string; description: string; source: string }> {
  if (Array.isArray(action.outputLinks) && action.outputLinks.length > 0) {
    return action.outputLinks;
  }

  return extractUrlsFromTextPreview(action.outputPreview || action.outputSummary || '')
    .map((url) => ({
      url,
      title: action.title || '',
      description: action.outputSummary || action.outputPreview || '',
      source: 'preview-fallback',
    }));
}

function extractResearchScoutSiteConstraints(
  query: unknown,
): string[] {
  const matches = String(query || '').toLowerCase().match(/site:([^\s]+)/g) || [];
  return Array.from(new Set(
    matches
      .map((entry) => entry.replace(/^site:/, '').trim())
      .map((entry) => entry.split('/')[0] || '')
      .map((entry) => entry.replace(/^[.]+|[.]+$/g, ''))
      .filter(Boolean),
  ));
}

function researchScoutHostnameMatchesConstraint(
  hostname: string,
  constraint: string,
): boolean {
  const normalizedHostname = String(hostname || '').toLowerCase();
  const normalizedConstraint = String(constraint || '').toLowerCase();
  if (!normalizedHostname || !normalizedConstraint) return false;
  return normalizedHostname === normalizedConstraint || normalizedHostname.endsWith(`.${normalizedConstraint}`);
}

function inferResearchScoutQueryFamily(
  action: Pick<McpExecutedAction, 'arguments'>,
): 'control-plane' | 'api' | 'generic' {
  return inferResearchScoutQueryFamilyFromText(
    (action.arguments as Record<string, unknown> | undefined)?.query || '',
  );
}

function getResearchScoutHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function scoreResearchScoutDomain(hostname: string, family: 'control-plane' | 'api' | 'generic'): number {
  if (!hostname) return 0;

  if (/github\.com$/.test(hostname)) return 6;
  if (/docs?\./.test(hostname) || /readthedocs\.io$/.test(hostname)) return 6;
  if (/langchain\.com$/.test(hostname) || /langchain\.dev$/.test(hostname)) return family === 'control-plane' ? 4 : 7;
  if (/modelcontextprotocol\.io$/.test(hostname)) return family === 'control-plane' ? 9 : 5;
  if (/qdrant\.tech$/.test(hostname)) return family === 'control-plane' ? 9 : 5;
  if (/temporal\.io$/.test(hostname)) return family === 'control-plane' ? 9 : 3;
  if (/openrouter\.ai$/.test(hostname)) return family === 'api' ? 7 : 3;
  if (/platform\.openai\.com$/.test(hostname) || /openai\.com$/.test(hostname)) return family === 'api' ? 7 : 4;
  if (/ai\.google\.dev$/.test(hostname) || /developers\.google\.com$/.test(hostname)) return family === 'api' ? 6 : 3;
  if (/anthropic\.com$/.test(hostname) || /docs\.anthropic\.com$/.test(hostname)) return family === 'api' ? 6 : 3;
  if (/arxiv\.org$/.test(hostname) || /paperswithcode\.com$/.test(hostname)) return 6;
  if (/pypi\.org$/.test(hostname)) return 5;
  if (/realpython\.com$/.test(hostname)) return 4;
  if (/wikipedia\.org$/.test(hostname)) return 1;
  if (/reddit\.com$/.test(hostname) || /redd\.it$/.test(hostname)) return -6;
  if (/aws\.amazon\.com$/.test(hostname) || /cloudflare\.com$/.test(hostname)) return family === 'api' ? 0 : 2;
  if (/medium\.com$/.test(hostname)) return family === 'control-plane' ? -5 : -3;
  if (/geeksforgeeks\.org$/.test(hostname) || /forbes\.com$/.test(hostname)) return -2;
  if (/harvard\.edu$/.test(hostname) || /hls\.harvard\.edu$/.test(hostname) || /cartoonstock\.com$/.test(hostname) || /insper\.edu\.br$/.test(hostname) || /hofstra\.edu$/.test(hostname)) return -8;
  return 0;
}

function hasResearchScoutIrrelevantSignals(
  text: string,
): boolean {
  return /master of laws|law school|graduate program|degree\b|cartoons?|comics?|funny pictures?|cartoonstock|ll\.m\b/.test(text);
}

function isResearchScoutTechnicalDocLike(text: string): boolean {
  return /documentation|developer|developers|docs\b|reference|api reference|guide|tutorial|github|framework|sdk|library|repository|open source/.test(text);
}

function isResearchScoutLowValueCommunityHost(hostname: string): boolean {
  return /reddit\.com$|redd\.it$|medium\.com$|geeksforgeeks\.org$|forbes\.com$|wikipedia\.org$|dev\.to$|zhihu\.com$/.test(hostname);
}

function isResearchScoutPreferredTechnicalHost(
  hostname: string,
  family: 'control-plane' | 'api' | 'generic',
): boolean {
  const normalizedHostname = String(hostname || '').toLowerCase();
  if (!normalizedHostname) return false;
  if (/github\.com$|readthedocs\.io$|docs?\./.test(normalizedHostname)) return true;
  if (/langchain\.com$|langchain\.dev$|modelcontextprotocol\.io$|qdrant\.tech$|temporal\.io$|arxiv\.org$|paperswithcode\.com$|pypi\.org$/.test(normalizedHostname)) return true;
  if (family === 'api' && /openrouter\.ai$|platform\.openai\.com$|openai\.com$|ai\.google\.dev$|developers\.google\.com$|anthropic\.com$|docs\.anthropic\.com$|postman\.com$/.test(normalizedHostname)) return true;
  return false;
}

function isResearchScoutDictionaryHost(hostname: string): boolean {
  return /merriam-webster\.com$|dictionary\.cambridge\.org$|dictionary\.com$|thefreedictionary\.com$|collinsdictionary\.com$/.test(hostname);
}

function isResearchScoutUndesiredHost(
  hostname: string,
  family: 'control-plane' | 'api' | 'generic',
): boolean {
  if (!hostname) return true;
  if (isResearchScoutDictionaryHost(hostname)) return true;
  if (/osfhealthcare\.org$|myworkday\.com$|okta\.com$|zoom\.us$/.test(hostname)) return true;
  if (family !== 'generic' && /support\.google\.com$|google\.com$/.test(hostname)) return true;
  return false;
}

function isResearchScoutNavigationTrap(
  url: string,
  hostname: string,
  text: string,
): boolean {
  const normalizedUrl = String(url || '').toLowerCase();
  const normalizedHostname = String(hostname || '').toLowerCase();
  const normalizedText = String(text || '').toLowerCase();

  if (/accounts\.google\.com$|app\.docs\.google\.com$|docs\.google\.com$|drive\.google\.com$/.test(normalizedHostname)) {
    return true;
  }

  if (/(^|[/?#&])(login|signin|sign-in|auth|oauth|account|accounts)([/?#=&]|$)/.test(normalizedUrl)) {
    return true;
  }

  if (/sign in|signin|sign-in|log in|login|create account|choose an account|google accounts|not your computer|guest mode|continue to docs/i.test(normalizedText)) {
    return true;
  }

  return false;
}

function extractResearchScoutTopicMarkers(text: string): string[] {
  const normalized = String(text || '').toLowerCase();
  const markers: string[] = [];
  const push = (value: string): void => {
    if (!markers.includes(value)) markers.push(value);
  };
  if (/langgraph/.test(normalized)) push('langgraph');
  if (/langchain/.test(normalized)) push('langchain');
  if (/model context protocol|\bmcp\b/.test(normalized)) push('mcp');
  if (/qdrant/.test(normalized)) push('qdrant');
  if (/temporal/.test(normalized)) push('temporal');
  if (/openrouter/.test(normalized)) push('openrouter');
  if (/\bopenai\b|responses api/.test(normalized)) push('openai');
  if (/gemini/.test(normalized)) push('gemini');
  if (/anthropic|claude/.test(normalized)) push('anthropic');
  if (/checkpoint|state graph|durable/.test(normalized)) push('durable');
  if (/routing|provider|rate limit|quota|capability/.test(normalized)) push('routing');
  return markers;
}

function scoreResearchScoutPreviewQueryMatch(
  query: string,
  text: string,
): number {
  const queryTokens = tokenizeResearchText(query).slice(0, 12);
  const previewTokens = new Set(tokenizeResearchText(text));
  if (queryTokens.length === 0 || previewTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (previewTokens.has(token)) matches += 1;
  }
  return matches;
}

function decodeResearchScoutHtmlEntities(text: string): string {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function normalizeResearchScoutWhitespace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractResearchScoutHtmlTitle(html: string): string {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeResearchScoutWhitespace(decodeResearchScoutHtmlEntities(match?.[1] || ''));
}

function extractResearchScoutMetaDescription(html: string): string {
  const match = String(html || '').match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)
    || String(html || '').match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i);
  return normalizeResearchScoutWhitespace(decodeResearchScoutHtmlEntities(match?.[1] || ''));
}

function extractResearchScoutBodyText(html: string): string {
  const stripped = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return truncateTextMiddle(
    normalizeResearchScoutWhitespace(decodeResearchScoutHtmlEntities(stripped)),
    RESEARCH_SCOUT_PREFETCH_TEXT_MAX_CHARS,
  );
}

type ResearchScoutPrefetchedPage = {
  requestedUrl: string;
  finalUrl: string;
  hostname: string;
  title: string;
  description: string;
  text: string;
  contentType: string;
  score: number;
  blockedReason: string;
};

async function fetchResearchScoutPagePreview(
  url: string,
  family: 'control-plane' | 'api' | 'generic',
): Promise<ResearchScoutPrefetchedPage | null> {
  const normalizedUrl = normalizeHttpUrl(url);
  if (!normalizedUrl) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESEARCH_SCOUT_PREFETCH_TIMEOUT_MS);
  try {
    const response = await fetch(normalizedUrl, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'user-agent': 'AnyGPT-ResearchScout/1.0 (+https://github.com/AnyVM-Tech/AnyGPT)',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok) {
      return {
        requestedUrl: normalizedUrl,
        finalUrl: normalizeHttpUrl(response.url || normalizedUrl) || normalizedUrl,
        hostname: getResearchScoutHostname(response.url || normalizedUrl),
        title: '',
        description: '',
        text: '',
        contentType,
        score: -12,
        blockedReason: `http-${response.status}`,
      };
    }

    if (!/text\/html|application\/xhtml\+xml|text\/plain/.test(contentType)) {
      return {
        requestedUrl: normalizedUrl,
        finalUrl: normalizeHttpUrl(response.url || normalizedUrl) || normalizedUrl,
        hostname: getResearchScoutHostname(response.url || normalizedUrl),
        title: '',
        description: '',
        text: '',
        contentType,
        score: -8,
        blockedReason: 'unsupported-content-type',
      };
    }

    const rawBody = truncateTextMiddle(await response.text(), RESEARCH_SCOUT_PREFETCH_TEXT_MAX_CHARS);
    const finalUrl = normalizeHttpUrl(response.url || normalizedUrl) || normalizedUrl;
    const hostname = getResearchScoutHostname(finalUrl);
    const title = /text\/html|application\/xhtml\+xml/.test(contentType)
      ? extractResearchScoutHtmlTitle(rawBody)
      : '';
    const description = /text\/html|application\/xhtml\+xml/.test(contentType)
      ? extractResearchScoutMetaDescription(rawBody)
      : '';
    const text = /text\/html|application\/xhtml\+xml/.test(contentType)
      ? extractResearchScoutBodyText(rawBody)
      : normalizeResearchScoutWhitespace(rawBody);
    const combinedText = [title, description, text].filter(Boolean).join(' | ');

    if (isResearchScoutNavigationTrap(finalUrl, hostname, combinedText)) {
      return {
        requestedUrl: normalizedUrl,
        finalUrl,
        hostname,
        title,
        description,
        text,
        contentType,
        score: -15,
        blockedReason: 'navigation-trap',
      };
    }
    if (isResearchScoutUndesiredHost(hostname, family)) {
      return {
        requestedUrl: normalizedUrl,
        finalUrl,
        hostname,
        title,
        description,
        text,
        contentType,
        score: -12,
        blockedReason: 'undesired-host',
      };
    }

    let score = 0;
    if (isResearchScoutTechnicalDocLike(combinedText.toLowerCase())) score += 3;
    if (/guide|reference|tutorial|overview|quickstart|examples?|best practices?|implementation/.test(combinedText.toLowerCase())) score += 2;
    if (family === 'control-plane' && /mcp|model context protocol|checkpoint|durable|state graph|governance|evaluation|observability|semantic memory|vector memory|hybrid search|agent orchestration|workflow/.test(combinedText.toLowerCase())) score += 4;
    if (family === 'api' && /api|provider|routing|retry|quota|rate limit|capability|openai|openrouter|gemini|anthropic|responses api/.test(combinedText.toLowerCase())) score += 4;
    if (!combinedText || combinedText.length < 120) score -= 2;

    return {
      requestedUrl: normalizedUrl,
      finalUrl,
      hostname,
      title,
      description,
      text,
      contentType,
      score,
      blockedReason: '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isResearchScoutNoResultAction(
  action: Pick<McpExecutedAction, 'server' | 'status' | 'outputSummary' | 'outputPreview'>,
): boolean {
  if (action.server !== 'brave-search' || action.status !== 'success') return false;
  const text = [action.outputSummary, action.outputPreview].map((entry) => String(entry || '').trim()).join(' | ').toLowerCase();
  return text.includes('no results found for ');
}

function scoreResearchScoutLink(
  action: Pick<McpExecutedAction, 'arguments'>,
  link: { url: string; title: string; description: string; source: string },
): number {
  const family = inferResearchScoutQueryFamily(action);
  const rawQuery = String((action.arguments as Record<string, unknown> | undefined)?.query || '');
  const queryTokens = tokenizeResearchText(rawQuery);
  const combinedText = [link.title, link.description, link.source, link.url].join(' ');
  const haystack = tokenizeResearchText(combinedText);
  if (queryTokens.length === 0 || haystack.length === 0) return 0;

  const hostname = getResearchScoutHostname(link.url);
  const normalizedText = combinedText.toLowerCase();
  if (hasResearchScoutIrrelevantSignals(normalizedText)) {
    return -10;
  }
  if (isResearchScoutNavigationTrap(link.url, hostname, combinedText)) {
    return -12;
  }

  const siteConstraints = extractResearchScoutSiteConstraints(rawQuery);
  if (siteConstraints.length > 0 && !siteConstraints.some((constraint) => researchScoutHostnameMatchesConstraint(hostname, constraint))) {
    return -8;
  }

  const haystackSet = new Set(haystack);
  let score = 0;
  for (const token of queryTokens) {
    if (haystackSet.has(token)) score += 2;
  }
  if (/langgraph|langchain|openai|openrouter|gemini|gateway|routing|retry|capability|quota|prompt|workflow|agent/i.test([link.title, link.description].join(' '))) {
    score += 1;
  }

  if (family === 'control-plane') {
    if (/langgraph|langchain|orchestration|workflow|agent|mcp|model context protocol|checkpoint|durable execution|state graph|state machine|governance|evaluation|observability|semantic memory|vector memory|hybrid search/.test(normalizedText)) score += 6;
    if (isResearchScoutTechnicalDocLike(normalizedText)) score += 2;
    if (/governance|evaluation|observability|checkpoint|memory|mcp|state/.test(normalizedText)) score += 2;
    if (!/langgraph|langchain|orchestration|workflow|agent|mcp|model context protocol|checkpoint|durable execution|state graph|state machine|governance|evaluation|observability|semantic memory|vector memory|hybrid search/.test(normalizedText)) score -= 5;
  } else if (family === 'api') {
    if (/api|gateway|routing|provider|retry|quota|capability|openai|openrouter|gemini|rate limit|resilience/.test(normalizedText)) score += 5;
    if (/large language model|model gateway|model routing/.test(normalizedText)) score += 1;
    if (isResearchScoutTechnicalDocLike(normalizedText)) score += 2;
    if (/what is\b|explained\b/.test(normalizedText)) score -= 2;
    if (!/api|gateway|routing|provider|retry|quota|capability|openai|openrouter|gemini|rate limit|resilience/.test(normalizedText)) score -= 5;
  }

  score += scoreResearchScoutDomain(hostname, family);
  return score;
}

function getBestResearchScoutSearchScore(
  action: Pick<McpExecutedAction, 'arguments' | 'outputLinks' | 'outputPreview' | 'outputSummary' | 'title'>,
): number {
  const links = extractResearchScoutActionLinks(action);
  if (links.length === 0) return 0;
  return Math.max(
    ...links.map((link) => scoreResearchScoutLink(action, link)),
  );
}

function buildResearchScoutFallbackSearchActions(
  state: Pick<
    ControlPlaneState,
    | 'executedMcpActions'
    | 'plannedMcpActions'
    | 'mcpConfigPath'
    | 'mcpInspections'
  >,
): McpPlannedAction[] {
  const braveInspection = state.mcpInspections.find((inspection) => inspection.server === 'brave-search');
  if (braveInspection?.status !== 'connected') return [];

  const configsByServer = new Map(
    loadMcpServers(resolveMcpConfigPath(state as ControlPlaneState)).map((server) => [server.name, server] as const),
  );
  const braveConfig = configsByServer.get('brave-search');
  if (!braveConfig) return [];

  const existingIds = new Set(
    [
      ...(state.plannedMcpActions || []).map((action) => String(action.id || '').trim()),
      ...(state.executedMcpActions || []).map((action) => String(action.id || '').trim()),
    ].filter(Boolean),
  );

  const actions: McpPlannedAction[] = [];
  for (const executedAction of state.executedMcpActions || []) {
    const family = inferResearchScoutQueryFamily(executedAction);
    const needsFallback = isResearchScoutNoResultAction(executedAction)
      || (family === 'api' && getBestResearchScoutSearchScore(executedAction) < 5);
    if (!needsFallback) continue;
    const preferredTool = mcpInspectionHasTool(braveInspection, 'searxng_web_search')
      ? 'searxng_web_search'
      : 'brave_web_search';
    const fallbackQueries = buildResearchScoutFallbackQueries(family);
    for (const [index, query] of fallbackQueries.entries()) {
      const fallbackId = `mcp-brave-idea-scout-${family}-fallback-${index + 1}`;
      if (existingIds.has(fallbackId)) continue;

      actions.push(buildMcpPlannedAction({
        id: fallbackId,
        server: 'brave-search',
        tool: preferredTool,
        title: family === 'control-plane'
          ? 'Research control-plane fallback ideas with SearXNG'
          : family === 'api'
            ? 'Research API fallback ideas with SearXNG'
            : 'Research fallback ideas with SearXNG',
        reason: 'The first research query returned no results, so research-scout is retrying with a more targeted technical fallback query before selecting pages to inspect.',
        arguments: {
          query,
        },
        risk: 'low',
        alwaysAllow: braveConfig.alwaysAllow.includes(preferredTool),
      }));
    }
  }

  return actions.slice(0, 3);
}

async function buildResearchScoutRequestedSearchActions(
  store: BaseStore | undefined,
  state: Pick<
    ControlPlaneState,
    | 'langSmithProjectName'
    | 'governanceProfile'
    | 'plannedMcpActions'
    | 'executedMcpActions'
    | 'mcpConfigPath'
    | 'mcpInspections'
  >,
): Promise<McpPlannedAction[]> {
  const requestedQueries = await readResearchScoutRequestedQueries(store, state).catch(() => [] as string[]);
  if (requestedQueries.length === 0) return [];

  const braveInspection = state.mcpInspections.find((inspection) => inspection.server === 'brave-search');
  if (braveInspection?.status !== 'connected') return [];

  const configsByServer = new Map(
    loadMcpServers(resolveMcpConfigPath(state as ControlPlaneState)).map((server) => [server.name, server] as const),
  );
  const braveConfig = configsByServer.get('brave-search');
  if (!braveConfig) return [];

  const existingIds = new Set(
    [
      ...(state.plannedMcpActions || []).map((action) => String(action.id || '').trim()),
      ...(state.executedMcpActions || []).map((action) => String(action.id || '').trim()),
    ].filter(Boolean),
  );
  const preferredTool = mcpInspectionHasTool(braveInspection, 'searxng_web_search')
    ? 'searxng_web_search'
    : 'brave_web_search';

  const actions: McpPlannedAction[] = [];
  for (const [index, query] of requestedQueries.entries()) {
    const requestId = `mcp-brave-idea-scout-request-${index + 1}`;
    if (existingIds.has(requestId)) continue;
    actions.push(buildMcpPlannedAction({
      id: requestId,
      server: 'brave-search',
      tool: preferredTool,
      title: 'Research queued lane request with SearXNG',
      reason: 'Another autonomous lane requested external implementation context, so research-scout is gathering bounded web evidence for the shared pool.',
      arguments: { query },
      risk: 'low',
      alwaysAllow: braveConfig.alwaysAllow.includes(preferredTool),
    }));
  }

  return actions.slice(0, 3);
}

function buildResearchScoutWebsiteInspectionNotes(
  state: Pick<ControlPlaneState, 'executedMcpActions'>,
): string[] {
  const notes: string[] = [];
  const successfulBrowserActions = (state.executedMcpActions || [])
    .filter((action) =>
      action.server === 'playwright'
      && action.status === 'success'
      && /^mcp-playwright-research-/.test(String(action.id || '')));

  for (const action of successfulBrowserActions) {
    const targetUrl = normalizeHttpUrl((action.arguments as Record<string, unknown> | undefined)?.url);
    if (action.tool === 'browser_navigate' && targetUrl) {
      notes.push(`Research scout opened ${targetUrl} for direct website inspection.`);
      continue;
    }
    if (action.tool === 'browser_snapshot') {
      notes.push(`Research scout captured a browser snapshot from an opened result page — ${truncateTextMiddle(action.outputSummary || action.title, 180)}.`);
      continue;
    }
    notes.push(`Research scout browser inspection: ${truncateTextMiddle(action.outputSummary || action.title, 180)}.`);
  }

  return Array.from(new Set(notes)).slice(0, 4);
}

function extractResearchScoutActionOrdinal(actionId: string): string {
  const match = String(actionId || '').match(/-(\d+)$/);
  return match?.[1] || '';
}

function buildResearchScoutSearchLinkIndex(
  state: Pick<ControlPlaneState, 'executedMcpActions'>,
): Map<string, {
  url: string;
  title: string;
  description: string;
  source: string;
  searchScore: number;
  family: 'control-plane' | 'api' | 'generic';
}> {
  const linksByUrl = new Map<string, {
    url: string;
    title: string;
    description: string;
    source: string;
    searchScore: number;
    family: 'control-plane' | 'api' | 'generic';
  }>();

  for (const action of state.executedMcpActions || []) {
    if (action.server !== 'brave-search' || action.status !== 'success') continue;
    const family = inferResearchScoutQueryFamily(action);
    for (const link of extractResearchScoutActionLinks(action)) {
      const url = normalizeHttpUrl(link.url);
      if (!url) continue;
      const searchScore = scoreResearchScoutLink(action, link);
      const existing = linksByUrl.get(url);
      if (!existing || searchScore > existing.searchScore) {
        linksByUrl.set(url, {
          url,
          title: link.title,
          description: link.description,
          source: link.source,
          searchScore,
          family,
        });
      }
    }
  }

  return linksByUrl;
}

function collectResearchScoutWebsiteObservations(
  state: Pick<ControlPlaneState, 'executedMcpActions'>,
): ResearchScoutWebsiteObservation[] {
  const successfulBrowserActions = (state.executedMcpActions || [])
    .filter((action) =>
      action.server === 'playwright'
      && action.status === 'success'
      && /^mcp-playwright-research-/.test(String(action.id || '')));
  if (successfulBrowserActions.length === 0) return [];

  const searchLinksByUrl = buildResearchScoutSearchLinkIndex(state);
  const snapshotByOrdinal = new Map<string, McpExecutedAction>();
  for (const action of successfulBrowserActions) {
    if (action.tool !== 'browser_snapshot') continue;
    const ordinal = extractResearchScoutActionOrdinal(action.id);
    if (ordinal) snapshotByOrdinal.set(ordinal, action);
  }

  const observations: ResearchScoutWebsiteObservation[] = [];
  const seenUrls = new Set<string>();
  for (const action of successfulBrowserActions) {
    if (action.tool !== 'browser_navigate') continue;
    const url = normalizeHttpUrl((action.arguments as Record<string, unknown> | undefined)?.url);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const ordinal = extractResearchScoutActionOrdinal(action.id);
    const snapshot = ordinal ? snapshotByOrdinal.get(ordinal) : undefined;
    const searchMetadata = searchLinksByUrl.get(url);
    const pageSummary = snapshot?.outputSummary || action.outputSummary || searchMetadata?.title || action.title;
    const pagePreview = snapshot?.outputPreview || action.outputPreview || searchMetadata?.description || '';
    const pageText = [searchMetadata?.title, searchMetadata?.description, pageSummary, pagePreview]
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .join(' | ');

    observations.push({
      url,
      hostname: getResearchScoutHostname(url),
      family: searchMetadata?.family || 'generic',
      searchTitle: searchMetadata?.title || '',
      searchDescription: searchMetadata?.description || '',
      searchScore: searchMetadata?.searchScore || 0,
      pageTitle: searchMetadata?.title || action.title || url,
      pageSummary: truncateTextMiddle(pageSummary, 320),
      pagePreview: truncateTextMiddle(pagePreview, MCP_ACTION_OUTPUT_PREVIEW_MAX_CHARS),
      pageText,
    });
  }

  return observations;
}

async function scoreResearchScoutSemanticNovelty(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
  observation: ResearchScoutWebsiteObservation,
): Promise<{ score: number; nearestNeighborUrl: string; nearestNeighborScore: number }> {
  if (!store) {
    return { score: 0, nearestNeighborUrl: '', nearestNeighborScore: 0 };
  }

  const namespace = getResearchScoutPageMemoryNamespace(state);
  const query = buildResearchScoutPageSearchText({
    family: observation.family,
    pageTitle: observation.pageTitle,
    searchTitle: observation.searchTitle,
    searchDescription: observation.searchDescription,
    pageSummary: observation.pageSummary,
    pagePreview: observation.pagePreview,
    hostname: observation.hostname,
  });
  if (!query) {
    return { score: 0, nearestNeighborUrl: '', nearestNeighborScore: 0 };
  }

  const results = await store.search(namespace, {
    query,
    limit: 6,
  }).catch(() => [] as SearchItem[]);
  const neighbors = results.filter((item) => {
    const itemValue = item.value && typeof item.value === 'object'
      ? item.value as Record<string, unknown>
      : {};
    const candidateUrl = normalizeHttpUrl(itemValue.pageUrl || item.key);
    return Boolean(candidateUrl) && candidateUrl !== observation.url;
  });
  const strongest = neighbors[0];
  if (!strongest) {
    return { score: 2, nearestNeighborUrl: '', nearestNeighborScore: 0 };
  }

  const strongestValue = strongest.value && typeof strongest.value === 'object'
    ? strongest.value as Record<string, unknown>
    : {};
  const nearestNeighborUrl = normalizeHttpUrl(strongestValue.pageUrl || strongest.key);
  const nearestNeighborScore = typeof strongest.score === 'number' ? strongest.score : 0;
  const score = nearestNeighborScore >= 1.1
    ? -3
    : nearestNeighborScore >= 0.7
      ? -1
      : nearestNeighborScore >= 0.35
        ? 0
        : 2;

  return {
    score,
    nearestNeighborUrl,
    nearestNeighborScore,
  };
}

function scoreResearchScoutWebsiteInformation(
  family: 'control-plane' | 'api' | 'generic',
  pageText: string,
  hostname: string,
): number {
  const normalizedText = String(pageText || '').toLowerCase();
  let score = 0;

  if (normalizedText.length >= 240) score += 1;
  if (normalizedText.length >= 800) score += 1;
  if (isResearchScoutTechnicalDocLike(normalizedText)) score += 2;
  if (/guide|reference|tutorial|overview|quickstart|examples?|best practices?|implementation/.test(normalizedText)) score += 2;
  if (/abstract|method|evaluation|results|benchmark|paper/.test(normalizedText) && /arxiv\.org$|paperswithcode\.com$/.test(hostname)) score += 3;
  if (/cookie|cookies|sign in|subscribe|newsletter|advertisement/.test(normalizedText)) score -= 2;

  if (family === 'control-plane') {
    if (/model context protocol|mcp|temporal|qdrant|governance|evaluation|observability|semantic memory|vector memory|hybrid search/.test(normalizedText)) score += 5;
    if (/checkpoint|state graph|durable|interrupt|human in the loop|human-in-the-loop|multi-agent|memory/.test(normalizedText)) score += 4;
    if (/langgraph|langchain/.test(normalizedText)) score += 1;
  } else if (family === 'api') {
    if (/api|provider|routing|retry|backoff|quota|rate limit|rate limits|capability|fallback|error codes|responses api|tool use|tool calling|function calling|invalid argument|generatecontent/.test(normalizedText)) score += 5;
    if (/openai|openrouter|gemini|anthropic/.test(normalizedText)) score += 2;
  } else if (/framework|sdk|api|guide|reference|workflow|reliability|resilience/.test(normalizedText)) {
    score += 2;
  }

  return score;
}

async function rankResearchScoutWebsiteFindings(
  store: BaseStore | undefined,
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairSignals'
    | 'improvementSignals'
    | 'autonomousContractPaths'
    | 'executedMcpActions'
    | 'langSmithProjectName'
    | 'governanceProfile'
  >,
  history: ResearchScoutVisitedPageHistory,
): Promise<ResearchScoutWebsiteFinding[]> {
  const candidatePaths = getResearchScoutCandidatePaths(state);
  const observations = collectResearchScoutWebsiteObservations(state);
  const findings: ResearchScoutWebsiteFinding[] = [];

  for (const observation of observations) {
    const keywords = collectSemanticMemoryKeywords([observation.pageText], 10);
    const newKeywordCount = keywords.filter((keyword) => !history.keywordSet.has(keyword.toLowerCase())).length;
    const noveltyScore = newKeywordCount >= 6 ? 4 : newKeywordCount >= 3 ? 2 : newKeywordCount >= 1 ? 1 : 0;
    const hostVisitCount = history.hostVisitCounts.get(observation.hostname) || 0;
    const diversityScore = hostVisitCount === 0 ? 3 : hostVisitCount === 1 ? 1 : -Math.min(3, hostVisitCount);
    const authorityScore = Math.max(0, scoreResearchScoutDomain(observation.hostname, observation.family));
    const informationScore = scoreResearchScoutWebsiteInformation(
      observation.family,
      observation.pageText,
      observation.hostname,
    );
    const semanticNovelty = await scoreResearchScoutSemanticNovelty(store, state, observation);
    const rankedPaths = rankResearchScoutCandidatePaths(state, candidatePaths, observation.pageText);
    const mappedPaths = rankedPaths.slice(0, 2).map((entry) => entry.path);
    const practicalityScore = rankedPaths[0]?.score || 0;
    const totalScore = observation.searchScore
      + informationScore
      + authorityScore
      + noveltyScore
      + semanticNovelty.score
      + diversityScore
      + Math.min(6, practicalityScore);
    const quality: 'high' | 'medium' | 'low' = totalScore >= 18
      ? 'high'
      : totalScore >= 11
        ? 'medium'
        : 'low';

    findings.push({
      ...observation,
      keywords,
      mappedPaths,
      practicalityScore,
      informationScore,
      authorityScore,
      noveltyScore,
      semanticNoveltyScore: semanticNovelty.score,
      nearestNeighborUrl: semanticNovelty.nearestNeighborUrl,
      nearestNeighborScore: semanticNovelty.nearestNeighborScore,
      diversityScore,
      totalScore,
      quality,
    });
  }

  return findings.sort((left, right) => right.totalScore - left.totalScore || left.url.localeCompare(right.url));
}

function buildResearchScoutWebsiteRankingNotes(
  findings: ResearchScoutWebsiteFinding[],
  options?: { skippedRevisits?: number },
): string[] {
  const notes: string[] = [];
  if ((options?.skippedRevisits || 0) > 0) {
    notes.push(`Research scout skipped ${options?.skippedRevisits} previously inspected page(s) to avoid revisits.`);
  }
  const distinctHosts = new Set(findings.map((finding) => finding.hostname).filter(Boolean));
  if (distinctHosts.size > 1) {
    notes.push(`Research scout ranked information across ${distinctHosts.size} distinct domains to preserve source diversity.`);
  }

  for (const finding of findings.slice(0, 2)) {
    const practicality = finding.practicalityScore >= 7
      ? 'high'
      : finding.practicalityScore >= 4
        ? 'medium'
        : 'low';
    const novelty = finding.noveltyScore >= 4
      ? 'high'
      : finding.noveltyScore >= 2
        ? 'medium'
        : 'low';
    const semanticNovelty = finding.semanticNoveltyScore >= 2
      ? 'high'
      : finding.semanticNoveltyScore >= 0
        ? 'medium'
        : 'low';
    const diversity = finding.diversityScore >= 3
      ? 'new-domain'
      : finding.diversityScore >= 1
        ? 'light-repeat'
        : 'repeat-domain';
    const mappedPaths = finding.mappedPaths.length > 0
      ? finding.mappedPaths.join(', ')
      : 'no direct in-scope mapping';
    const keySignals = finding.keywords.slice(0, 4).join(', ') || 'n/a';
    notes.push(
      `Research scout ranked ${finding.url} as ${finding.quality}-value website evidence (practicality: ${practicality}; novelty: ${novelty}; semantic novelty: ${semanticNovelty}; diversity: ${diversity}) — mapped to ${mappedPaths}; signals: ${keySignals}${finding.nearestNeighborUrl ? `; nearest prior page: ${finding.nearestNeighborUrl}` : ''}.`,
    );
  }

  return Array.from(new Set(notes)).slice(0, 4);
}

async function writeResearchScoutWebsiteFindings(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
  findings: ResearchScoutWebsiteFinding[],
): Promise<void> {
  if (!store || findings.length === 0) return;
  const namespace = getResearchScoutPageMemoryNamespace(state);

  for (const finding of findings.slice(0, 4)) {
    if (isResearchScoutUndesiredHost(finding.hostname, finding.family)) continue;
    if (isResearchScoutNavigationTrap(finding.url, finding.hostname, [finding.pageTitle, finding.pageSummary, finding.pagePreview].join(' | '))) continue;
    if (isResearchScoutLowValueCommunityHost(finding.hostname)) continue;
    if (finding.family !== 'generic' && !isResearchScoutPreferredTechnicalHost(finding.hostname, finding.family)) continue;
    if (finding.mappedPaths.length === 0) continue;
    if (finding.quality !== 'high' && finding.informationScore < 8) continue;
    const key = normalizeHttpUrl(finding.url);
    if (!key) continue;
    const existing = await store.get(namespace, key).catch(() => null);
    const existingValue = existing?.value && typeof existing.value === 'object'
      ? existing.value as Record<string, unknown>
      : {};
    const now = new Date().toISOString();
    const firstVisitedAt = typeof existingValue.firstVisitedAt === 'string' && existingValue.firstVisitedAt.trim()
      ? existingValue.firstVisitedAt.trim()
      : now;
    const visitCount = Math.max(0, Math.floor(Number(existingValue.visitCount) || 0)) + 1;

    await store.put(namespace, key, {
      pageUrl: key,
      pageHostname: finding.hostname,
      family: finding.family,
      pageTitle: truncateTextMiddle(finding.pageTitle || finding.url, 180),
      searchTitle: truncateTextMiddle(finding.searchTitle, 180),
      searchDescription: truncateTextMiddle(finding.searchDescription, 220),
      pageSummary: truncateTextMiddle(finding.pageSummary, 320),
      pagePreview: truncateTextMiddle(finding.pagePreview, 900),
      searchText: buildResearchScoutPageSearchText({
        family: finding.family,
        pageTitle: finding.pageTitle,
        searchTitle: finding.searchTitle,
        searchDescription: finding.searchDescription,
        pageSummary: finding.pageSummary,
        pagePreview: finding.pagePreview,
        mappedPaths: finding.mappedPaths,
        keywords: finding.keywords,
        hostname: finding.hostname,
      }),
      mappedPaths: finding.mappedPaths,
      keywords: finding.keywords,
      informationScore: finding.informationScore,
      authorityScore: finding.authorityScore,
      noveltyScore: finding.noveltyScore,
      semanticNoveltyScore: finding.semanticNoveltyScore,
      nearestNeighborUrl: finding.nearestNeighborUrl,
      nearestNeighborScore: finding.nearestNeighborScore,
      diversityScore: finding.diversityScore,
      practicalityScore: finding.practicalityScore,
      totalScore: finding.totalScore,
      quality: finding.quality,
      firstVisitedAt,
      lastVisitedAt: now,
      visitCount,
    }, false).catch(() => undefined);
  }
}

async function pruneResearchScoutPageMemory(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
): Promise<string[]> {
  if (!store) return [];
  const namespace = getResearchScoutPageMemoryNamespace(state);
  const items = await store.search(namespace, { limit: 64 }).catch(() => [] as SearchItem[]);
  const removed: string[] = [];

  for (const item of items) {
    const value = item.value && typeof item.value === 'object'
      ? item.value as Record<string, unknown>
      : {};
    const url = normalizeHttpUrl(value.pageUrl || item.key);
    if (!url) continue;
    const hostname = getResearchScoutHostname(url);
    const family = value.family === 'control-plane' || value.family === 'api'
      ? value.family
      : 'generic';
    const combinedText = [
      value.pageTitle,
      value.searchTitle,
      value.searchDescription,
      value.pageSummary,
      value.pagePreview,
    ].map((entry) => String(entry || '').trim()).filter(Boolean).join(' | ');
    const shouldDelete = isResearchScoutNavigationTrap(url, hostname, combinedText)
      || isResearchScoutUndesiredHost(hostname, family)
      || isResearchScoutLowValueCommunityHost(hostname)
      || (family !== 'generic' && !isResearchScoutPreferredTechnicalHost(hostname, family))
      || !Array.isArray(value.mappedPaths)
      || (Array.isArray(value.mappedPaths) && value.mappedPaths.filter((entry) => String(entry || '').trim()).length === 0);
    if (!shouldDelete) continue;
    await store.delete(namespace, item.key).catch(() => undefined);
    removed.push(url);
  }

  return removed.slice(0, 8);
}

async function buildResearchScoutTrustedSourceCandidates(
  families: Array<'control-plane' | 'api' | 'generic'>,
  visitedUrls: Set<string>,
  hostVisitCounts: Map<string, number>,
): Promise<Array<{
  url: string;
  hostname: string;
  title: string;
  description: string;
  source: string;
  score: number;
  previewScore: number;
  previewText: string;
  previewQueryMatch: number;
  preferredHost: boolean;
  topicMismatch: boolean;
  blockedReason: string;
  family: 'control-plane' | 'api' | 'generic';
  query: string;
}>> {
  const normalizedFamilies = Array.from(new Set(
    families
      .filter((family): family is 'control-plane' | 'api' => family === 'control-plane' || family === 'api'),
  ));
  if (normalizedFamilies.length === 0) return [];

  const sources = normalizedFamilies.flatMap((family) => RESEARCH_SCOUT_TRUSTED_SOURCE_PACKS[family] || []);
  const prefetched = await Promise.all(
    sources.map(async (candidate) => ({
      candidate,
      preview: await fetchResearchScoutPagePreview(candidate.url, candidate.family),
    })),
  );

  return prefetched
    .map(({ candidate, preview }) => {
      const finalUrl = preview?.finalUrl || candidate.url;
      const hostname = preview?.hostname || getResearchScoutHostname(finalUrl);
      const previewText = [preview?.title, preview?.description, preview?.text].filter(Boolean).join(' | ');
      return {
        url: finalUrl,
        hostname,
        title: candidate.title,
        description: preview?.description || candidate.title,
        source: 'trusted-source-pack',
        score: 14 + Math.max(0, scoreResearchScoutDomain(hostname, candidate.family)),
        previewScore: preview?.score || 0,
        previewText,
        previewQueryMatch: 4,
        preferredHost: isResearchScoutPreferredTechnicalHost(hostname, candidate.family),
        topicMismatch: false,
        blockedReason: preview?.blockedReason || '',
        family: candidate.family,
        query: candidate.title,
      };
    })
    .filter((entry) => Boolean(entry.url))
    .filter((entry) => !entry.blockedReason)
    .filter((entry) => !visitedUrls.has(entry.url))
    .sort((left, right) => {
      const leftAdjusted = left.score + left.previewScore - Math.min(6, (hostVisitCounts.get(left.hostname) || 0) * 2);
      const rightAdjusted = right.score + right.previewScore - Math.min(6, (hostVisitCounts.get(right.hostname) || 0) * 2);
      return rightAdjusted - leftAdjusted || left.url.localeCompare(right.url);
    });
}

async function buildResearchScoutWebsiteVisitActions(
  state: Pick<
    ControlPlaneState,
    | 'repoRoot'
    | 'mcpConfigPath'
    | 'mcpInspections'
    | 'plannedMcpActions'
    | 'executedMcpActions'
    | 'maxMcpActions'
    | 'scopes'
    | 'effectiveScopes'
  >,
  history?: ResearchScoutVisitedPageHistory,
): Promise<{ actions: McpPlannedAction[]; notes: string[] }> {
  const effectiveScopes = new Set(getEffectiveScopes(state as ControlPlaneState));
  if (!effectiveScopes.has('research-scout')) return { actions: [], notes: [] };

  const playwrightInspection = state.mcpInspections.find((inspection) => inspection.server === 'playwright');
  if (playwrightInspection?.status !== 'connected') return { actions: [], notes: [] };

  const configsByServer = new Map(
    loadMcpServers(resolveMcpConfigPath(state as ControlPlaneState)).map((server) => [server.name, server] as const),
  );
  const playwrightConfig = configsByServer.get('playwright');
  if (!playwrightConfig) return { actions: [], notes: [] };

  const existingIds = new Set(
    [
      ...(state.plannedMcpActions || []).map((action) => String(action.id || '').trim()),
      ...(state.executedMcpActions || []).map((action) => String(action.id || '').trim()),
    ].filter(Boolean),
  );

  const seenUrls = new Set<string>();
  const selectedHostnames = new Set<string>();
  const revisitedUrls = new Set<string>();
  const filteredUrls = new Set<string>();
  const successfulSearchActions = (state.executedMcpActions || [])
    .filter((action) => action.server === 'brave-search' && action.status === 'success');
  const visitedUrls = history?.visitedUrls || new Set<string>();
  const hostVisitCounts = history?.hostVisitCounts || new Map<string, number>();

  const candidateLinks = successfulSearchActions
    .flatMap((action) =>
      extractResearchScoutActionLinks(action).map((link) => ({
        ...link,
        score: scoreResearchScoutLink(action, link),
        hostname: getResearchScoutHostname(link.url),
        family: inferResearchScoutQueryFamily(action),
        query: String((action.arguments as Record<string, unknown> | undefined)?.query || ''),
      })),
    )
    .filter((entry) => Boolean(entry.url))
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
    .slice(0, RESEARCH_SCOUT_PREFETCH_CANDIDATE_LIMIT);
  const candidateFamilies = Array.from(new Set(
    successfulSearchActions
      .map((action) => inferResearchScoutQueryFamily(action))
      .filter((family): family is 'control-plane' | 'api' => family === 'control-plane' || family === 'api'),
  ));

  const prefetchedPreviews = await Promise.all(
    candidateLinks.map(async (candidate) => ({
      candidate,
      preview: await fetchResearchScoutPagePreview(candidate.url, candidate.family),
    })),
  );

  const prefetchedCandidates = prefetchedPreviews
    .map(({ candidate, preview }) => {
      const finalUrl = preview?.finalUrl || candidate.url;
      const finalHostname = preview?.hostname || candidate.hostname;
      const previewText = [preview?.title, preview?.description, preview?.text].filter(Boolean).join(' | ');
      const combinedPreviewText = [candidate.title, candidate.description, previewText, finalUrl].filter(Boolean).join(' | ');
      const searchMarkers = extractResearchScoutTopicMarkers([candidate.title, candidate.description, candidate.query].join(' | '));
      const previewMarkers = extractResearchScoutTopicMarkers(combinedPreviewText);
      const previewQueryMatch = scoreResearchScoutPreviewQueryMatch(candidate.query, combinedPreviewText);
      const preferredHost = isResearchScoutPreferredTechnicalHost(finalHostname, candidate.family);
      const topicMismatch = searchMarkers.length > 0 && !searchMarkers.some((marker) => previewMarkers.includes(marker));
      return {
        ...candidate,
        url: finalUrl,
        hostname: finalHostname,
        previewScore: preview?.score || 0,
        previewText,
        previewQueryMatch,
        preferredHost,
        topicMismatch,
        blockedReason: preview?.blockedReason || '',
      };
    })
    .filter((entry) => {
      if (!entry.url) return false;
      if (entry.blockedReason) {
        filteredUrls.add(entry.url);
        return false;
      }
      if (isResearchScoutUndesiredHost(entry.hostname, entry.family)) {
        filteredUrls.add(entry.url);
        return false;
      }
      if (entry.topicMismatch) {
        filteredUrls.add(entry.url);
        return false;
      }
      if (!entry.preferredHost && entry.previewQueryMatch < 2) {
        filteredUrls.add(entry.url);
        return false;
      }
      const combinedScore = entry.score + entry.previewScore - Math.min(6, (hostVisitCounts.get(entry.hostname) || 0) * 2) + ((hostVisitCounts.get(entry.hostname) || 0) === 0 ? 1 : 0);
      return combinedScore >= (entry.family === 'api' ? 9 : 7);
    })
    .sort((left, right) => {
      const leftAdjusted = left.score + left.previewScore - Math.min(6, (hostVisitCounts.get(left.hostname) || 0) * 2) + ((hostVisitCounts.get(left.hostname) || 0) === 0 ? 1 : 0);
      const rightAdjusted = right.score + right.previewScore - Math.min(6, (hostVisitCounts.get(right.hostname) || 0) * 2) + ((hostVisitCounts.get(right.hostname) || 0) === 0 ? 1 : 0);
      return rightAdjusted - leftAdjusted || left.url.localeCompare(right.url);
    });

  const trustedSourceCandidates = await buildResearchScoutTrustedSourceCandidates(
    candidateFamilies.length > 0 ? candidateFamilies : ['control-plane', 'api'],
    visitedUrls,
    hostVisitCounts,
  );

  const selectedLinks: typeof prefetchedCandidates = [];
  const selectedFamilyCounts = new Map<string, number>();
  for (const link of prefetchedCandidates) {
    if (!link.url || seenUrls.has(link.url)) continue;
    if (visitedUrls.has(link.url)) {
      revisitedUrls.add(link.url);
      continue;
    }
    if (selectedHostnames.has(link.hostname)) continue;
    if ((selectedFamilyCounts.get(link.family) || 0) >= 2) continue;
    if (!link.preferredHost && link.previewQueryMatch < 3) continue;
    if (link.family === 'api' && isResearchScoutLowValueCommunityHost(link.hostname) && (link.score + link.previewScore) < 12) continue;
    if (link.family === 'control-plane' && isResearchScoutLowValueCommunityHost(link.hostname)) continue;
    seenUrls.add(link.url);
    if (link.hostname) selectedHostnames.add(link.hostname);
    selectedLinks.push(link);
    selectedFamilyCounts.set(link.family, (selectedFamilyCounts.get(link.family) || 0) + 1);
    if (selectedLinks.length >= 3) break;
  }

  for (const link of trustedSourceCandidates) {
    if (selectedLinks.length >= 3) break;
    if (!link.url || seenUrls.has(link.url)) continue;
    if (selectedHostnames.has(link.hostname)) continue;
    if ((selectedFamilyCounts.get(link.family) || 0) >= 2) continue;
    seenUrls.add(link.url);
    if (link.hostname) selectedHostnames.add(link.hostname);
    selectedLinks.push(link as (typeof prefetchedCandidates)[number]);
    selectedFamilyCounts.set(link.family, (selectedFamilyCounts.get(link.family) || 0) + 1);
  }

  const notes: string[] = [];
  if (revisitedUrls.size > 0) {
    notes.push(`Research scout skipped ${revisitedUrls.size} previously inspected page(s) to avoid revisits.`);
  }
  if (filteredUrls.size > 0) {
    notes.push(`Research scout filtered ${filteredUrls.size} low-quality or trap result page(s) before browser inspection.`);
  }
  if (selectedHostnames.size > 1) {
    notes.push(`Research scout prioritized ${selectedHostnames.size} distinct website domains in this pass to improve source diversity.`);
  }
  if (selectedLinks.length === 0) {
    if (revisitedUrls.size > 0) {
      notes.push('Research scout deferred website opening because the highest-ranked current results were already visited.');
    }
    return { actions: [], notes };
  }
  if (prefetchedCandidates.length === 0 && trustedSourceCandidates.length > 0) {
    notes.push('Research scout fell back to trusted-source browsing because search results were weak or empty.');
  }

  const actions: McpPlannedAction[] = [];
  for (const [index, link] of selectedLinks.entries()) {
    const label = link.title || link.url;
    const navigateId = `mcp-playwright-research-navigate-${index + 1}`;
    if (!existingIds.has(navigateId) && mcpInspectionHasTool(playwrightInspection, 'browser_navigate')) {
      actions.push(buildMcpPlannedAction({
        id: navigateId,
        server: 'playwright',
        tool: 'browser_navigate',
        title: `Open research page ${index + 1}: ${truncateTextMiddle(label, 80)}`,
        reason: 'Research-scout should open top search-result pages to inspect the actual website content instead of stopping at result snippets.',
        arguments: { url: link.url },
        risk: 'low',
        alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_navigate'),
      }));
    }
    const snapshotId = `mcp-playwright-research-snapshot-${index + 1}`;
    if (!existingIds.has(snapshotId) && mcpInspectionHasTool(playwrightInspection, 'browser_snapshot')) {
      actions.push(buildMcpPlannedAction({
        id: snapshotId,
        server: 'playwright',
        tool: 'browser_snapshot',
        title: `Capture research page snapshot ${index + 1}`,
        reason: 'Capture a structured page snapshot after opening the research website so the lane can summarize the real page content.',
        arguments: {},
        risk: 'low',
        alwaysAllow: playwrightConfig.alwaysAllow.includes('browser_snapshot'),
      }));
    }
  }

  return {
    actions: actions.slice(0, Math.max(0, state.maxMcpActions)),
    notes,
  };
}

async function webIdeaScoutNode(state: ControlPlaneState, runtime?: Runtime): Promise<Partial<ControlPlaneState>> {
  const prunedPoolUrls = await pruneResearchScoutPageMemory(runtime?.store, state).catch(() => [] as string[]);
  const requestedSearchActions = await buildResearchScoutRequestedSearchActions(runtime?.store, state);
  const requestedSearchPlannedActions = appendUniqueMcpActions(state.plannedMcpActions, requestedSearchActions);
  const requestedSearchNotes = requestedSearchActions
    .map((action) => `Research scout picked up queued lane request: ${action.title} (${action.server}.${action.tool}).`)
    .slice(0, 4);
  const requestedExecutionPatch = requestedSearchActions.length > 0
    ? await executePlannedMcpActions(
        {
          ...state,
          plannedMcpActions: requestedSearchPlannedActions,
        },
        requestedSearchActions,
      )
    : {};
  const executedMcpActionsAfterRequests = requestedExecutionPatch.executedMcpActions || state.executedMcpActions;

  const fallbackSearchActions = buildResearchScoutFallbackSearchActions({
    ...state,
    plannedMcpActions: requestedSearchPlannedActions,
    executedMcpActions: executedMcpActionsAfterRequests,
  });
  const fallbackSearchPlannedActions = appendUniqueMcpActions(requestedSearchPlannedActions, fallbackSearchActions);
  const fallbackSearchNotes = fallbackSearchActions
    .map((action) => `Research scout queued fallback search: ${action.title} (${action.server}.${action.tool}).`)
    .slice(0, 4);
  const fallbackExecutionPatch = fallbackSearchActions.length > 0
    ? await executePlannedMcpActions(
        {
          ...state,
          plannedMcpActions: fallbackSearchPlannedActions,
          executedMcpActions: executedMcpActionsAfterRequests,
        },
        fallbackSearchActions,
      )
    : {};
  const executedMcpActionsAfterFallback = fallbackExecutionPatch.executedMcpActions || executedMcpActionsAfterRequests;

  const notes = buildWebIdeaScoutSuggestions({
    ...state,
    executedMcpActions: executedMcpActionsAfterFallback,
  });
  const visitedPageRecords = await readResearchScoutVisitedPageRecords(runtime?.store, state).catch(() => [] as ResearchScoutVisitedPageRecord[]);
  const visitedHistory = buildResearchScoutVisitedPageHistory(visitedPageRecords);
  const followUpVisitPlan = await buildResearchScoutWebsiteVisitActions({
    ...state,
    plannedMcpActions: fallbackSearchPlannedActions,
    executedMcpActions: executedMcpActionsAfterFallback,
  }, visitedHistory);
  const followUpBrowserActions = followUpVisitPlan.actions;
  const followUpNotes = followUpBrowserActions
    .map((action) => `Research scout queued website inspection: ${action.title} (${action.server}.${action.tool}).`)
    .slice(0, 4);
  if (notes.length === 0 && fallbackSearchActions.length === 0 && followUpBrowserActions.length === 0 && followUpVisitPlan.notes.length === 0) return {};

  const plannedMcpActions = appendUniqueMcpActions(fallbackSearchPlannedActions, followUpBrowserActions);
  const browserExecutionPatch = followUpBrowserActions.length > 0
    ? await executePlannedMcpActions(
        {
          ...state,
          plannedMcpActions,
          executedMcpActions: executedMcpActionsAfterFallback,
        },
        followUpBrowserActions,
      )
    : {};
  const executedMcpActions = browserExecutionPatch.executedMcpActions || executedMcpActionsAfterFallback;
  const browserInspectionNotes = buildResearchScoutWebsiteInspectionNotes({
    executedMcpActions,
  });
  const websiteFindings = await rankResearchScoutWebsiteFindings(runtime?.store, {
    ...state,
    executedMcpActions,
  }, visitedHistory);
  await writeResearchScoutWebsiteFindings(runtime?.store, state, websiteFindings).catch(() => undefined);
  const rankingNotes = buildResearchScoutWebsiteRankingNotes(websiteFindings, {
    skippedRevisits: followUpVisitPlan.notes
      .filter((note) => /previously inspected page\(s\) to avoid revisits/i.test(note))
      .map((note) => Number(note.match(/(\d+)/)?.[1] || 0))
      .find((value) => value > 0) || 0,
  });
  const researchSynthesis = websiteFindings.length > 0
    ? await callAiNotesAgent(
        'planner',
        state,
        {
          evidenceFocus: 'research-scout-website-synthesis',
          websiteFindings: websiteFindings.slice(0, 3).map((finding) => ({
            url: finding.url,
            title: finding.pageTitle || finding.searchTitle,
            quality: finding.quality,
            mappedPaths: finding.mappedPaths,
            keywords: finding.keywords.slice(0, 6),
            summary: truncateTextMiddle(finding.pageSummary || finding.pagePreview, 600),
          })),
          queuedRequestNotes: requestedSearchNotes,
          rankingNotes,
        },
        [
          state.controlPlanePrompts.planner,
          'You are synthesizing already-collected website evidence for research-scout.',
          'Do not generate or alter search queries here.',
          'Prefer short notes that connect concrete page evidence to practical file-level improvements.',
        ].join('\n'),
      )
    : {
        enabled: false,
        model: state.aiAgentModel || '',
        backend: state.aiAgentBackend || '',
        notes: [],
        failureClass: state.lastAiFailureClass,
      };
  const synthesisNotes = researchSynthesis.notes.map((note) => `AI research scout synthesis: ${note}`);
  if (researchSynthesis.error) {
    synthesisNotes.push(`AI research scout synthesis unavailable: ${researchSynthesis.error}`);
  }
  const combinedNotes = [
    ...(prunedPoolUrls.length > 0 ? [`Research scout pruned ${prunedPoolUrls.length} stale or low-value page(s) from the shared research pool.`] : []),
    ...notes,
    ...requestedSearchNotes,
    ...fallbackSearchNotes,
    ...followUpVisitPlan.notes,
    ...followUpNotes,
    ...browserInspectionNotes,
    ...rankingNotes,
    ...synthesisNotes,
  ];

  return {
    plannedMcpActions,
    executedMcpActions,
    plannerNotes: appendUniqueNotes(state.plannerNotes, combinedNotes),
    repairNotes: appendUniqueNotes(state.repairNotes, combinedNotes),
    mcpActionNotes: appendUniqueNotes(
      state.mcpActionNotes,
      [
        ...requestedSearchNotes,
        ...(requestedExecutionPatch.mcpActionNotes || []),
        ...fallbackSearchNotes,
        ...(fallbackExecutionPatch.mcpActionNotes || []),
        ...followUpVisitPlan.notes,
        ...followUpNotes,
        ...(browserExecutionPatch.mcpActionNotes || []),
        ...browserInspectionNotes,
        ...rankingNotes,
        ...synthesisNotes,
      ],
    ),
    recentAutonomousLearningNotes: appendUniqueNotes(state.recentAutonomousLearningNotes, combinedNotes).slice(-12),
    aiAgentEnabled: state.aiAgentEnabled || researchSynthesis.enabled,
    aiAgentBackend: state.aiAgentBackend || researchSynthesis.backend,
    aiAgentModel: state.aiAgentModel || researchSynthesis.model,
    lastAiFailureClass: researchSynthesis.error ? (researchSynthesis.failureClass || 'backend-error') : state.lastAiFailureClass,
  };
}

async function applyAutonomousEditsNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!shouldApplyAutonomousEditsForState(state)) {
    return {
      appliedEdits: [],
      repairSmokeJobs: [],
      repairSmokeResults: [],
    };
  }

  const { appliedEdits, sessionManifest } = applyAutonomousEditsWithManifest(
    state.repoRoot,
    state.proposedEdits.slice(0, state.maxEditActions),
    state.editAllowlist,
    state.editDenylist,
  );

  const notes = appliedEdits.map((edit: AppliedAutonomousEdit) => `Autonomous edit ${edit.status}: ${edit.path} — ${edit.message}`);
  const touchedPaths = getRepairTouchedPaths({ appliedEdits, repairSessionManifest: sessionManifest });
  const firstFailure = appliedEdits.find((edit) => edit.status === 'failed');

  return {
    appliedEdits,
    repairSessionManifest: sessionManifest,
    repairStatus: firstFailure ? 'failed' : (touchedPaths.length > 0 ? 'planned' : 'not-needed'),
    repairDecisionReason: firstFailure
      ? `Autonomous repair edit application failed before promotion: ${firstFailure.path} — ${firstFailure.message}`
      : '',
    repairPromotedPaths: [],
    repairRollbackPaths: [],
    repairSmokeJobs: [],
    repairSmokeResults: [],
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

async function runShellCommand(
  command: string,
  cwd: string,
  options?: { timeoutMs?: number },
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const timeoutMs = options?.timeoutMs;
    const finish = (exitCode: number, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, output, timedOut });
    };

    let timeoutId: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        output += `\n[command timed out after ${timeoutMs}ms]`;
        child.kill('SIGTERM');
        finish(124, true);
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      output += `\n${error instanceof Error ? error.message : String(error)}`;
      if (timeoutId) clearTimeout(timeoutId);
      finish(1, false);
    });
    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      finish(typeof code === 'number' ? code : 1, false);
    });
  });
}

async function executePlannedJobs(
  state: ControlPlaneState,
  jobs: PlannedJob[],
  options?: { timeoutMs?: number },
): Promise<ExecutedJob[]> {
  const cwd = path.resolve(state.repoRoot);
  const executedJobs: ExecutedJob[] = [];
  let redisCloneDone = false;

  for (const job of jobs) {
    if (job.kind === 'note') {
      executedJobs.push({ ...job, status: 'skipped', exitCode: 0, output: job.command });
      continue;
    }

    if (job.kind === 'deploy' && !state.deployCommand.trim()) {
      const defaultDeploy = getDefaultDeployCommand(state);
      if (!defaultDeploy.trim()) {
        executedJobs.push({
          ...job,
          status: 'skipped',
          exitCode: 0,
          output: 'Deploy skipped because no deploy command was provided.',
        });
        continue;
      }
    }

    if (job.kind === 'deploy' && isUnsafeProductionDeployCommand(job.command)) {
      executedJobs.push({
        ...job,
        status: 'skipped',
        exitCode: 0,
        output: 'Deploy skipped because the command targeted the production AnyGPT service.',
      });
      continue;
    }

    if (!redisCloneDone && job.kind === 'test' && (job.target === 'api' || job.target === 'api-experimental')) {
      try {
        const cloneSummary = await cloneProductionRedisToExperimental();
        executedJobs.push({
          id: 'redis-clone',
          target: job.target,
          kind: 'note',
          title: 'Clone production Redis/Dragonfly DB into experimental DB',
          command: cloneSummary,
          status: 'success',
          exitCode: 0,
          output: cloneSummary,
        });
      } catch (error: any) {
        executedJobs.push({
          id: 'redis-clone',
          target: job.target,
          kind: 'note',
          title: 'Clone production Redis/Dragonfly DB into experimental DB',
          command: 'clone failed',
          status: 'failed',
          exitCode: 1,
          output: error?.stack || error?.message || String(error),
        });
        break;
      }
      redisCloneDone = true;
    }

    const result = await runShellCommand(job.command, cwd, options);
    executedJobs.push({
      ...job,
      status: result.exitCode === 0 ? 'success' : 'failed',
      exitCode: result.exitCode,
      output: result.output,
    });

    if (result.exitCode !== 0) {
      break;
    }
  }

  return executedJobs;
}

async function repairValidateNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const appliedPaths = getAppliedRepairPaths(state);
  if (appliedPaths.length === 0) {
    const notes = ['Repair smoke validation skipped because no autonomous repair edit was applied.'];
    return {
      repairSmokeJobs: [],
      repairSmokeResults: [],
      repairNotes: appendUniqueNotes(state.repairNotes, notes),
      plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
    };
  }

  const repairSmokeJobs = buildRepairSmokeJobs(state);
  const repairSmokeResults = await executePlannedJobs(state, repairSmokeJobs, { timeoutMs: REPAIR_SMOKE_TIMEOUT_MS });
  const notes = repairSmokeResults.length > 0
    ? repairSmokeResults.map((job) => `Repair smoke ${job.status}: ${job.title}${typeof job.exitCode === 'number' ? ` (exit ${job.exitCode})` : ''}`)
    : ['Repair smoke validation completed without executable jobs.'];

  return {
    repairSmokeJobs,
    repairSmokeResults,
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

async function repairEvaluateNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const appliedPaths = getAppliedRepairPaths(state);
  if (appliedPaths.length === 0) {
    return {};
  }

  const evaluationGatePolicy = resolveStateEvaluationGatePolicy(state);
  const langSmithConfig = resolveLangSmithRuntimeConfig();
  const smokeFailures = state.repairSmokeResults.filter((job) => job.status === 'failed');
  const smokePassed = !hasFailedExecutedJobs(state.repairSmokeResults);
  let nextEvaluations = state.langSmithEvaluations.map((evaluation) => LangSmithEvaluationSummarySchema.parse(evaluation));
  const notes: string[] = [];
  const repairToken = normalizePromptChannel(state.repairSessionManifest?.sessionId || state.threadId || 'repair') || 'repair';
  const repairProjectName = state.langSmithProjectName || langSmithConfig?.projectName || 'anygpt-control-plane';
  const repairDatasetName = `${repairProjectName}-control-plane-repair-${repairToken}`;

  if (langSmithConfig) {
    const repairDataset = await ensureLangSmithExamplesDataset(
      langSmithConfig,
      repairDatasetName,
      [
        {
          inputs: {
            goal: state.goal,
            repairIntent: state.repairIntentSummary,
            repairSignals: state.repairSignals,
            touchedFiles: appliedPaths,
            smokeFailureCount: smokeFailures.length,
          },
          outputs: {
            answer: smokePassed ? 'repair-smoke-passed' : 'repair-smoke-failed',
          },
          metadata: {
            source: 'control-plane-repair-eval',
            thread_id: state.threadId,
            repair_session_id: state.repairSessionManifest?.sessionId || '',
          },
        },
      ],
      {
        description: 'Runtime repair-loop smoke dataset',
      },
    ).catch(() => null);

    if (repairDataset?.name) {
      notes.push(`Repair evaluation dataset ready: ${repairDataset.name}`);
      const baselineRepairEvaluation = selectBaselineEvaluation(state.langSmithEvaluations, repairDataset.name);
      const evaluation = await runLangSmithDatasetEvaluation(
        langSmithConfig,
        repairDataset.name,
        async (inputs: Record<string, any>) => ({
          answer: [
            `goal=${String(inputs?.goal || '').trim()}`,
            `repair_intent=${String(inputs?.repairIntent || '').trim()}`,
            `touched_files=${appliedPaths.join(',') || 'none'}`,
            `smoke=${smokePassed ? 'passed' : 'failed'}`,
            `smoke_failures=${smokeFailures.length}`,
          ].join(' | '),
        }),
        `${repairProjectName}-control-plane-repair-eval`,
        [
          (run: any, example: any) => {
            const answer = String(run?.outputs?.answer || '');
            const goal = String(example?.inputs?.goal || '').trim();
            const goalAligned = goal ? answer.includes(`goal=${goal}`) : answer.includes('goal=');
            const repairGateScore = goalAligned && smokePassed ? 1 : 0;
            return [
              {
                key: evaluationGatePolicy.metricKey,
                score: repairGateScore,
                comment: `repair_smoke=${smokePassed ? 'passed' : 'failed'} touched=${appliedPaths.length}`,
              },
              {
                key: 'repair_smoke_passed',
                score: smokePassed ? 1 : 0,
                comment: `repair_smoke_failures=${smokeFailures.length}`,
              },
              {
                key: 'repair_touched_paths_tracked',
                score: appliedPaths.length > 0 ? 1 : 0,
                comment: `repair_touched_paths=${appliedPaths.join(',') || 'none'}`,
              },
            ];
          },
        ],
        {
          metadata: {
            ...state.observabilityMetadata,
            evaluation_kind: 'repair',
            evaluation_gate_status: state.evaluationGateResult.status,
            governance_gate_status: state.governanceGateResult.status,
            repair_session_id: state.repairSessionManifest?.sessionId || undefined,
            repair_touched_paths: appliedPaths,
            repair_smoke_failures: smokeFailures.length,
            repair_status: state.repairStatus,
          },
          scorecardName: `${evaluationGatePolicy.scorecardName}-repair`,
          aggregationMode: evaluationGatePolicy.aggregationMode,
          primaryMetricKey: evaluationGatePolicy.metricKey,
          requiredMetricKeys: uniqueNormalizedStrings([...evaluationGatePolicy.requiredMetricKeys, 'repair_smoke_passed']),
          metricThresholds: {
            [evaluationGatePolicy.metricKey]: evaluationGatePolicy.minMetricAverageScore,
            repair_smoke_passed: 1,
            ...evaluationGatePolicy.additionalMetricThresholds,
          },
          metricWeights: {
            repair_smoke_passed: 1,
            ...evaluationGatePolicy.metricWeights,
          },
          minimumWeightedScore: evaluationGatePolicy.minimumWeightedScore,
          baselineEvaluation: baselineRepairEvaluation
            ? {
                ...baselineRepairEvaluation,
                experimentName: baselineRepairEvaluation.experimentName || baselineRepairEvaluation.datasetName,
              }
            : undefined,
          baselineExperimentName: baselineRepairEvaluation?.experimentName || evaluationGatePolicy.baselineExperimentName || undefined,
        },
      ).catch(() => null);

      if (evaluation) {
        nextEvaluations = [...nextEvaluations, LangSmithEvaluationSummarySchema.parse(evaluation)];
        notes.push(`Repair evaluation recorded: ${evaluation.experimentName || repairDataset.name}`);
      }
    }
  } else {
    notes.push('Repair evaluation reused existing evaluation-gate state because LangSmith runtime integration is unavailable.');
  }

  const evaluationGateResult = resolveEvaluationGateResult(
    evaluationGatePolicy,
    nextEvaluations,
    state.langSmithEnabled || Boolean(langSmithConfig),
  );
  notes.push(`Repair evaluation gate: ${evaluationGateResult.reason}`);

  return {
    langSmithEvaluations: nextEvaluations,
    evaluationGateResult,
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

async function repairDecisionNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const appliedPaths = getAppliedRepairPaths(state);
  const smokeFailures = state.repairSmokeResults.filter((job) => job.status === 'failed');
  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  const governanceGateResult = resolveStateGovernanceGateResult(state);
  const browserValidation = evaluateBrowserValidationBundle(state);
  const autonomousLaneLabel = state.autonomousOperationMode === 'improvement' ? 'Improvement' : 'Repair';
  let repairStatus: RepairStatus = 'not-needed';
  let repairDecisionReason = state.autonomousOperationMode === 'improvement'
    ? 'No bounded improvement edit was applied, so no promotion or rollback was required.'
    : 'No autonomous repair edit was applied, so no promotion or rollback was required.';
  let repairPromotedPaths: string[] = [];

  if (appliedPaths.length === 0) {
    if (state.appliedEdits.some((edit) => edit.status === 'failed')) {
      repairStatus = 'failed';
      repairDecisionReason = state.repairDecisionReason || `Autonomous ${autonomousLaneLabel.toLowerCase()} edit application failed before any change could be promoted.`;
    }
  } else if (smokeFailures.length > 0) {
    repairStatus = 'failed';
    repairDecisionReason = `${autonomousLaneLabel} smoke validation failed: ${smokeFailures[0].title}${typeof smokeFailures[0].exitCode === 'number' ? ` (exit ${smokeFailures[0].exitCode})` : ''}`;
  } else if (governanceGateResult.blocksAutonomousEdits || governanceGateResult.blocksExecution) {
    repairStatus = 'failed';
    repairDecisionReason = `${autonomousLaneLabel} promotion blocked by the governance gate: ${governanceGateResult.reason}`;
  } else if (evaluationGateResult.blocksAutonomousEdits || evaluationGateResult.blocksExecution) {
    repairStatus = 'failed';
    repairDecisionReason = `${autonomousLaneLabel} promotion blocked by the evaluation gate: ${evaluationGateResult.reason}`;
  } else if (browserValidation.required && !browserValidation.passed) {
    repairStatus = 'failed';
    repairDecisionReason = browserValidation.reason;
  } else {
    repairStatus = 'promoted';
    repairPromotedPaths = appliedPaths;
    repairDecisionReason = `${autonomousLaneLabel} promoted after ${state.repairSmokeResults.filter((job) => job.status === 'success').length} successful smoke job(s) and evaluation gate status ${evaluationGateResult.status}.`;
  }

  return {
    repairStatus,
    repairDecisionReason,
    repairPromotedPaths,
    evidenceStatus: browserValidation.status,
    validationRequired: browserValidation.required,
    deferReason: browserValidation.required && !browserValidation.passed ? browserValidation.reason : state.deferReason,
    repairNotes: appendUniqueNotes(state.repairNotes, [repairDecisionReason]),
    plannerNotes: appendUniqueNotes(state.plannerNotes, [repairDecisionReason]),
  };
}

async function postRepairValidateNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!shouldRunPostRepairValidation(state)) {
    return {
      postRepairValidationJobs: [],
      postRepairValidationResults: [],
      postRepairValidationStatus: 'not-needed',
    };
  }

  const postRepairValidationJobs = buildPostRepairValidationJobs(state);
  const postRepairValidationResults = await executePlannedJobs(
    state,
    postRepairValidationJobs,
    { timeoutMs: POST_REPAIR_VALIDATION_TIMEOUT_MS },
  );
  const failures = postRepairValidationResults.filter((job) => job.status === 'failed');
  const postRepairValidationStatus: PostRepairValidationStatus = failures.length > 0 ? 'failed' : 'passed';
  const validationReason = failures.length > 0
    ? `Post-repair validation failed: ${failures[0].title}${typeof failures[0].exitCode === 'number' ? ` (exit ${failures[0].exitCode})` : ''}`
    : `Post-repair validation passed with ${postRepairValidationResults.filter((job) => job.status === 'success').length} successful job(s).`;
  const notes = postRepairValidationResults.length > 0
    ? postRepairValidationResults.map((job) => `Post-repair validation ${job.status}: ${job.title}${typeof job.exitCode === 'number' ? ` (exit ${job.exitCode})` : ''}`)
    : ['Post-repair validation completed without executable jobs.'];
  notes.push(validationReason);

  return {
    postRepairValidationJobs,
    postRepairValidationResults,
    postRepairValidationStatus,
    repairStatus: failures.length > 0 ? 'failed' : state.repairStatus,
    repairDecisionReason: failures.length > 0 ? validationReason : state.repairDecisionReason,
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

async function restartExperimentalServiceNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const touchesApiCode = getRepairTouchedPaths(state).some((candidatePath) => candidatePath.startsWith('apps/api/'));
  if (!touchesApiCode || state.repairStatus !== 'promoted') {
    return {
      experimentalRestartStatus: 'not-needed',
      experimentalRestartReason: '',
    };
  }

  if (!state.autonomous) {
    const reason = 'Experimental auto-restart is reserved for autonomous runs; manual runs keep restart decisions operator-controlled.';
    return {
      experimentalRestartStatus: 'skipped',
      experimentalRestartReason: reason,
      repairNotes: appendUniqueNotes(state.repairNotes, [reason]),
      plannerNotes: appendUniqueNotes(state.plannerNotes, [reason]),
    };
  }

  if (state.postRepairValidationStatus !== 'passed') {
    const reason = state.postRepairValidationStatus === 'failed'
      ? 'Experimental restart skipped because post-repair validation failed.'
      : 'Experimental restart skipped because post-repair validation did not complete.';
    return {
      experimentalRestartStatus: 'skipped',
      experimentalRestartReason: reason,
      repairNotes: appendUniqueNotes(state.repairNotes, [reason]),
      plannerNotes: appendUniqueNotes(state.plannerNotes, [reason]),
    };
  }

  if (!AUTO_RESTART_EXPERIMENTAL_AFTER_REPAIR) {
    const reason = 'Experimental auto-restart skipped because CONTROL_PLANE_AUTO_RESTART_EXPERIMENTAL=false.';
    return {
      experimentalRestartStatus: 'skipped',
      experimentalRestartReason: reason,
      repairNotes: appendUniqueNotes(state.repairNotes, [reason]),
      plannerNotes: appendUniqueNotes(state.plannerNotes, [reason]),
    };
  }

  if (AUTO_RESTART_EXPERIMENTAL_REQUIRE_IDLE) {
    const activeClients = await listActiveExperimentalClientConnections(state);
    if (activeClients.length > 0) {
      const port = resolveExperimentalApiPort(state.experimentalApiBaseUrl);
      const clientSummary = activeClients
        .map((client) => `${client.command || 'process'}(pid=${client.pid})`)
        .join(', ');
      const reason = `Experimental auto-restart deferred because active client connections were detected on port ${port}: ${clientSummary}. This avoids interrupting in-flight DeepAgents/LangGraph sessions; the autonomous loop can retry on a later idle iteration.`;
      return {
        experimentalRestartStatus: 'skipped',
        experimentalRestartReason: reason,
        repairNotes: appendUniqueNotes(state.repairNotes, [reason]),
        plannerNotes: appendUniqueNotes(state.plannerNotes, [reason]),
      };
    }
  }

  const restartJob: PlannedJob = {
    id: 'restart-experimental-service',
    target: 'api-experimental',
    kind: 'deploy',
    title: 'Restart experimental AnyGPT service',
    command: SAFE_EXPERIMENTAL_DEPLOY_COMMAND,
  };
  const restartResults = await executePlannedJobs(
    state,
    [restartJob],
    { timeoutMs: POST_REPAIR_VALIDATION_TIMEOUT_MS },
  );
  const restartResult = restartResults[0];
  const experimentalRestartStatus: ExperimentalRestartStatus = !restartResult
    ? 'failed'
    : restartResult.status === 'success'
      ? 'success'
      : restartResult.status === 'skipped'
        ? 'skipped'
        : 'failed';
  const experimentalRestartReason = experimentalRestartStatus === 'success'
    ? 'Experimental AnyGPT service restarted after passing post-repair validation.'
    : restartResult
      ? `Experimental AnyGPT service restart ${restartResult.status}: ${restartResult.title}${typeof restartResult.exitCode === 'number' ? ` (exit ${restartResult.exitCode})` : ''}`
      : 'Experimental AnyGPT service restart did not run.';
  const notes = restartResult
    ? [`Experimental restart ${restartResult.status}: ${restartResult.title}${typeof restartResult.exitCode === 'number' ? ` (exit ${restartResult.exitCode})` : ''}`, experimentalRestartReason]
    : [experimentalRestartReason];

  return {
    experimentalRestartStatus,
    experimentalRestartReason,
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

async function restartProductionServiceNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const touchesApiCode = getRepairTouchedPaths(state).some((candidatePath) => candidatePath.startsWith('apps/api/'));
  if (!touchesApiCode || state.repairStatus !== 'promoted') {
    return {
      productionRestartStatus: 'not-needed',
      productionRestartReason: '',
    };
  }

  if (!state.autonomous) {
    const reason = 'Production auto-restart is reserved for autonomous runs; manual runs keep restart decisions operator-controlled.';
    return {
      productionRestartStatus: 'skipped',
      productionRestartReason: reason,
      repairNotes: appendUniqueNotes(state.repairNotes, [reason]),
      plannerNotes: appendUniqueNotes(state.plannerNotes, [reason]),
    };
  }

  if (state.postRepairValidationStatus !== 'passed') {
    const reason = state.postRepairValidationStatus === 'failed'
      ? 'Production auto-restart skipped because post-repair validation failed.'
      : 'Production auto-restart skipped because post-repair validation did not complete.';
    return {
      productionRestartStatus: 'skipped',
      productionRestartReason: reason,
      repairNotes: appendUniqueNotes(state.repairNotes, [reason]),
      plannerNotes: appendUniqueNotes(state.plannerNotes, [reason]),
    };
  }

  if (!AUTO_RESTART_PRODUCTION_AFTER_REPAIR) {
    const reason = 'Production auto-restart skipped because CONTROL_PLANE_AUTO_RESTART_PRODUCTION=false.';
    return {
      productionRestartStatus: 'skipped',
      productionRestartReason: reason,
      repairNotes: appendUniqueNotes(state.repairNotes, [reason]),
      plannerNotes: appendUniqueNotes(state.plannerNotes, [reason]),
    };
  }

  const restartJob: PlannedJob = {
    id: 'restart-production-service',
    target: 'api-production',
    kind: 'deploy',
    title: `Restart production AnyGPT service (${state.productionServiceName || 'anygpt.service'})`,
    command: SAFE_PRODUCTION_DEPLOY_COMMAND,
  };
  const restartResults = await executePlannedJobs(
    state,
    [restartJob],
    { timeoutMs: POST_REPAIR_VALIDATION_TIMEOUT_MS },
  );
  const restartResult = restartResults[0];
  const productionRestartStatus: z.infer<typeof ProductionRestartStatusSchema> = !restartResult
    ? 'failed'
    : restartResult.status === 'success'
      ? 'success'
      : restartResult.status === 'skipped'
        ? 'skipped'
        : 'failed';
  const productionRestartReason = productionRestartStatus === 'success'
    ? `Production AnyGPT service (${state.productionServiceName || 'anygpt.service'}) restarted after passing post-repair validation.`
    : restartResult
      ? `Production AnyGPT service restart ${restartResult.status}: ${restartResult.title}${typeof restartResult.exitCode === 'number' ? ` (exit ${restartResult.exitCode})` : ''}`
      : 'Production AnyGPT service restart did not run.';
  const notes = restartResult
    ? [`Production restart ${restartResult.status}: ${restartResult.title}${typeof restartResult.exitCode === 'number' ? ` (exit ${restartResult.exitCode})` : ''}`, productionRestartReason]
    : [productionRestartReason];

  return {
    productionRestartStatus,
    productionRestartReason,
    repairNotes: appendUniqueNotes(state.repairNotes, notes),
    plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
  };
}

function findLatestAiFailureMessage(state: Pick<
  ControlPlaneState,
  'plannerNotes' | 'repairNotes'
>): string {
  const notes = [...state.repairNotes, ...state.plannerNotes].map((entry) => String(entry || '').trim()).filter(Boolean).reverse();
  for (const note of notes) {
    const match = note.match(/AI [^:]+ unavailable:\s*(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function deriveLaneHealthSnapshot(
  state: Pick<
    ControlPlaneState,
    | 'goal'
    | 'scopes'
    | 'effectiveScopes'
    | 'repairStatus'
    | 'repairDecisionReason'
    | 'repairSignals'
    | 'improvementSignals'
    | 'plannerNotes'
    | 'repairNotes'
    | 'evidenceStatus'
    | 'lastAiFailureClass'
    | 'validationRequired'
    | 'executedMcpActions'
    | 'appliedEdits'
    | 'repairPromotedPaths'
    | 'repairRollbackPaths'
  >,
): {
  healthClass: HealthClass;
  deferReason: string;
  evidenceStatus: EvidenceStatus;
  lastAiFailureClass: AiFailureClass;
  validationRequired: boolean;
} {
  const browserValidation = evaluateBrowserValidationBundle(state);
  const evidenceStatus = browserValidation.required
    ? browserValidation.status
    : (state.evidenceStatus === 'unknown' && getEffectiveScopes(state as ControlPlaneState).includes('research-scout'))
      ? (
          state.executedMcpActions.some((action) => action.server === 'playwright' && action.status === 'success')
            ? 'collected'
            : state.executedMcpActions.some((action) => action.server === 'brave-search' && action.status === 'success')
              ? 'planned'
              : 'missing'
        )
      : state.evidenceStatus;
  const validationRequired = browserValidation.required || state.validationRequired;
  const inferredAiFailureClass = state.lastAiFailureClass !== 'none'
    ? state.lastAiFailureClass
    : classifyAiFailureMessage(findLatestAiFailureMessage(state));

  const sourceText = [
    state.goal,
    state.repairDecisionReason,
    ...state.repairSignals,
    ...state.improvementSignals,
    ...state.plannerNotes,
    ...state.repairNotes,
  ].join(' | ').toLowerCase();
  const externalBlocked = /out of scope|blocked subsystem|scope-blocked|blocked_external/.test(sourceText)
    || signalTextHasProviderAuthDriftFocus(sourceText)
    || /provider-bound|retrying the same .* unlikely|billing_not_active|insufficient_quota|invalid_api_key/.test(sourceText);

  if (state.repairStatus === 'promoted') {
    return {
      healthClass: 'healthy',
      deferReason: state.repairDecisionReason,
      evidenceStatus: validationRequired ? 'validated' : (evidenceStatus === 'unknown' ? 'not-required' : evidenceStatus),
      lastAiFailureClass: inferredAiFailureClass,
      validationRequired,
    };
  }

  if (validationRequired && evidenceStatus !== 'validated') {
    return {
      healthClass: 'waiting_evidence',
      deferReason: browserValidation.reason || state.repairDecisionReason,
      evidenceStatus,
      lastAiFailureClass: inferredAiFailureClass,
      validationRequired,
    };
  }

  if (externalBlocked) {
    return {
      healthClass: 'blocked_external',
      deferReason: state.repairDecisionReason || 'The active lane is currently blocked by an external dependency or out-of-scope subsystem.',
      evidenceStatus,
      lastAiFailureClass: inferredAiFailureClass,
      validationRequired,
    };
  }

  if (state.repairStatus === 'failed' || state.repairStatus === 'rolled-back') {
    return {
      healthClass: 'failed',
      deferReason: state.repairDecisionReason,
      evidenceStatus,
      lastAiFailureClass: inferredAiFailureClass,
      validationRequired,
    };
  }

  if (inferredAiFailureClass !== 'none' || /no-progress guard/i.test(sourceText)) {
    return {
      healthClass: 'degraded',
      deferReason: state.repairDecisionReason,
      evidenceStatus,
      lastAiFailureClass: inferredAiFailureClass,
      validationRequired,
    };
  }

  return {
    healthClass: 'healthy',
    deferReason: state.repairDecisionReason,
    evidenceStatus: validationRequired ? 'validated' : (evidenceStatus === 'unknown' ? 'not-required' : evidenceStatus),
    lastAiFailureClass: inferredAiFailureClass,
    validationRequired,
  };
}

function shouldContinueAfterRepairDecision(state: ControlPlaneState): 'rollbackRepair' | 'runJobs' | 'summarize' {
  const touchedPaths = getRepairTouchedPaths(state);
  if (state.repairStatus === 'failed') {
    return touchedPaths.length > 0 ? 'rollbackRepair' : 'summarize';
  }
  if (state.repairStatus === 'promoted' || state.repairStatus === 'not-needed') {
    return shouldRunJobsForState(state) ? 'runJobs' : 'summarize';
  }
  if (state.repairStatus === 'rolled-back') {
    return 'summarize';
  }
  return 'summarize';
}

async function rollbackRepairNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!state.repairSessionManifest) {
    const notes = ['Repair rollback could not run because no autonomous edit session manifest was recorded.'];
    return {
      repairStatus: 'failed',
      repairNotes: appendUniqueNotes(state.repairNotes, notes),
      plannerNotes: appendUniqueNotes(state.plannerNotes, notes),
    };
  }

  const rollbackResult = rollbackAutonomousEditSession(
    state.repoRoot,
    state.repairSessionManifest,
    state.editAllowlist,
    state.editDenylist,
  );
  const notes = rollbackResult.notes.length > 0
    ? rollbackResult.notes
    : ['Repair rollback completed without additional notes.'];

  const rollbackDecisionReason = rollbackResult.status === 'rolled-back'
    ? `${state.repairDecisionReason || 'Repair rollback applied.'} Rollback restored ${rollbackResult.restoredPaths.length} path(s).`
    : `${state.repairDecisionReason || 'Repair rollback failed.'} ${rollbackResult.failedPaths.length} path(s) could not be restored.`;

  return {
    repairSessionManifest: rollbackResult.sessionManifest,
    repairStatus: rollbackResult.status === 'rolled-back' ? 'rolled-back' : 'failed',
    repairRollbackPaths: rollbackResult.restoredPaths,
    repairDecisionReason: rollbackDecisionReason,
    postRepairValidationStatus: state.postRepairValidationStatus,
    postRepairValidationJobs: rollbackResult.status === 'rolled-back'
      ? [...state.postRepairValidationJobs, buildNoteJob('rollback-validation', 'Rollback validation', 'Rollback completed and files were restored.')]
      : state.postRepairValidationJobs,
    postRepairValidationResults: rollbackResult.status === 'rolled-back'
      ? [...state.postRepairValidationResults, {
          id: 'rollback-validation',
          target: 'control-plane',
          kind: 'note',
          title: 'Rollback validation',
          command: 'Rollback completed and files were restored.',
          status: 'success',
          exitCode: 0,
          output: rollbackDecisionReason,
        }]
      : state.postRepairValidationResults,
    repairNotes: appendUniqueNotes(state.repairNotes, [...notes, rollbackDecisionReason]),
    plannerNotes: appendUniqueNotes(state.plannerNotes, [...notes, rollbackDecisionReason]),
  };
}

async function mergePlanNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const noteJobs = state.plannerNotes.map((note, index) => buildNoteJob(`note-${index + 1}`, `Planner note ${index + 1}`, note));
  const mcpJobs = state.mcpServers.map((server) => {
    const inspection = state.mcpInspections.find((entry) => entry.server === server.name);
    const toolNames = inspection?.tools.map((tool) => tool.name).join(',') || 'none';
    return buildNoteJob(
      `mcp-${server.name}`,
      `MCP server ${server.name}`,
      `status=${inspection?.status || 'skipped'} command=${server.command} args=${server.args.join(' ')} envKeys=${server.envKeys.join(',') || 'none'} tools=${toolNames} alwaysAllow=${server.alwaysAllow.join(',') || 'none'} disabled=${server.disabled ? 'true' : 'false'} message=${inspection?.message || 'No inspection result.'}`,
    );
  });
  const plannedMcpActionJobs = state.plannedMcpActions.map((action) => buildNoteJob(
    `planned-mcp-action-${action.id}`,
    `Planned MCP action ${action.server}.${action.tool}`,
    `${action.title} risk=${action.risk}${action.alwaysAllow ? ' alwaysAllow=true' : ''} args=${JSON.stringify(action.arguments)} reason=${action.reason}`,
  ));
  const autonomousEditJobs = state.proposedEdits.map((edit, index) => buildNoteJob(
    `autonomous-edit-${index + 1}`,
    `Autonomous edit ${index + 1}`,
    `${edit.type} ${edit.path} reason=${edit.reason}`,
  ));
  const governanceFlagJobs = (state.langSmithGovernance?.flags || [])
    .filter((flag) => flag.status !== 'pass')
    .map((flag) => buildNoteJob(
      `langsmith-governance-flag-${flag.key}`,
      `LangSmith governance flag ${flag.key}`,
      `${flag.status}: ${flag.summary}`,
    ));
  const governanceMutationJobs = (state.langSmithGovernance?.mutations || []).map((mutation) => buildNoteJob(
    `langsmith-governance-mutation-${mutation.key}`,
    `LangSmith governance mutation ${mutation.key}`,
    `${mutation.status}: ${mutation.summary}`,
  ));

  return {
    jobs: [
      ...noteJobs,
      ...mcpJobs,
      ...plannedMcpActionJobs,
      ...governanceFlagJobs,
      ...governanceMutationJobs,
      ...(state.autonomousEditReviewDecision === 'rejected' ? [] : autonomousEditJobs),
      ...state.buildJobs,
      ...state.testJobs,
      ...state.deployJobs,
    ],
  };
}

function shouldExecuteNode(state: ControlPlaneState): 'approvalGate' | 'summarize' {
  if (!state.executePlan) return 'summarize';
  return shouldRunMcpActionsForState(state) || shouldApplyAutonomousEditsForState(state) || shouldRunJobsForState(state)
    ? 'approvalGate'
    : 'summarize';
}

function shouldContinueAfterApproval(state: ControlPlaneState): 'runMcpActions' | 'applyAutonomousEdits' | 'runJobs' | 'summarize' {
  if (state.approvalGranted === false) return 'summarize';
  if (shouldRunMcpActionsForState(state)) return 'runMcpActions';
  if (shouldApplyAutonomousEditsForState(state)) return 'applyAutonomousEdits';
  if (shouldRunJobsForState(state)) return 'runJobs';
  return 'summarize';
}

function shouldContinueAfterMcpActions(state: ControlPlaneState): 'applyAutonomousEdits' | 'runJobs' | 'summarize' {
  if (shouldApplyAutonomousEditsForState(state)) return 'applyAutonomousEdits';
  if (shouldRunJobsForState(state)) return 'runJobs';
  return 'summarize';
}

function shouldContinueAfterAutonomousEdits(state: ControlPlaneState): 'repairValidate' | 'rollbackRepair' | 'runJobs' | 'summarize' {
  const touchedPaths = getRepairTouchedPaths(state);
  if (state.appliedEdits.some((edit) => edit.status === 'failed')) {
    return touchedPaths.length > 0 ? 'rollbackRepair' : 'summarize';
  }
  if (getAppliedRepairPaths(state).length > 0) return 'repairValidate';
  return shouldRunJobsForState(state) ? 'runJobs' : 'summarize';
}

async function runJobsNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  if (!shouldRunJobsForState(state)) {
    return { executedJobs: [] };
  }

  const executedJobs = await executePlannedJobs(state, state.jobs);
  return { executedJobs };
}

async function summarizeNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const jobs = state.executePlan
    ? (state.executedJobs.length > 0 ? state.executedJobs : state.jobs)
    : state.jobs;
  const evaluationGatePolicy = resolveStateEvaluationGatePolicy(state);
  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  const blockedActions = describeEvaluationGateBlockedActions(evaluationGateResult);
  const governanceGateResult = resolveStateGovernanceGateResult(state);
  const governanceBlockedActions = describeGovernanceGateBlockedActions(governanceGateResult);
  const requestedScopes = uniqueScopes(state.scopes);
  const effectiveScopes = getEffectiveScopes(state);
  const laneHealth = deriveLaneHealthSnapshot(state);
  const lines: string[] = [];
  lines.push(`Goal: ${state.goal}`);
  lines.push(`Requested scopes: ${requestedScopes.join(', ')}`);
  lines.push(`Effective scopes: ${effectiveScopes.join(', ')}`);
  if (state.scopeExpansionReason.trim()) {
    lines.push(`Adaptive scope expansion: ${state.scopeExpansionReason}`);
  }
  if (state.threadId.trim()) {
    lines.push(`Thread: ${state.threadId}`);
  }
  lines.push(
    state.aiAgentEnabled
      ? `AI agents: enabled (${state.aiAgentModel || 'configured model'} via ${state.aiAgentBackend || 'configured base URL'})`
      : 'AI agents: disabled (set CONTROL_PLANE_AI_BASE_URL/KEY/MODEL or provide ANYGPT_API_KEY; local AnyGPT fallback will be used when available)',
  );
  lines.push(`Lane health: ${laneHealth.healthClass}`);
  lines.push(`Evidence status: ${laneHealth.evidenceStatus}${laneHealth.validationRequired ? ' (validation required)' : ''}`);
  if (laneHealth.lastAiFailureClass !== 'none') {
    lines.push(`Last AI failure class: ${laneHealth.lastAiFailureClass}`);
  }
  if (laneHealth.deferReason.trim()) {
    lines.push(`Defer reason: ${laneHealth.deferReason}`);
  }
  lines.push(`Experimental target: ${state.experimentalApiBaseUrl || 'http://127.0.0.1:3310'} via ${state.experimentalServiceName || 'anygpt-experimental.service'}`);
  lines.push(
    state.selectedPromptSource === 'local'
      ? `Prompt bundle: local fallback (${state.promptIdentifier || DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER})${state.selectedPromptChannel ? ` via ${state.selectedPromptChannel}` : ''}`
      : `Prompt bundle: ${state.selectedPromptSource} selection ${state.selectedPromptReference || state.promptIdentifier || DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER}${state.selectedPromptCommitHash ? ` @ ${state.selectedPromptCommitHash}` : ''}${state.selectedPromptChannel ? ` via ${state.selectedPromptChannel}` : ''}`,
  );
  if (state.selectedPromptAvailableChannels.length > 0) {
    lines.push(`Prompt channels: ${state.selectedPromptAvailableChannels.join(', ')}`);
  }
  if (state.promptRollbackReference.trim()) {
    lines.push(`Prompt rollback: ${state.promptRollbackReference}`);
  }
  lines.push(
    state.promptSyncEnabled
      ? `Prompt sync: ${state.promptSyncUrl || `${buildLangSmithPromptReference(state.promptIdentifier, state.promptSyncChannel)}${state.langSmithEnabled ? ' (no URL returned)' : ' (LangSmith disabled)'}`}`
      : 'Prompt sync: disabled',
  );
  if (state.promptPromoteChannel.trim()) {
    lines.push(
      state.promptPromotionUrl
        ? `Prompt promotion: ${buildLangSmithPromptReference(state.promptIdentifier, state.promptPromoteChannel)} -> ${state.promptPromotionUrl}`
        : `Prompt promotion: requested for ${buildLangSmithPromptReference(state.promptIdentifier, state.promptPromoteChannel)} but not completed`,
    );
  }
  if (state.promptPromotionReason.trim()) {
    lines.push(`Prompt promotion reason: ${state.promptPromotionReason}`);
  }
  if (state.promptPromotionBlockedReason.trim()) {
    lines.push(`Prompt promotion blocked: ${state.promptPromotionBlockedReason}`);
  }
  lines.push(
    state.langSmithEnabled
      ? `LangSmith: workspace ${state.langSmithWorkspace?.displayName || 'unknown'}, project ${state.langSmithProjectName || 'unset'}, ${state.langSmithProjects.length} project(s), ${state.langSmithDatasets.length} dataset(s), ${state.langSmithPrompts.length} prompt(s), ${state.langSmithRuns.length} recent run(s), ${state.langSmithAnnotationQueues.length} annotation queue(s), ${state.langSmithFeedback.length} feedback item(s)`
      : 'LangSmith: runtime integration disabled',
  );
  lines.push(`Governance profile: ${resolveControlPlaneGovernanceProfile(state.repoRoot).name}`);
  if (state.langSmithAccessibleWorkspaces.length > 0) {
    lines.push(`LangSmith accessible workspaces: ${state.langSmithAccessibleWorkspaces.map((workspace) => `${workspace.displayName}${workspace.roleName ? ` (${workspace.roleName})` : ''}`).join(', ')}`);
  }
  if (state.langSmithProject) {
    const metadataKeys = Object.keys(state.langSmithProject.metadata || {});
    lines.push(`LangSmith project admin: ${state.langSmithProject.name}${state.langSmithProject.description ? ` — ${state.langSmithProject.description}` : ''}${metadataKeys.length > 0 ? ` [metadata: ${metadataKeys.join(', ')}]` : ''}`);
  }
  if (state.langSmithRuns.length > 0) {
    lines.push(`LangSmith recent runs: ${state.langSmithRuns.slice(0, 3).map((run) => `${run.name}${run.traceId ? ` trace=${run.traceId}` : ''}${run.threadId ? ` thread=${run.threadId}` : ''}${Array.isArray(run.tags) && run.tags.length > 0 ? ` tags=${run.tags.join('|')}` : ''}`).join(' ; ')}`);
  }
  if (state.langSmithAnnotationQueues.length > 0) {
    lines.push(`LangSmith annotation queues: ${state.langSmithAnnotationQueues.map((queue) => `${queue.name}${typeof queue.itemCount === 'number' ? ` (${queue.itemCount})` : ''}`).join(', ')}`);
  }
  if (state.langSmithAnnotationQueueItems.length > 0) {
    lines.push(`LangSmith queue samples: ${state.langSmithAnnotationQueueItems.slice(0, 5).map((item) => item.runName || item.runId || item.id).join(', ')}`);
  }
  if (state.langSmithFeedback.length > 0) {
    lines.push(`LangSmith feedback: ${state.langSmithFeedback.slice(0, 5).map((item) => `${item.key}${typeof item.score !== 'undefined' && item.score !== null ? `=${item.score}` : ''}`).join(', ')}`);
  }
  if (state.langSmithEvaluations.length > 0) {
    lines.push(`LangSmith evaluations: ${state.langSmithEvaluations.map((item) => item.experimentName ? `${item.datasetName} (${item.experimentName})` : item.datasetName).join(', ')}`);
    const metricSummaries = state.langSmithEvaluations
      .flatMap((item) => item.metrics.map((metric) => `${metric.key}=${metric.averageScore ?? 'n/a'}x${metric.count}`))
      .filter(Boolean);
    if (metricSummaries.length > 0) {
      lines.push(`LangSmith evaluation metrics: ${metricSummaries.join(', ')}`);
    }
  }
  if (state.langSmithGovernance) {
    const actionableFlags = state.langSmithGovernance.flags.filter((flag) => flag.status !== 'pass');
    lines.push(`LangSmith governance: ${state.langSmithGovernance.counts.workspaces} workspace(s), ${state.langSmithGovernance.counts.projects} project(s), ${state.langSmithGovernance.counts.runFailures} recent failed run(s), ${state.langSmithGovernance.counts.annotationQueueBacklog} queued review item(s), ${actionableFlags.length} actionable flag(s)`);
    if (state.langSmithGovernance.feedbackKeyCounts.length > 0) {
      lines.push(`LangSmith feedback keys: ${state.langSmithGovernance.feedbackKeyCounts.map((entry) => `${entry.key} x${entry.count}`).join(', ')}`);
    }
    if (actionableFlags.length > 0) {
      lines.push(`LangSmith governance flags: ${actionableFlags.slice(0, 5).map((flag) => `${flag.key}=${flag.status}`).join(', ')}`);
    }
    if (state.langSmithGovernance.mutations.length > 0) {
      lines.push(`LangSmith governance mutations: ${state.langSmithGovernance.mutations.map((mutation) => `${mutation.key}=${mutation.status}`).join(', ')}`);
    }
  }
  lines.push(`Evaluation gate: ${evaluationGateResult.status} (${evaluationGatePolicy.mode}, target=${evaluationGatePolicy.target}, metric=${evaluationGatePolicy.metricKey}, min_avg=${evaluationGatePolicy.minMetricAverageScore}, min_results=${evaluationGatePolicy.minResultCount})`);
  if (evaluationGateResult.metricCount > 0 || evaluationGateResult.metricAverageScore !== null) {
    lines.push(`Evaluation metric ${evaluationGatePolicy.metricKey}: ${evaluationGateResult.metricAverageScore ?? 'n/a'} across ${evaluationGateResult.metricCount} scored result(s)`);
  }
  if (evaluationGateResult.aggregationMode === 'weighted') {
    lines.push(`Evaluation weighted score: ${evaluationGateResult.weightedAverageScore ?? 'n/a'} (min=${evaluationGateResult.minimumWeightedScore ?? 'n/a'})`);
  }
  if (evaluationGateResult.metricResults.length > 1) {
    lines.push(`Evaluation scorecard: ${evaluationGateResult.metricResults.map((metric) => `${metric.key}=${metric.averageScore ?? 'n/a'}x${metric.count}${metric.required ? `/${metric.minAverageScore}` : ''}`).join(', ')}`);
  }
  if (evaluationGateResult.baselineExperimentName.trim()) {
    lines.push(`Evaluation baseline: ${evaluationGateResult.baselineExperimentName}`);
  }
  if (evaluationGateResult.comparisonUrl.trim()) {
    lines.push(`Evaluation comparison: ${evaluationGateResult.comparisonUrl}`);
  }
  if (evaluationGateResult.reason.trim()) {
    lines.push(`Evaluation gate reason: ${evaluationGateResult.reason}`);
  }
  if (blockedActions.length > 0) {
    lines.push(`Evaluation gate blocked: ${blockedActions.join(', ')}`);
  }
  lines.push(`Governance gate: ${governanceGateResult.status} (target=${governanceGateResult.target})`);
  if (governanceGateResult.reason.trim()) {
    lines.push(`Governance gate reason: ${governanceGateResult.reason}`);
  }
  if (governanceBlockedActions.length > 0) {
    lines.push(`Governance gate blocked: ${governanceBlockedActions.join(', ')}`);
  }
  if (state.observabilityTags.length > 0) {
    lines.push(`Observability tags: ${state.observabilityTags.join(', ')}`);
  }
  if (state.repairIntentSummary.trim()) {
    lines.push(`Repair intent: ${state.repairIntentSummary}`);
  }
  if (state.repairSignals.length > 0) {
    lines.push(`Repair signals: ${state.repairSignals.slice(0, 5).join(' | ')}`);
  }
  if (state.improvementIntentSummary.trim()) {
    lines.push(`Improvement intent: ${state.improvementIntentSummary}`);
  }
  if (state.improvementSignals.length > 0) {
    lines.push(`Improvement signals: ${state.improvementSignals.slice(0, 5).join(' | ')}`);
  }
  if (state.autonomousContractSummary.trim()) {
    lines.push(`Autonomous contract: ${state.autonomousContractSummary}`);
  }
  if (state.autonomousContractChecks.length > 0) {
    lines.push(`Autonomous contract checks: ${state.autonomousContractChecks.join(' | ')}`);
  }
  if (state.autonomousContractPaths.length > 0) {
    lines.push(`Autonomous contract paths: ${state.autonomousContractPaths.join(', ')}`);
  }
  if (state.autonomousEditEnabled) {
    lines.push(`Autonomous loop: ${state.autonomousOperationMode}/${state.repairStatus}${state.repairDecisionReason.trim() ? ` — ${state.repairDecisionReason}` : ''}`);
    if (state.autonomousPlannerAgentCount > 0) {
      lines.push(`Autonomous planner: ${state.autonomousPlannerAgentCount} agent(s)${state.autonomousPlannerStrategy.trim() ? ` via ${state.autonomousPlannerStrategy}` : ''}`);
    }
    if (state.autonomousPlannerFocuses.length > 0) {
      lines.push(`Autonomous planner focuses: ${state.autonomousPlannerFocuses.join(' | ')}`);
    }
    if (state.repairSessionManifest?.sessionId) {
      lines.push(`Repair session: ${state.repairSessionManifest.sessionId} (rollback=${state.repairSessionManifest.rollbackStatus})`);
    }
    const touchedPaths = getRepairTouchedPaths(state);
    if (touchedPaths.length > 0) {
      lines.push(`Repair touched paths: ${touchedPaths.join(', ')}`);
    }
    if (state.repairSmokeResults.length > 0) {
      lines.push(`Repair smoke validation: ${state.repairSmokeResults.map((job) => `${job.title}=${job.status}${typeof job.exitCode === 'number' ? `(${job.exitCode})` : ''}`).join('; ')}`);
    }
    if (state.postRepairValidationStatus !== 'not-needed') {
      lines.push(`Post-repair validation: ${state.postRepairValidationStatus}${state.postRepairValidationResults.length > 0 ? ` — ${state.postRepairValidationResults.map((job) => `${job.title}=${job.status}${typeof job.exitCode === 'number' ? `(${job.exitCode})` : ''}`).join('; ')}` : ''}`);
    }
    if (state.repairPromotedPaths.length > 0) {
      lines.push(`Repair promoted paths: ${state.repairPromotedPaths.join(', ')}`);
    }
    if (state.repairRollbackPaths.length > 0) {
      lines.push(`Repair rollback paths: ${state.repairRollbackPaths.join(', ')}`);
    }
    if (state.experimentalRestartStatus !== 'not-needed') {
      lines.push(`Experimental restart: ${state.experimentalRestartStatus}${state.experimentalRestartReason.trim() ? ` — ${state.experimentalRestartReason}` : ''}`);
    }
    if (state.productionRestartStatus !== 'not-needed') {
      lines.push(`Production restart: ${state.productionRestartStatus}${state.productionRestartReason.trim() ? ` — ${state.productionRestartReason}` : ''}`);
    }
  }
  lines.push(
    state.autonomousEditEnabled
      ? `Autonomous edits: enabled (${state.autonomousOperationMode}, ${state.proposedEdits.length} proposed, ${state.appliedEdits.filter((edit) => edit.status === 'applied').length} applied${evaluationGateResult.blocksAutonomousEdits ? ', blocked by evaluation gate' : ''}${governanceGateResult.blocksAutonomousEdits ? ', blocked by governance gate' : ''}, status=${state.repairStatus})`
      : 'Autonomous edits: disabled',
  );
  if (state.autonomousEditEnabled && state.autonomousEditReviewDecision === 'rejected' && state.autonomousEditReviewReason.trim()) {
    lines.push(`Autonomous edit review: rejected — ${state.autonomousEditReviewReason}`);
  }
  lines.push(`Execution mode: ${state.executePlan ? 'execute' : 'plan-only'}`);
  if (state.approvalMessage.trim()) {
    lines.push(`Approval: ${state.approvalMessage}`);
  }
  if (state.autonomousEditEnabled && evaluationGateResult.blocksAutonomousEdits) {
    lines.push('Autonomous edits were skipped because the evaluation gate blocked code modification.');
  }
  if (state.executePlan && evaluationGateResult.blocksExecution) {
    lines.push('Execution halted before running jobs because the evaluation gate blocked job execution.');
  }
  if (state.executePlan && governanceGateResult.blocksExecution) {
    lines.push('Execution halted before running jobs because the governance gate blocked job execution.');
  }
  if (state.executePlan && state.approvalGranted === false) {
    lines.push('Execution halted before running jobs because approval was denied.');
  }
  if (state.executePlan && state.approvalGranted === null && state.pendingApprovals.length > 0) {
    lines.push('Execution is paused awaiting manual approval.');
  }
  if (state.pendingApprovals.length > 0) {
    lines.push(`Risk controls: ${state.pendingApprovals.map((approval) => approval.title).join('; ')}`);
  }
  if (state.plannedMcpActions.length > 0) {
    lines.push(`Planned MCP actions: ${state.plannedMcpActions.map((action) => `${action.server}.${action.tool}`).join(', ')}`);
  }
  if (state.executedMcpActions.length > 0) {
    for (const action of state.executedMcpActions) {
      lines.push(`MCP ${action.status}: ${action.title} (${action.server}.${action.tool})${action.outputSummary ? ` — ${action.outputSummary}` : ''}`);
    }
  }

  if (jobs.length === 0) {
    if (state.autonomousEditEnabled && state.autonomousOperationMode === 'repair' && state.proposedEdits.length === 0) {
      lines.push('No safe code-local repair was proposed in this iteration; the runner will continue monitoring and retesting.');
    } else {
      lines.push('No jobs were created.');
    }
    return {
      summary: lines.join('\n'),
      healthClass: laneHealth.healthClass,
      deferReason: laneHealth.deferReason,
      evidenceStatus: laneHealth.evidenceStatus,
      lastAiFailureClass: laneHealth.lastAiFailureClass,
      validationRequired: laneHealth.validationRequired,
    };
  }

  for (const job of jobs) {
    const status = 'status' in job ? job.status : 'planned';
    lines.push(`- [${status}] ${job.title}: ${job.command}`);
  }

  return {
    summary: lines.join('\n'),
    healthClass: laneHealth.healthClass,
    deferReason: laneHealth.deferReason,
    evidenceStatus: laneHealth.evidenceStatus,
    lastAiFailureClass: laneHealth.lastAiFailureClass,
    validationRequired: laneHealth.validationRequired,
  };
}

function buildControlPlaneGraph(checkpointer: any, store?: BaseStore) {
  return new StateGraph(ControlPlaneStateSchema)
    .addNode('inspectMcp', inspectMcpNode)
    .addNode('plannerAgent', plannerAgentNode)
    .addNode('buildAgent', buildAgentNode)
    .addNode('qualityAgent', qualityAgentNode)
    .addNode('deployAgent', deployAgentNode)
    .addNode('repairIntent', repairIntentNode)
    .addNode('autonomousContract', autonomousContractNode)
    .addNode('planMcpActions', planMcpActionsNode)
    .addNode('preplanMcpActions', preplanMcpActionsNode)
    .addNode('webIdeaScout', webIdeaScoutNode)
    .addNode('autonomousEditPlanner', autonomousEditPlannerNode)
    .addNode('reviewAutonomousEdits', reviewAutonomousEditsNode)
    .addNode('mergePlan', mergePlanNode)
    .addNode('approvalGate', approvalGateNode)
    .addNode('runMcpActions', runMcpActionsNode)
    .addNode('applyAutonomousEdits', applyAutonomousEditsNode)
    .addNode('repairValidate', repairValidateNode)
    .addNode('postRepairBrowserEvidence', postRepairBrowserEvidenceNode)
    .addNode('repairEvaluate', repairEvaluateNode)
    .addNode('repairDecision', repairDecisionNode)
    .addNode('postRepairValidate', postRepairValidateNode)
    .addNode('restartExperimentalService', restartExperimentalServiceNode)
    .addNode('restartProductionService', restartProductionServiceNode)
    .addNode('rollbackRepair', rollbackRepairNode)
    .addNode('runJobs', runJobsNode)
    .addNode('summarize', summarizeNode)
    .addEdge(START, 'inspectMcp')
    .addEdge('inspectMcp', 'plannerAgent')
    .addEdge('plannerAgent', 'buildAgent')
    .addEdge('buildAgent', 'qualityAgent')
    .addEdge('qualityAgent', 'deployAgent')
    .addEdge('deployAgent', 'repairIntent')
    .addEdge('repairIntent', 'autonomousContract')
    .addEdge('autonomousContract', 'planMcpActions')
    .addEdge('planMcpActions', 'preplanMcpActions')
    .addEdge('preplanMcpActions', 'webIdeaScout')
    .addEdge('webIdeaScout', 'autonomousEditPlanner')
    .addEdge('autonomousEditPlanner', 'reviewAutonomousEdits')
    .addEdge('reviewAutonomousEdits', 'mergePlan')
    .addConditionalEdges('mergePlan', shouldExecuteNode, ['approvalGate', 'summarize'])
    .addConditionalEdges('approvalGate', shouldContinueAfterApproval, ['runMcpActions', 'applyAutonomousEdits', 'runJobs', 'summarize'])
    .addConditionalEdges('runMcpActions', shouldContinueAfterMcpActions, ['applyAutonomousEdits', 'runJobs', 'summarize'])
    .addConditionalEdges('applyAutonomousEdits', shouldContinueAfterAutonomousEdits, ['repairValidate', 'rollbackRepair', 'runJobs', 'summarize'])
    .addEdge('repairValidate', 'postRepairBrowserEvidence')
    .addEdge('postRepairBrowserEvidence', 'repairEvaluate')
    .addEdge('repairEvaluate', 'repairDecision')
    .addEdge('repairDecision', 'postRepairValidate')
    .addEdge('postRepairValidate', 'restartExperimentalService')
    .addEdge('restartExperimentalService', 'restartProductionService')
    .addConditionalEdges('restartProductionService', shouldContinueAfterRepairDecision, ['rollbackRepair', 'runJobs', 'summarize'])
    .addEdge('rollbackRepair', 'summarize')
    .addEdge('runJobs', 'summarize')
    .addEdge('summarize', END)
    .compile({ checkpointer, store });
}

function resolveControlPlaneSemanticMemoryStorePath(repoRoot: string): string {
  return path.resolve(resolveControlPlaneRuntimeDir(repoRoot), 'semantic-memory.json');
}

export async function createControlPlaneGraph(options: { repoRoot: string; checkpointPath?: string }) {
  const checkpointPath = resolveControlPlaneCheckpointPath(options.repoRoot, options.checkpointPath);
  const checkpointer = new FileMemorySaver(checkpointPath);
  const store = new PersistentSemanticMemoryStore(resolveControlPlaneSemanticMemoryStorePath(options.repoRoot));
  await checkpointer.setup();
  await store.start();
  return {
    graph: buildControlPlaneGraph(checkpointer, store),
    checkpointer,
    store,
  };
}

const defaultControlPlaneGraphRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const defaultControlPlaneGraphCheckpointer = new FileMemorySaver(
  resolveControlPlaneCheckpointPath(defaultControlPlaneGraphRepoRoot, './apps/langgraph-control-plane/.control-plane/default-graph-checkpoints.json')
);
const defaultControlPlaneGraphStore = new PersistentSemanticMemoryStore(
  resolveControlPlaneSemanticMemoryStorePath(defaultControlPlaneGraphRepoRoot)
);
await defaultControlPlaneGraphStore.start();
export const controlPlaneGraph = buildControlPlaneGraph(defaultControlPlaneGraphCheckpointer, defaultControlPlaneGraphStore);

export async function createPersistentStudioControlPlaneGraph(options: { repoRoot: string; checkpointPath?: string }) {
  const checkpointPath = resolveControlPlaneCheckpointPath(options.repoRoot, options.checkpointPath);
  const checkpointer = new FileMemorySaver(checkpointPath);
  const store = new PersistentSemanticMemoryStore(resolveControlPlaneSemanticMemoryStorePath(options.repoRoot));
  await checkpointer.setup();
  await store.start();
  return buildControlPlaneGraph(checkpointer, store);
}
