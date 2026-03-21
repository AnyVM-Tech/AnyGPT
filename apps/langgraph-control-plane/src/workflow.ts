import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { END, START, StateGraph, interrupt, type BaseStore, type Runtime } from '@langchain/langgraph';
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
import { FileMemorySaver } from './fileCheckpointer.js';
import { PersistentSemanticMemoryStore } from './semanticMemoryStore.js';
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
  'Treat provider-bound failures (for example upstream API incompatibility, unsupported endpoint or mode combinations such as streaming or multi-agent restrictions, unsupported tool-calling or tool_choice combinations reported by an upstream router or provider, invalid API keys, disabled upstream APIs or projects, quota or payment exhaustion, repeated invalid upstream response structures, repeated empty streaming responses for the same model or endpoint, repeated upstream OpenAI-compatible streaming server_error responses for the same model or endpoint, repeated provider catalog or list-model auth failures, repeated Gemini ListModels 400/401/403 failures indicating disabled APIs, forbidden projects, expired or invalid API keys, or missing upstream activation, memory-pressure queue rejections caused by high rss/external/runtime usage without a clear local leak in the candidate files, or non-retryable remote media fetch failures) as ambiguous for direct repair unless a clear local guard, fallback, validation, routing, provider-selection fix, failure-origin classification improvement, bounded candidate prioritization improvement, operator-facing recovery note, or bounded local load-shedding improvement is visible in the provided candidate files.',
  'When logs show request-queue memory-pressure rejections with high rss, external memory, or swap usage but low in-flight and pending counts, treat the active failure as runtime-capacity pressure by default rather than a clear queue-logic bug; prefer the smallest bounded edit that improves failure-origin labeling, operator-facing recovery notes, autonomous decision reasons, or conservative load-shedding guidance in candidate files over speculative concurrency increases or threshold loosening.',
  'When active repair signals are repeated MEMORY_PRESSURE 503s from requestQueue/requestIntake with high rss, heap, external, or swap usage and low queue occupancy, treat them as runtime-capacity signals by default; prefer edits that improve failure-origin labeling, operator-facing recovery notes, candidate prioritization, or bounded load-shedding heuristics over speculative concurrency increases or broad queue rewrites unless the candidate files show a clear local regression.',
  'When logs already mark providerSwitchWorthless or requestRetryWorthless for these failures, prefer a bounded heuristic, note-quality, observability, cooldown, provider de-prioritization, failure-origin labeling, or recovery-planning improvement over speculative provider implementation edits.',
  'When repeated Gemini catalog failures are the active signal, especially ListModels 400/401/403 responses about disabled APIs, forbidden projects, or expired/invalid keys, prefer edits that improve autonomous classification, decision reasons, candidate-path prioritization, repair summaries, or operator-facing notes in control-plane candidate files rather than direct provider code changes unless the candidate files show an obvious local validation or routing defect.',
  'When the stated goal concerns failed jobs, runner failure propagation, or terminal status accuracy, prioritize small control-plane fixes that ensure failed repair/build/deploy/job outcomes are surfaced as runner failure, persisted in status fields, and reflected in summaries before attempting unrelated provider changes.',
  'When repeated empty streaming responses are concentrated on the same provider family, model, or endpoint, treat them as upstream/provider-bound by default and prefer control-plane recovery guidance, provider de-prioritization notes, or retry-worthlessness labeling over speculative streaming implementation edits unless a small local guard is clearly visible in the candidate files.',
  'When active repair signals are dominated by memory-pressure rejections that already include runtime snapshots (for example swap_used_mb, rssBytes, externalBytes, or queue idle snapshots), treat them as runtime-capacity incidents by default and prefer bounded request-intake observability, clearer failure-origin labeling, operator-facing recovery notes, or autonomous decision-quality improvements over speculative concurrency or provider-routing changes unless the candidate files show an obvious local threshold or leak bug.',
  'When logs show many skipped providers, repeated upstream-only failures, repeated catalog or auth failures for the same provider family, or unsupported endpoint or mode combinations for a specific model, bias toward improving heuristics, operator visibility, and autonomous recovery notes rather than attempting speculative provider implementation edits.',
].join(' ');

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
  repairStatus: RepairStatusSchema.default('idle'),
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
  return state.executePlan
    && state.autonomousEditEnabled
    && state.autonomousEditReviewDecision === 'approved'
    && state.proposedEdits.length > 0
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

  if (/\b(error|failed|failure|timeout|timed out|unauthorized|invalid|exception|refused|denied|backlog|overloaded|degraded|unavailable|unhealthy|panic)\b/i.test(normalized)) {
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
  const allControlPlane = normalizedPaths.every((candidatePath) => candidatePath.startsWith('apps/langgraph-control-plane/'));
  const allApiModules = normalizedPaths.every((candidatePath) => candidatePath.startsWith('apps/api/modules/'));

  if (allControlPlane) return true;
  if (allApiModules && hasErrorClassification) return true;
  if (hasWorkflow && (hasIndex || hasErrorClassification)) return true;
  return false;
}

function scoreAutonomousEditPathFit(
  state: Pick<ControlPlaneState, 'repairSignals' | 'improvementSignals' | 'autonomousOperationMode'>,
  path: string,
  supportingText: string = '',
): number {
  const normalizedPath = String(path || '').trim();
  if (!normalizedPath) return 0;
  const sourceText = [...state.repairSignals, ...state.improvementSignals, supportingText].join(' | ').toLowerCase();

  let score = 0;
  if (normalizedPath.startsWith('apps/langgraph-control-plane/')) score += 2;
  if (normalizedPath.startsWith('apps/api/modules/errorClassification.ts') && /server_error|invalid_response_structure|failureorigin|provider-bound|request retry worthless|providerswitchworthless/.test(sourceText)) score += 4;
  if (normalizedPath.startsWith('apps/api/modules/requestQueue.ts') && /memory pressure|queue|overloaded|max_pending|swap_used_mb|external_mb/.test(sourceText)) score += 4;
  if (normalizedPath.startsWith('apps/api/modules/requestIntake.ts') && /content_length|intake|request body|bufferedrequestbody/.test(sourceText)) score += 4;
  if (normalizedPath.startsWith('apps/api/modules/openaiProviderSelection.ts') && /provider selection|provider switch|retry worthless|routing|model-availability|probe|tool-calling|tool_choice|unsupported(?:-| )tool|healthy selection/.test(sourceText)) score += 3;
  if (normalizedPath.startsWith('apps/api/modules/openaiRequestSupport.ts') && /heartbeat|keepalive|keep-alive|backpressure|response\.write|drain|sse|stream teardown|stream keepalive|premature stream/.test(sourceText)) score += 3;
  if (normalizedPath.startsWith('apps/api/providers/openai.ts') && /server_error|empty streaming response|responses endpoint|stream/.test(sourceText)) score += 2;
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

  if (uniqueScopeSet.has('api') || uniqueScopeSet.has('api-experimental') || uniqueScopeSet.has('repo')) {
    signals.push('Experimental API loop is healthy enough to pursue bounded throughput, routing, and model-availability improvements.');
  }

  if (uniqueScopeSet.has('repo')) {
    signals.push('Repo-wide coverage is active, so the autonomous loop can inspect root build/test health plus bounded UI, homepage, and workspace configuration improvements.');
  }

  if (uniqueScopeSet.has('repo-surface')) {
    signals.push('Repo-surface coverage is active, so the autonomous loop can focus on root workspace files plus bounded homepage/UI improvements without widening into API or control-plane edits.');
  }

  if (uniqueScopeSet.has('control-plane')) {
    signals.push('Control-plane scope is active, so the runtime can refine orchestration, observability, and autonomous recovery heuristics during healthy iterations.');
  }

  if (uniqueScopeSet.has('repo')) {
    signals.push('If no novel repair target is present, prefer bounded feature work, codebase cleanup, architecture simplification, and developer-workflow hardening over repeating provider churn analysis.');
  }

  if (uniqueScopeSet.has('repo-surface')) {
    signals.push('Prefer small root-workspace, homepage, and UI cleanup work when no code-local repair target is present.');
  }

  const syncInsight = state.logInsights.find((insight) => insight.file.endsWith('fast-image-sync.log'));
  const latestSyncLine = syncInsight?.lines[syncInsight.lines.length - 1];
  if (latestSyncLine) {
    signals.push(`Provider/model sync churn insight: ${latestSyncLine}`);
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

  if (queueEdits.length > 0 && (queueSignalDetected || activeScopes.has('api-experimental') || activeScopes.has('api') || activeScopes.has('repo'))) {
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

const CONTROL_PLANE_DATA_DIR = './apps/api/.control-plane';
const CONTROL_PLANE_PACKAGE_DATA_DIR = '.control-plane';
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

const SAFE_EXPERIMENTAL_DEPLOY_COMMAND = 'sudo systemctl restart anygpt-experimental';
const SAFE_PRODUCTION_DEPLOY_COMMAND = 'sudo systemctl restart anygpt.service';
const AUTO_RESTART_PRODUCTION_AFTER_REPAIR = parseBooleanEnv('CONTROL_PLANE_AUTO_RESTART_PRODUCTION', false);
const REDACTED_SECRET_PLACEHOLDER = '[redacted]';
const REDACTED_IP_PLACEHOLDER = '[redacted-ip]';
const MCP_CLIENT_NAME = 'anygpt-langgraph-control-plane';
const MCP_CLIENT_VERSION = '0.1.0';
const DEFAULT_LOG_TAIL_LINE_COUNT = parsePositiveIntegerEnv('CONTROL_PLANE_LOG_TAIL_LINES', 40, 4);
const MCP_INSPECTION_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_MCP_INSPECTION_TIMEOUT_MS', 8_000, 1_000);
const MCP_MAX_TOOL_PAGES = 20;
const AI_AGENT_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_AI_AGENT_TIMEOUT_MS', 40_000, 5_000);
const AI_NOTES_AGENT_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv('CONTROL_PLANE_AI_NOTES_TIMEOUT_MS', 20_000, 1_000);
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
  api: {
    build: API_EXPERIMENTAL_BUILD_COMMAND,
    test: API_EXPERIMENTAL_TEST_COMMAND,
  },
  'api-experimental': {
    build: API_EXPERIMENTAL_BUILD_COMMAND,
    test: API_EXPERIMENTAL_TEST_COMMAND,
  },
  'control-plane': {
    build: 'bash ./bun.sh run -F anygpt-langgraph-control-plane build',
    test: 'bash ./bun.sh run -F anygpt-langgraph-control-plane typecheck',
  },
};

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

  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return truncateTextMiddle(redactSensitiveText(value), maxStringChars);
  }

  if (Array.isArray(value)) {
    const sliced = value.slice(0, maxArrayItems);
    if (depth >= maxDepth) {
      return sliced.map((entry) => truncateTextMiddle(
        JSON.stringify(redactSensitiveValue(entry)),
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
          truncateTextMiddle(JSON.stringify(redactSensitiveValue(entryValue)), maxStringChars),
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

  return approvals;
}

export function resolveControlPlaneCheckpointPath(repoRoot: string, override?: string): string {
  const configuredPath = String(override || process.env.CONTROL_PLANE_CHECKPOINT_PATH || CONTROL_PLANE_CHECKPOINTS_FILE).trim();
  return path.resolve(repoRoot, configuredPath || CONTROL_PLANE_CHECKPOINTS_FILE);
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

  if (explicitBaseUrl && explicitApiKey && explicitModel) {
    const parsedTemperature = Number(process.env.CONTROL_PLANE_AI_TEMPERATURE || '0.2');
    const temperature = Number.isFinite(parsedTemperature) ? parsedTemperature : 0.2;
    return {
      enabled: true,
      baseUrl: explicitBaseUrl,
      apiKey: explicitApiKey,
      model: explicitModel,
      temperature,
      reasoningEffort: configuredReasoningEffort || undefined,
      source: 'CONTROL_PLANE_AI_*',
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
  const anygptModel = String(process.env.ANYGPT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4').trim();
  const parsedTemperature = Number(process.env.CONTROL_PLANE_AI_TEMPERATURE || '0.2');
  const temperature = Number.isFinite(parsedTemperature) ? parsedTemperature : 0.2;

  if (anygptApiKey && anygptBaseUrl && anygptModel) {
    return {
      enabled: true,
      baseUrl: anygptBaseUrl,
      apiKey: anygptApiKey,
      model: anygptModel,
      temperature,
      reasoningEffort: configuredReasoningEffort || undefined,
      source: 'ANYGPT_API_* / OPENAI_*',
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
      source: 'apps/api/keys.json fallback',
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

async function readSemanticMemoryNotes(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile' | 'repairSignals' | 'improvementSignals' | 'recentAutonomousLearningNotes'>,
): Promise<Array<z.infer<typeof SemanticMemoryNoteSchema>>> {
  if (!store) return [];
  const namespace = getControlPlaneSemanticMemoryNamespace(state);
  const query = [...state.repairSignals, ...state.improvementSignals, ...state.recentAutonomousLearningNotes]
    .slice(-12)
    .join(' | ')
    .trim();
  const results = await store.search(namespace, {
    query: query || 'control plane runner learnings',
    limit: 6,
  }).catch(() => []);
  return results
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
}

export async function writeSemanticMemoryNotes(
  store: BaseStore | undefined,
  state: Pick<ControlPlaneState, 'langSmithProjectName' | 'governanceProfile'>,
  notes: string[],
  metadata?: { signalSignature?: string; failureClass?: string; resolution?: string; source?: string },
): Promise<void> {
  if (!store || notes.length === 0) return;
  const namespace = getControlPlaneSemanticMemoryNamespace(state);
  const normalizedNotes = Array.from(new Set(notes.map((entry) => String(entry || '').trim()).filter(Boolean))).slice(-4);
  for (const memory of normalizedNotes) {
    const keySeed = `${metadata?.failureClass || 'general'}:${metadata?.signalSignature || 'none'}:${memory}`;
    const key = Buffer.from(keySeed).toString('base64url').slice(0, 96);
    await store.put(namespace, key, {
      category: metadata?.failureClass || 'general',
      memory,
      signalSignature: metadata?.signalSignature || '',
      failureClass: metadata?.failureClass || '',
      resolution: metadata?.resolution || '',
      source: metadata?.source || 'runner-learning',
    }).catch(() => undefined);
  }
}

function buildSharedAiAgentPayload(state: ControlPlaneState): Record<string, unknown> {
  const evaluationGatePolicy = resolveStateEvaluationGatePolicy(state);
  const evaluationGateResult = resolveStateEvaluationGateResult(state);
  const governanceGateResult = resolveStateGovernanceGateResult(state);
  const { scopes: effectiveScopes, reason: scopeExpansionReason } = resolveEffectiveScopes(state);
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
    mcpServers: state.mcpInspections.map((inspection) => ({
      server: inspection.server,
      status: inspection.status,
      tools: inspection.tools.map((tool) => tool.name),
    })),
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
      signals: state.repairSignals,
      actionableSignalCount: countActionableRepairSignals(state.repairSignals),
      externalSignalCount: countExternallyCausedRepairSignals(state.repairSignals),
      improvementIntentSummary: state.improvementIntentSummary,
      improvementSignals: state.improvementSignals,
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
  };

  return compactUnknownForAi(payload, {
    maxStringChars: AI_AGENT_PAYLOAD_STRING_MAX_CHARS,
    maxArrayItems: AI_AGENT_PAYLOAD_ARRAY_LIMIT,
    maxObjectKeys: AI_AGENT_PAYLOAD_OBJECT_KEY_LIMIT,
    maxDepth: 4,
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_NOTES_AGENT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
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
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify(compactUnknownForAi({
              threadId: state.threadId,
              role,
              payload,
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
    };
  } catch (error: any) {
    const errorText = String(error?.message || error || '');
    const rawMessage = error?.name === 'AbortError' || errorText === 'The operation was aborted.'
      ? `AI ${role} agent timed out after ${AI_NOTES_AGENT_REQUEST_TIMEOUT_MS}ms`
      : errorText;
    return {
      enabled: true,
      model: config.model,
      backend: config.baseUrl,
      notes: [],
      error: redactSensitiveText(rawMessage),
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
  const timeoutId = setTimeout(() => controller.abort(), AI_AGENT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
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
  const timeoutId = setTimeout(() => controller.abort(), AI_AGENT_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
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
      error: redactSensitiveText(error?.message || String(error)),
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

function resolveLogInsights(state: ControlPlaneState): LogInsight[] {
  return listRecentLogCandidatePaths(state)
    .map((filePath) => ({ file: path.relative(state.repoRoot, filePath), lines: readTailLines(filePath, DEFAULT_LOG_TAIL_LINE_COUNT) }))
    .filter((entry) => entry.lines.length > 0)
    .map((entry) => LogInsightSchema.parse(entry));
}

function buildRecentFailedAutonomousEditsPayload(state: ControlPlaneState): Array<Record<string, unknown>> {
  return state.appliedEdits
    .filter((edit) => edit.status === 'failed')
    .slice(-3)
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
  for (const edit of state.appliedEdits.filter((entry) => entry.status === 'failed').slice(-4)) {
    const normalizedPath = String(edit.path || '').trim();
    if (!normalizedPath) continue;
    const nextHints = [
      ...(hints[normalizedPath] || []),
      ...(typeof edit.find === 'string' ? extractMeaningfulAnchorLines(edit.find, 4) : []),
    ];
    const message = String(edit.message || '');
    const firstAnchorMatch = message.match(/First anchor fragment:\s*(.+)$/s);
    if (firstAnchorMatch) {
      nextHints.push(String(firstAnchorMatch[1] || '').split('\n')[0].trim());
    }
    const excerptMatch = message.match(/Closest anchor match around line \d+:\n([\s\S]*)$/);
    if (excerptMatch) {
      nextHints.push(...extractMeaningfulAnchorLines(String(excerptMatch[1] || ''), 4));
    }
    hints[normalizedPath] = uniqueNormalizedStrings(nextHints).slice(0, 8);
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

function isRepeatedFailedEditProposal(
  edit: AutonomousEditAction,
  recentFailedEdits: Array<Record<string, unknown>>,
): boolean {
  const normalizedPath = String(edit.path || '').trim();
  const normalizedType = String(edit.type || '').trim();
  if (!normalizedPath || !normalizedType) return false;

  return recentFailedEdits.some((failedEdit) => {
    if (String(failedEdit.path || '').trim() !== normalizedPath) return false;
    if (String(failedEdit.type || '').trim() !== normalizedType) return false;

    if (normalizedType === 'replace') {
      return String(failedEdit.find || '').trim() === String(edit.find || '').trim();
    }

    if (normalizedType === 'write') {
      return String(failedEdit.content || '').trim() === String((edit as any).content || '').trim();
    }

    return false;
  });
}

function filterInvalidAutonomousEditProposals(
  state: ControlPlaneState,
  edits: AutonomousEditAction[],
  existingCandidatePaths: Set<string>,
): { accepted: AutonomousEditAction[]; notes: string[] } {
  const accepted: AutonomousEditAction[] = [];
  const notes: string[] = [];
  const avoidProviderPathEdits = shouldAvoidProviderPathAutonomousEdits(state.repairSignals);
  const restrictToControlPlane = shouldRestrictAutonomousEditsToControlPlane(state);

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

    if (avoidProviderPathEdits && check.normalizedPath.startsWith('apps/api/providers/')) {
      notes.push(`Skipped autonomous edit proposal for ${check.normalizedPath}: active repair signals are provider-bound, so autonomous provider-file edits are blocked for this iteration.`);
      continue;
    }

    if (restrictToControlPlane && !check.normalizedPath.startsWith('apps/langgraph-control-plane/')) {
      notes.push(`Skipped autonomous edit proposal for ${check.normalizedPath}: current signals are externally caused or repetitive, so this iteration is restricted to control-plane-only edits.`);
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
      const current = fs.readFileSync(absolutePath, 'utf8');
      const find = typeof edit.find === 'string' ? edit.find : '';
      if (!find) {
        notes.push(`Skipped autonomous replace proposal for ${check.normalizedPath}: replace edits must include a find block.`);
        continue;
      }
      const exactMatchCount = current.includes(find)
        ? current.split(find).length - 1
        : 0;
      const preflightFailure = exactMatchCount === 0
        ? preflightAutonomousEditAction(
            state.repoRoot,
            {
              ...edit,
              path: check.normalizedPath,
            },
            state.editAllowlist,
            state.editDenylist,
          )
        : null;
      if (preflightFailure) {
        notes.push(`Skipped autonomous replace proposal for ${check.normalizedPath}: ${preflightFailure.message}`);
        continue;
      }
    }

    accepted.push({
      ...edit,
      path: check.normalizedPath,
    });
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
  const maxAgents = Math.max(1, Math.min(aggressivePlanning ? AI_CODE_EDIT_AGENT_PARALLELISM : 1, candidateFiles.length));
  const workloads: AutonomousEditAgentWorkload[] = [];

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

  addWorkload('primary', buildDefaultAutonomousEditAgentFocus(operationMode), candidateFiles);
  if (maxAgents === 1) return workloads;

  if (failedPaths.size > 0) {
    addWorkload(
      'refresh-failed-paths',
      'Revisit previously failing edit targets with the refreshed live blocks and propose a safer bounded patch.',
      candidateFiles.filter((file) => failedPaths.has(file.path)),
    );
  }

  const effectiveScopes = new Set(getEffectiveScopes(state));
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
        ? 'If direct repair is ambiguous, improve the control-plane heuristics, observability, or autonomous recovery logic instead.'
        : 'Look specifically for a small control-plane orchestration, observability, or workflow-hardening improvement.',
      candidateFiles.filter((file) => file.path.startsWith('apps/langgraph-control-plane/')),
    );
  }

  if (effectiveScopes.has('repo')) {
    addWorkload(
      'repo-surface',
      'Look specifically for a small repo/workspace/homepage/UI cleanup or developer-workflow hardening improvement.',
      candidateFiles.filter((file) => !file.path.startsWith('apps/api/') && !file.path.startsWith('apps/langgraph-control-plane/')),
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
    await source.connect();
    await target.connect();
    await target.flushDb();

    for await (const key of source.scanIterator()) {
      if (copyMethod === 'copy') {
        try {
          const copiedResult = await source.sendCommand<number>(['COPY', key, key, 'DB', targetDb, 'REPLACE']);
          if (copiedResult === 1) copied += 1;
          continue;
        } catch {
          copyMethod = 'dump-restore';
        }
      }

      try {
        const serializedValue = await source.sendCommand<Buffer | Uint8Array | ArrayBuffer | null>(
          ['DUMP', key],
          commandOptions({ returnBuffers: true }),
        );
        if (!serializedValue) continue;
        const serializedBuffer = normalizeRedisDumpPayload(serializedValue);
        const ttlMs = await source.sendCommand<number>(['PTTL', key]);
        await target.sendCommand([
          'RESTORE',
          key,
          ttlMs > 0 ? String(ttlMs) : '0',
          serializedBuffer,
          'REPLACE',
        ]);
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
    return Object.entries(servers).map(([name, config]: [string, any]) => ({
      name,
      command: String(config?.command || ''),
      args: coerceStringArray(config?.args),
      type: typeof config?.type === 'string' && config.type.trim().length > 0 ? config.type.trim() : 'stdio',
      disabled: config?.disabled === true,
      alwaysAllow: coerceStringArray(config?.alwaysAllow),
      disabledTools: coerceStringArray(config?.disabledTools),
      env: coerceStringRecord(config?.env),
      cwd: typeof config?.cwd === 'string' && config.cwd.trim().length > 0 ? config.cwd.trim() : undefined,
    }));
  } catch {
    return [];
  }
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
  if (scopes.includes('api') || scopes.includes('api-experimental')) {
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
  const logInsights = resolveLogInsights(state);
  const langSmithConfig = resolveLangSmithRuntimeConfig();
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

  if (langSmithConfig) {
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
    Boolean(langSmithConfig),
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
    Boolean(langSmithConfig),
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
      langSmithEnabled: Boolean(langSmithConfig),
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
  if (scopes.includes('api') || scopes.includes('api-experimental')) {
    notes.push(`API jobs are pinned to experimental-safe build/test defaults and isolated control-plane data files under ${CONTROL_PLANE_DATA_DIR}.`);
    notes.push(`Default deploy target is ${SAFE_EXPERIMENTAL_DEPLOY_COMMAND}; production service restarts targeting anygpt.service are intentionally blocked.`);
    notes.push(`Experimental test jobs clone Redis/Dragonfly DB ${CONTROL_PLANE_SOURCE_REDIS_DB} into DB ${CONTROL_PLANE_TARGET_REDIS_DB} before execution by default.`);
  }

  for (const insight of state.logInsights) {
    if (insight.lines.length === 0) continue;
    notes.push(`Log input ${insight.file}: ${insight.lines[insight.lines.length - 1]}`);
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

  return {
    effectiveScopes: scopes,
    plannerNotes: mergedNotes,
    aiAgentEnabled: state.aiAgentEnabled || aiPlanner.enabled,
    aiAgentBackend: state.aiAgentBackend || aiPlanner.backend,
    aiAgentModel: state.aiAgentModel || aiPlanner.model,
    plannerAgentInsights: aiPlanner.notes,
  };
}

async function buildAgentNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const buildJobs = buildScopeJobs(getEffectiveScopes(state), 'build');
  const aiBuild = await callAiNotesAgent(
    'build',
    state,
    {
      ...buildSharedAiAgentPayload(state),
      buildJobs,
    },
    state.controlPlanePrompts.build,
  );

  return {
    buildJobs,
    plannerNotes: appendUniqueNotes(
      state.plannerNotes,
      aiBuild.notes.map((note) => `AI build agent: ${note}`),
    ),
    aiAgentEnabled: state.aiAgentEnabled || aiBuild.enabled,
    aiAgentBackend: state.aiAgentBackend || aiBuild.backend,
    aiAgentModel: state.aiAgentModel || aiBuild.model,
    buildAgentInsights: aiBuild.notes,
  };
}

async function qualityAgentNode(state: ControlPlaneState): Promise<Partial<ControlPlaneState>> {
  const testJobs = buildScopeJobs(getEffectiveScopes(state), 'test');
  const aiQuality = await callAiNotesAgent(
    'quality',
    state,
    {
      ...buildSharedAiAgentPayload(state),
      testJobs,
    },
    state.controlPlanePrompts.quality,
  );

  return {
    testJobs,
    plannerNotes: appendUniqueNotes(
      state.plannerNotes,
      aiQuality.notes.map((note) => `AI quality agent: ${note}`),
    ),
    aiAgentEnabled: state.aiAgentEnabled || aiQuality.enabled,
    aiAgentBackend: state.aiAgentBackend || aiQuality.backend,
    aiAgentModel: state.aiAgentModel || aiQuality.model,
    qualityAgentInsights: aiQuality.notes,
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

  const aiDeploy = await callAiNotesAgent(
    'deploy',
    state,
    {
      ...buildSharedAiAgentPayload(state),
      deployJobs,
    },
    state.controlPlanePrompts.deploy,
  );

  return {
    deployJobs,
    plannerNotes: appendUniqueNotes(
      state.plannerNotes,
      aiDeploy.notes.map((note) => `AI deploy agent: ${note}`),
    ),
    aiAgentEnabled: state.aiAgentEnabled || aiDeploy.enabled,
    aiAgentBackend: state.aiAgentBackend || aiDeploy.backend,
    aiAgentModel: state.aiAgentModel || aiDeploy.model,
    deployAgentInsights: aiDeploy.notes,
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
  const candidatePrioritySources = [
    ...state.repairSignals,
    ...state.improvementSignals,
    ...state.plannerNotes,
    ...state.buildAgentInsights,
    ...state.qualityAgentInsights,
    ...state.deployAgentInsights,
  ].slice(-40);
  const referencedCandidatePaths = new Set<string>();
  for (const sourceText of candidatePrioritySources) {
    for (const match of String(sourceText || '').match(/apps\/[A-Za-z0-9._/-]+\.(?:ts|js|json|md|mts|service)/g) || []) {
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
      const rank = (candidatePath: string): number => {
        if (failedPaths.has(candidatePath)) return -10;
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
          previousRepairStatus: state.repairStatus,
          previousRepairDecisionReason: truncateTextMiddle(state.repairDecisionReason, AI_AGENT_PAYLOAD_STRING_MAX_CHARS),
          previousAutonomousEditNotes: compactStringArrayForAi(
            state.autonomousEditNotes.filter((note) => /autonomous edit failed|replace target text was not found|matched \d+ times|provider-bound|blocked for this iteration/i.test(note)),
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
  const apiTouches = touchedPaths.filter((candidatePath) => candidatePath.startsWith('apps/api/'));
  const controlPlaneTouches = touchedPaths.filter((candidatePath) => candidatePath.startsWith('apps/langgraph-control-plane/'));
  const nonControlPlaneTouches = touchedPaths.filter((candidatePath) => !candidatePath.startsWith('apps/langgraph-control-plane/'));
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
  const weakestPathFitScore = touchedPaths.length > 0
    ? Math.min(...touchedPaths.map((candidatePath) => scoreAutonomousEditPathFit(state, candidatePath, proposalReasonByPath.get(candidatePath) || '')))
    : 0;

  if (providerBoundSignals && providerPathTouches.length > 0) {
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
  } else {
    repairStatus = 'promoted';
    repairPromotedPaths = appliedPaths;
    repairDecisionReason = `${autonomousLaneLabel} promoted after ${state.repairSmokeResults.filter((job) => job.status === 'success').length} successful smoke job(s) and evaluation gate status ${evaluationGateResult.status}.`;
  }

  return {
    repairStatus,
    repairDecisionReason,
    repairPromotedPaths,
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
  return shouldApplyAutonomousEditsForState(state) || shouldRunJobsForState(state) ? 'approvalGate' : 'summarize';
}

function shouldContinueAfterApproval(state: ControlPlaneState): 'applyAutonomousEdits' | 'runJobs' | 'summarize' {
  if (state.approvalGranted === false) return 'summarize';
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

  if (jobs.length === 0) {
    if (state.autonomousEditEnabled && state.autonomousOperationMode === 'repair' && state.proposedEdits.length === 0) {
      lines.push('No safe code-local repair was proposed in this iteration; the runner will continue monitoring and retesting.');
    } else {
      lines.push('No jobs were created.');
    }
    return { summary: lines.join('\n') };
  }

  for (const job of jobs) {
    const status = 'status' in job ? job.status : 'planned';
    lines.push(`- [${status}] ${job.title}: ${job.command}`);
  }

  return { summary: lines.join('\n') };
}

function buildControlPlaneGraph(checkpointer: any, store?: BaseStore) {
  return new StateGraph(ControlPlaneStateSchema)
    .addNode('inspectMcp', inspectMcpNode)
    .addNode('plannerAgent', plannerAgentNode)
    .addNode('buildAgent', buildAgentNode)
    .addNode('qualityAgent', qualityAgentNode)
    .addNode('deployAgent', deployAgentNode)
    .addNode('repairIntent', repairIntentNode)
    .addNode('autonomousEditPlanner', autonomousEditPlannerNode)
    .addNode('reviewAutonomousEdits', reviewAutonomousEditsNode)
    .addNode('mergePlan', mergePlanNode)
    .addNode('approvalGate', approvalGateNode)
    .addNode('applyAutonomousEdits', applyAutonomousEditsNode)
    .addNode('repairValidate', repairValidateNode)
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
    .addEdge('repairIntent', 'autonomousEditPlanner')
    .addEdge('autonomousEditPlanner', 'reviewAutonomousEdits')
    .addEdge('reviewAutonomousEdits', 'mergePlan')
    .addConditionalEdges('mergePlan', shouldExecuteNode, ['approvalGate', 'summarize'])
    .addConditionalEdges('approvalGate', shouldContinueAfterApproval, ['applyAutonomousEdits', 'runJobs', 'summarize'])
    .addConditionalEdges('applyAutonomousEdits', shouldContinueAfterAutonomousEdits, ['repairValidate', 'rollbackRepair', 'runJobs', 'summarize'])
    .addEdge('repairValidate', 'repairEvaluate')
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
  return path.resolve(repoRoot, 'apps', 'langgraph-control-plane', '.control-plane', 'semantic-memory.json');
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
