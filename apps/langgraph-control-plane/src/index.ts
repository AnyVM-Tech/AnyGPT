import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from '@langchain/langgraph';
import dotenv from 'dotenv';

import {
  ControlPlaneStateSchema,
  createControlPlaneGraph,
  resolveControlPlaneCheckpointPath,
  type ControlPlaneEvaluationGatePolicy,
} from './workflow.js';
import {
  resolveAutonomousEditAllowlist,
  resolveAutonomousEditDenylist,
} from './autonomousEdits.js';
import { resolveLangSmithRuntimeConfig } from './langsmithClient.js';

type ParsedArgs = {
  goal: string;
  scopes: string[];
  threadId: string;
  approvalMode: 'manual' | 'auto';
  continuous: boolean;
  autonomous: boolean;
  autonomousEditEnabled: boolean;
  editAllowlist: string[];
  editDenylist: string[];
  maxEditActions: number;
  intervalMs: number;
  maxIterations: number | null;
  executePlan: boolean;
  allowDeploy: boolean;
  deployCommand: string;
  promptIdentifier: string;
  promptRef: string;
  promptChannel: string;
  promptSyncEnabled: boolean;
  promptSyncChannel: string;
  promptPromoteChannel: string;
  evaluationGatePolicy: ControlPlaneEvaluationGatePolicy;
  repoRoot: string;
  mcpConfigPath: string;
  checkpointPath: string;
  statusFilePath: string;
  pidFilePath?: string;
  streamMode: 'updates' | 'values';
  resumeValue?: unknown;
};

type RunnerStatus = {
  goal: string;
  scopes: string[];
  threadId: string;
  continuous: boolean;
  autonomous: boolean;
  autonomousEditEnabled: boolean;
  executePlan: boolean;
  approvalMode: 'manual' | 'auto';
  checkpointPath: string;
  statusFilePath: string;
  iteration: number;
  maxIterations: number | null;
  intervalMs: number;
  running: boolean;
  phase: 'starting' | 'streaming' | 'sleeping' | 'paused' | 'completed' | 'failed';
  lastUpdatedAt: string;
  startedAt: string;
  lastRunStartedAt?: string;
  lastRunCompletedAt?: string;
  lastError?: string;
  sawInterrupt: boolean;
  proposedEditCount?: number;
  appliedEditCount?: number;
  lastAppliedEditPaths?: string[];
  repairStatus?: string;
  repairDecisionReason?: string;
  repairIntentSummary?: string;
  repairSignalCount?: number;
  autonomousOperationMode?: string;
  improvementIntentSummary?: string;
  improvementSignalCount?: number;
  repairSessionId?: string;
  repairRollbackStatus?: string;
  repairSmokeJobCount?: number;
  repairSmokeFailedCount?: number;
  postRepairValidationStatus?: string;
  postRepairValidationJobCount?: number;
  postRepairValidationFailedCount?: number;
  repairPromotedPaths?: string[];
  repairRollbackPaths?: string[];
  experimentalRestartStatus?: string;
  experimentalRestartReason?: string;
  langSmithOrganizationId?: string;
  langSmithWorkspaceId?: string;
  langSmithWorkspaceName?: string;
  langSmithWorkspaceRole?: string;
  langSmithWorkspaceCount?: number;
  langSmithAccessibleWorkspaceNames?: string[];
  langSmithProjectName?: string;
  langSmithProjectId?: string;
  langSmithProjectDescription?: string;
  langSmithProjectVisibility?: string;
  langSmithAnnotationQueueCount?: number;
  langSmithAnnotationQueueItemCount?: number;
  langSmithFeedbackCount?: number;
  langSmithFeedbackKeys?: string[];
  langSmithEvaluationCount?: number;
  langSmithEvaluationDatasets?: string[];
  langSmithEvaluationMetrics?: string[];
  langSmithGovernanceFlagCount?: number;
  langSmithGovernanceAttentionFlags?: string[];
  langSmithGovernanceMutationCount?: number;
  langSmithGovernanceMutations?: string[];
  promptIdentifier: string;
  promptRequestedRef?: string;
  promptRequestedChannel?: string;
  promptSelectionSource?: string;
  promptSelectedRef?: string;
  promptSelectedChannel?: string;
  promptAvailableChannels?: string[];
  promptCommitHash?: string;
  promptRollbackReference?: string;
  promptSyncEnabled: boolean;
  promptSyncChannel: string;
  promptSyncUrl?: string;
  promptPromoteChannel?: string;
  promptPromotionUrl?: string;
  promptPromotionReason?: string;
  promptPromotionBlockedReason?: string;
  promptSelectionNotes?: string[];
  governanceProfile?: string;
  governanceGateStatus?: string;
  governanceGateReason?: string;
  governanceGateBlocks?: string[];
  governanceGateActionableFlags?: string[];
  controlPlaneAiBackend?: string;
  controlPlaneAiModel?: string;
  experimentalApiBaseUrl?: string;
  experimentalServiceName?: string;
  evaluationGateMode: ControlPlaneEvaluationGatePolicy['mode'];
  evaluationGateTarget: ControlPlaneEvaluationGatePolicy['target'];
  evaluationGateAggregationMode?: string;
  evaluationGateRequireEvaluation: boolean;
  evaluationGateMinResults: number;
  evaluationGateMetricKey: string;
  evaluationGateMinMetricAverageScore: number;
  evaluationGateMinimumWeightedScore?: number | null;
  evaluationGateStatus?: string;
  evaluationGateReason?: string;
  evaluationGateBlocks?: string[];
  evaluationGateMetricAverageScore?: number | null;
  evaluationGateMetricCount?: number;
  evaluationGateMetricResults?: string[];
  evaluationGateWeightedAverageScore?: number | null;
  evaluationGateScorecardStatus?: string;
  evaluationGateBaselineExperiment?: string;
  evaluationGateComparisonUrl?: string;
  evaluationResultCount?: number;
  repairTouchedPaths?: string[];
  observabilityTags?: string[];
  summary?: string;
};

const DEFAULT_RUNNER_STATUS_PATH = './apps/langgraph-control-plane/.control-plane/runner-status.json';
const DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER = 'anygpt-control-plane-agent';
const DEFAULT_CONTROL_PLANE_PROMPT_CHANNEL = 'live';
const DEFAULT_CONTROL_PLANE_PROMPT_SYNC_CHANNEL = 'default';
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_CONTROL_PLANE_EXPERIMENTAL_API_BASE_URL = 'http://127.0.0.1:3310';
const DEFAULT_CONTROL_PLANE_EXPERIMENTAL_SERVICE = 'anygpt-experimental.service';

function loadEnvForControlPlane(repoRoot: string): void {
  const candidates = [
    path.resolve(repoRoot, '.env'),
    path.resolve(repoRoot, '.env.local'),
    path.resolve(repoRoot, 'apps', 'api', '.env'),
    path.resolve(repoRoot, 'apps', 'api', '.env.local'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    dotenv.config({ path: candidate, override: false });
  }
}

async function discoverLangSmithWorkspaceId(apiKey: string, workspaceName: string): Promise<string | undefined> {
  const response = await fetch('https://api.smith.langchain.com/workspaces', {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`LangSmith workspace discovery failed with status ${response.status}`);
  }

  const payload = await response.json();
  const workspaces = Array.isArray(payload) ? payload : [];
  const normalizedWorkspaceName = workspaceName.trim().toLowerCase();
  const matchedWorkspace = workspaces.find((workspace: any) => {
    const displayName = String(workspace?.display_name || '').trim().toLowerCase();
    return Boolean(displayName) && displayName === normalizedWorkspaceName;
  });

  if (typeof matchedWorkspace?.id === 'string' && matchedWorkspace.id.trim()) {
    return matchedWorkspace.id.trim();
  }

  if (workspaces.length === 1 && typeof workspaces[0]?.id === 'string' && workspaces[0].id.trim()) {
    return workspaces[0].id.trim();
  }

  return undefined;
}

async function configureLangSmithRuntime(): Promise<void> {
  const serviceKey = String(process.env.CONTROL_PLANE_LANGSMITH_SERVICE_KEY || '').trim();
  const personalKey = String(process.env.CONTROL_PLANE_LANGSMITH_PERSONAL_API_KEY || '').trim();
  const genericKey = String(
    process.env.CONTROL_PLANE_LANGSMITH_API_KEY
    || process.env.LANGSMITH_API_KEY
    || process.env.LANGCHAIN_API_KEY
    || '',
  ).trim();
  const runtimeKey = personalKey || serviceKey || genericKey;
  let workspaceId = String(
    process.env.CONTROL_PLANE_LANGSMITH_WORKSPACE_ID
    || process.env.LANGSMITH_WORKSPACE_ID
    || process.env.LANGCHAIN_WORKSPACE_ID
    || '',
  ).trim();
  const workspaceName = String(process.env.CONTROL_PLANE_LANGSMITH_WORKSPACE_NAME || 'anygpt').trim();
  if (!runtimeKey) return;

  if (!process.env.LANGCHAIN_API_KEY) process.env.LANGCHAIN_API_KEY = runtimeKey;
  if (!process.env.LANGSMITH_API_KEY) process.env.LANGSMITH_API_KEY = runtimeKey;
  if (!process.env.LANGCHAIN_TRACING_V2) process.env.LANGCHAIN_TRACING_V2 = 'true';
  if (!process.env.LANGSMITH_TRACING) process.env.LANGSMITH_TRACING = 'true';
  if (!process.env.LANGCHAIN_ENDPOINT) process.env.LANGCHAIN_ENDPOINT = 'https://api.smith.langchain.com';
  if (!process.env.LANGSMITH_ENDPOINT) process.env.LANGSMITH_ENDPOINT = 'https://api.smith.langchain.com';

  if (!workspaceId) {
    try {
      const discoveryKey = personalKey || serviceKey || genericKey;
      if (discoveryKey) {
        const discoveredWorkspaceId = await discoverLangSmithWorkspaceId(discoveryKey, workspaceName);
        if (discoveredWorkspaceId) {
          workspaceId = discoveredWorkspaceId;
        }
      }
    } catch (error) {
      console.warn(`[langgraph-control-plane] LangSmith workspace discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (workspaceId) {
    if (!process.env.LANGSMITH_WORKSPACE_ID) process.env.LANGSMITH_WORKSPACE_ID = workspaceId;
    if (!process.env.LANGCHAIN_WORKSPACE_ID) process.env.LANGCHAIN_WORKSPACE_ID = workspaceId;
  }
  if (!process.env.LANGCHAIN_PROJECT) {
    process.env.LANGCHAIN_PROJECT = process.env.CONTROL_PLANE_LANGSMITH_PROJECT || 'anygpt-control-plane';
  }
}

function resolveRunnerStatusPath(repoRoot: string, override?: string): string {
  const configuredPath = String(override || process.env.CONTROL_PLANE_RUNNER_STATUS_PATH || DEFAULT_RUNNER_STATUS_PATH).trim();
  return path.resolve(repoRoot, configuredPath || DEFAULT_RUNNER_STATUS_PATH);
}

function resolveRunnerPidPath(repoRoot: string, override?: string): string | undefined {
  const configuredPath = String(override || process.env.CONTROL_PLANE_RUNNER_PID_PATH || '').trim();
  if (!configuredPath) return undefined;
  return path.resolve(repoRoot, configuredPath);
}

function parseIntegerArg(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

function parseMaxIterations(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.max(1, Math.floor(parsed));
  return normalized;
}

function parseBooleanArg(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseEvaluationGateMode(value: string | undefined): ControlPlaneEvaluationGatePolicy['mode'] {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'off' || normalized === 'advisory' || normalized === 'enforce') {
    return normalized;
  }
  return 'advisory';
}

function parseEvaluationGateTarget(value: string | undefined): ControlPlaneEvaluationGatePolicy['target'] {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'execution' || normalized === 'autonomous-edits' || normalized === 'both') {
    return normalized;
  }
  return 'both';
}

function parseNormalizedScore(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function parseStringArrayArg(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseMetricThresholdMap(value: string | undefined): Record<string, number> {
  const entries = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const result: Record<string, number> = {};
  for (const entry of entries) {
    const [rawKey, rawValue] = entry.split(/[:=]/, 2);
    const key = String(rawKey || '').trim();
    if (!key) continue;
    result[key] = parseNormalizedScore(rawValue, 0);
  }
  return result;
}

function parseMetricWeightMap(value: string | undefined): Record<string, number> {
  const entries = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const result: Record<string, number> = {};
  for (const entry of entries) {
    const [rawKey, rawValue] = entry.split(/[:=]/, 2);
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    result[key] = parsed;
  }
  return result;
}

function parseEvaluationGateAggregationMode(value: string | undefined): NonNullable<ControlPlaneEvaluationGatePolicy['aggregationMode']> {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'weighted' ? 'weighted' : 'all';
}

function parseResumeValue(rawValue: string | undefined): unknown {
  if (typeof rawValue !== 'string') return undefined;
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function isInterruptChunk(value: unknown): value is { __interrupt__: unknown } {
  return Boolean(value && typeof value === 'object' && '__interrupt__' in value);
}

function printStreamChunk(chunk: unknown): void {
  const label = isInterruptChunk(chunk) ? 'INTERRUPT' : 'STREAM';
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(chunk, null, 2));
}

function writeRunnerStatus(statusFilePath: string, status: RunnerStatus): void {
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  const tempPath = `${statusFilePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(status, null, 2), 'utf8');
  fs.renameSync(tempPath, statusFilePath);
}

function writeRunnerPidFile(pidFilePath: string, pid: number): void {
  fs.mkdirSync(path.dirname(pidFilePath), { recursive: true });
  fs.writeFileSync(pidFilePath, `${pid}\n`, 'utf8');
}

function removeRunnerPidFile(pidFilePath: string, pid: number): void {
  try {
    const existingPid = fs.readFileSync(pidFilePath, 'utf8').trim();
    if (existingPid && existingPid !== String(pid)) return;
  } catch {
    return;
  }

  try {
    fs.rmSync(pidFilePath, { force: true });
  } catch {
    // Ignore PID cleanup failures during shutdown.
  }
}

function installRunnerLifecycleHooks(parsedArgs: ParsedArgs, getRunnerStatus: () => RunnerStatus): void {
  const pidFilePath = parsedArgs.pidFilePath;
  if (pidFilePath) {
    writeRunnerPidFile(pidFilePath, process.pid);
  }

  let finalized = false;
  const finalize = (patch: Partial<RunnerStatus>): void => {
    if (finalized) return;
    finalized = true;

    try {
      writeRunnerStatus(parsedArgs.statusFilePath, mergeRunnerStatus(getRunnerStatus(), patch));
    } catch (error) {
      console.error(`[langgraph-control-plane] Failed to update runner status during shutdown: ${formatError(error)}`);
    }

    if (pidFilePath) {
      removeRunnerPidFile(pidFilePath, process.pid);
    }
  };

  const handleSignal = (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void => {
    finalize({
      running: false,
      phase: 'failed',
      lastError: `Runner terminated by ${signal}.`,
      lastRunCompletedAt: new Date().toISOString(),
    });
    process.exit(0);
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
  process.once('SIGHUP', () => handleSignal('SIGHUP'));
}

function resolveLangSmithRunnerStatusSeed(): Partial<RunnerStatus> {
  const runtimeConfig = resolveLangSmithRuntimeConfig();
  if (!runtimeConfig) return {};

  const configuredWorkspaceName = String(process.env.CONTROL_PLANE_LANGSMITH_WORKSPACE_NAME || '').trim();

    return {
      langSmithOrganizationId: runtimeConfig.workspaceId || undefined,
      langSmithWorkspaceId: runtimeConfig.workspaceId || undefined,
      langSmithWorkspaceName: configuredWorkspaceName || undefined,
      langSmithProjectName: runtimeConfig.projectName || undefined,
      promptAvailableChannels: ['candidate', 'default', 'live'],
    };
}

function readPersistedLangSmithRunnerStatusSeed(statusFilePath: string): Partial<RunnerStatus> {
  if (!fs.existsSync(statusFilePath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(statusFilePath, 'utf8')) as Partial<RunnerStatus> | null;
    if (!parsed || typeof parsed !== 'object') return {};

    const accessibleWorkspaceNames = Array.isArray(parsed.langSmithAccessibleWorkspaceNames)
      ? parsed.langSmithAccessibleWorkspaceNames
          .map((entry) => String(entry || '').trim())
          .filter(Boolean)
          .slice(0, 10)
      : undefined;

    return {
      langSmithOrganizationId: typeof parsed.langSmithOrganizationId === 'string' && parsed.langSmithOrganizationId.trim()
        ? parsed.langSmithOrganizationId.trim()
        : undefined,
      langSmithWorkspaceId: typeof parsed.langSmithWorkspaceId === 'string' && parsed.langSmithWorkspaceId.trim()
        ? parsed.langSmithWorkspaceId.trim()
        : undefined,
      langSmithWorkspaceName: typeof parsed.langSmithWorkspaceName === 'string' && parsed.langSmithWorkspaceName.trim()
        ? parsed.langSmithWorkspaceName.trim()
        : undefined,
      langSmithWorkspaceRole: typeof parsed.langSmithWorkspaceRole === 'string' && parsed.langSmithWorkspaceRole.trim()
        ? parsed.langSmithWorkspaceRole.trim()
        : undefined,
      langSmithWorkspaceCount: typeof parsed.langSmithWorkspaceCount === 'number' && Number.isFinite(parsed.langSmithWorkspaceCount)
        ? parsed.langSmithWorkspaceCount
        : undefined,
      langSmithAccessibleWorkspaceNames: accessibleWorkspaceNames,
      langSmithProjectName: typeof parsed.langSmithProjectName === 'string' && parsed.langSmithProjectName.trim()
        ? parsed.langSmithProjectName.trim()
        : undefined,
      langSmithProjectId: typeof parsed.langSmithProjectId === 'string' && parsed.langSmithProjectId.trim()
        ? parsed.langSmithProjectId.trim()
        : undefined,
      langSmithProjectDescription: typeof parsed.langSmithProjectDescription === 'string' && parsed.langSmithProjectDescription.trim()
        ? parsed.langSmithProjectDescription.trim()
        : undefined,
      langSmithProjectVisibility: typeof parsed.langSmithProjectVisibility === 'string' && parsed.langSmithProjectVisibility.trim()
        ? parsed.langSmithProjectVisibility.trim()
        : typeof parsed.langSmithProjectId === 'string' && parsed.langSmithProjectId.trim()
          ? 'unknown'
          : typeof parsed.langSmithProjectName === 'string' && parsed.langSmithProjectName.trim()
            ? 'unknown'
            : undefined,
      promptSelectedChannel: typeof parsed.promptSelectedChannel === 'string' && parsed.promptSelectedChannel.trim()
        ? parsed.promptSelectedChannel.trim()
        : undefined,
      promptAvailableChannels: Array.isArray(parsed.promptAvailableChannels)
        ? parsed.promptAvailableChannels.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 10)
        : undefined,
      promptRollbackReference: typeof parsed.promptRollbackReference === 'string' && parsed.promptRollbackReference.trim()
        ? parsed.promptRollbackReference.trim()
        : undefined,
      promptPromotionReason: typeof parsed.promptPromotionReason === 'string' && parsed.promptPromotionReason.trim()
        ? parsed.promptPromotionReason.trim()
        : undefined,
      promptPromotionBlockedReason: typeof parsed.promptPromotionBlockedReason === 'string' && parsed.promptPromotionBlockedReason.trim()
        ? parsed.promptPromotionBlockedReason.trim()
        : undefined,
      governanceGateStatus: typeof parsed.governanceGateStatus === 'string' && parsed.governanceGateStatus.trim()
        ? parsed.governanceGateStatus.trim()
        : undefined,
      governanceGateReason: typeof parsed.governanceGateReason === 'string' && parsed.governanceGateReason.trim()
        ? parsed.governanceGateReason.trim()
        : undefined,
      governanceGateBlocks: Array.isArray(parsed.governanceGateBlocks)
        ? parsed.governanceGateBlocks.map((entry) => String(entry || '').trim()).filter(Boolean)
        : undefined,
      governanceGateActionableFlags: Array.isArray(parsed.governanceGateActionableFlags)
        ? parsed.governanceGateActionableFlags.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 10)
        : undefined,
      evaluationGateAggregationMode: typeof parsed.evaluationGateAggregationMode === 'string' && parsed.evaluationGateAggregationMode.trim()
        ? parsed.evaluationGateAggregationMode.trim()
        : undefined,
      evaluationGateMinimumWeightedScore: typeof parsed.evaluationGateMinimumWeightedScore === 'number' && Number.isFinite(parsed.evaluationGateMinimumWeightedScore)
        ? parsed.evaluationGateMinimumWeightedScore
        : undefined,
      evaluationGateWeightedAverageScore: typeof parsed.evaluationGateWeightedAverageScore === 'number' && Number.isFinite(parsed.evaluationGateWeightedAverageScore)
        ? parsed.evaluationGateWeightedAverageScore
        : undefined,
      evaluationGateScorecardStatus: typeof parsed.evaluationGateScorecardStatus === 'string' && parsed.evaluationGateScorecardStatus.trim()
        ? parsed.evaluationGateScorecardStatus.trim()
        : undefined,
      evaluationGateBaselineExperiment: typeof parsed.evaluationGateBaselineExperiment === 'string' && parsed.evaluationGateBaselineExperiment.trim()
        ? parsed.evaluationGateBaselineExperiment.trim()
        : undefined,
      evaluationGateComparisonUrl: typeof parsed.evaluationGateComparisonUrl === 'string' && parsed.evaluationGateComparisonUrl.trim()
        ? parsed.evaluationGateComparisonUrl.trim()
        : undefined,
      repairTouchedPaths: Array.isArray(parsed.repairTouchedPaths)
        ? parsed.repairTouchedPaths.map((entry) => String(entry || '').trim()).filter(Boolean)
        : undefined,
      observabilityTags: Array.isArray(parsed.observabilityTags)
        ? parsed.observabilityTags.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 20)
        : undefined,
    };
  } catch {
    return {};
  }
}

function readPersistedLangSmithCheckpointSeed(checkpointPath: string, threadId: string): Partial<RunnerStatus> {
  if (!fs.existsSync(checkpointPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as {
      storage?: Record<string, Record<string, Record<string, [string, string, string | undefined]>>>;
    } | null;
    const namespaces = parsed?.storage?.[threadId];
    if (!namespaces || typeof namespaces !== 'object') return {};

    let latestTimestamp = -Infinity;
    let latestSeed: Partial<RunnerStatus> = {};

    for (const checkpoints of Object.values(namespaces)) {
      if (!checkpoints || typeof checkpoints !== 'object') continue;

      for (const entry of Object.values(checkpoints)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;

        try {
          const checkpoint = JSON.parse(Buffer.from(entry[0], 'base64').toString('utf8')) as any;
          const timestamp = Date.parse(String(checkpoint?.ts || '')) || 0;
          const channelValues = checkpoint?.channel_values || {};
          const workspace = channelValues?.langSmithWorkspace && typeof channelValues.langSmithWorkspace === 'object'
            ? channelValues.langSmithWorkspace
            : null;
          const accessibleWorkspaces = Array.isArray(channelValues?.langSmithAccessibleWorkspaces)
            ? channelValues.langSmithAccessibleWorkspaces
            : [];
          const project = channelValues?.langSmithProject && typeof channelValues.langSmithProject === 'object'
            ? channelValues.langSmithProject
            : null;
          const projectName = typeof channelValues?.langSmithProjectName === 'string'
            ? channelValues.langSmithProjectName.trim()
            : '';

          const workspaceId = typeof workspace?.id === 'string' ? workspace.id.trim() : '';
          const workspaceName = typeof workspace?.displayName === 'string' ? workspace.displayName.trim() : '';
          const workspaceRole = typeof workspace?.roleName === 'string' ? workspace.roleName.trim() : '';
          const projectId = typeof project?.id === 'string' ? project.id.trim() : '';
          const projectDisplayName = typeof project?.name === 'string' ? project.name.trim() : projectName;
          const projectDescription = typeof project?.description === 'string' ? project.description.trim() : '';
          const projectVisibility = typeof project?.visibility === 'string' && project.visibility.trim()
            ? project.visibility.trim()
            : (projectId || projectDisplayName ? 'unknown' : '');

          const accessibleWorkspaceNames = accessibleWorkspaces
            .map((candidate: any) => String(candidate?.displayName || '').trim())
            .filter(Boolean)
            .slice(0, 10);

          const hasLangSmithIdentity = Boolean(
            workspaceId
            || workspaceName
            || accessibleWorkspaceNames.length > 0
            || projectId
            || projectDisplayName,
          );
          if (!hasLangSmithIdentity || timestamp < latestTimestamp) continue;

          latestTimestamp = timestamp;
          latestSeed = {
            langSmithOrganizationId: workspaceId || undefined,
            langSmithWorkspaceId: workspaceId || undefined,
            langSmithWorkspaceName: workspaceName || undefined,
            langSmithWorkspaceRole: workspaceRole || undefined,
            langSmithWorkspaceCount: accessibleWorkspaces.length > 0
              ? accessibleWorkspaces.length
              : (workspaceId || workspaceName ? 1 : undefined),
            langSmithAccessibleWorkspaceNames: accessibleWorkspaceNames.length > 0
              ? accessibleWorkspaceNames
              : (workspaceName ? [workspaceName] : undefined),
            langSmithProjectName: projectDisplayName || undefined,
            langSmithProjectId: projectId || undefined,
            langSmithProjectDescription: projectDescription || undefined,
            langSmithProjectVisibility: projectVisibility || undefined,
          };
        } catch {
          // Ignore malformed historical checkpoint entries.
        }
      }
    }

    return latestSeed;
  } catch {
    return {};
  }
}

function createBaseRunnerStatus(parsedArgs: ParsedArgs): RunnerStatus {
  const now = new Date().toISOString();
  const experimentalApiBaseUrl = String(
    process.env.CONTROL_PLANE_ANYGPT_API_BASE_URL
    || process.env.ANYGPT_API_BASE_URL
    || process.env.OPENAI_BASE_URL
    || DEFAULT_CONTROL_PLANE_EXPERIMENTAL_API_BASE_URL,
  ).trim() || DEFAULT_CONTROL_PLANE_EXPERIMENTAL_API_BASE_URL;
  const langSmithRunnerStatusSeed = {
    ...readPersistedLangSmithRunnerStatusSeed(parsedArgs.statusFilePath),
    ...readPersistedLangSmithCheckpointSeed(parsedArgs.checkpointPath, parsedArgs.threadId),
    ...resolveLangSmithRunnerStatusSeed(),
  };
  return {
    goal: parsedArgs.goal,
    scopes: parsedArgs.scopes,
    threadId: parsedArgs.threadId,
    continuous: parsedArgs.continuous,
    autonomous: parsedArgs.autonomous,
    autonomousEditEnabled: parsedArgs.autonomousEditEnabled,
    executePlan: parsedArgs.executePlan,
    approvalMode: parsedArgs.approvalMode,
    checkpointPath: parsedArgs.checkpointPath,
    statusFilePath: parsedArgs.statusFilePath,
    iteration: 0,
    maxIterations: parsedArgs.maxIterations,
    intervalMs: parsedArgs.intervalMs,
    running: false,
    phase: 'starting',
    promptIdentifier: parsedArgs.promptIdentifier,
    promptRequestedRef: parsedArgs.promptRef || undefined,
    promptRequestedChannel: parsedArgs.promptChannel,
    promptSyncEnabled: parsedArgs.promptSyncEnabled,
    promptSyncChannel: parsedArgs.promptSyncChannel,
    promptPromoteChannel: parsedArgs.promptPromoteChannel || undefined,
    governanceProfile: String(process.env.CONTROL_PLANE_GOVERNANCE_PROFILE || 'experimental').trim() || 'experimental',
    controlPlaneAiBackend: '',
    controlPlaneAiModel: '',
    experimentalApiBaseUrl,
    experimentalServiceName: DEFAULT_CONTROL_PLANE_EXPERIMENTAL_SERVICE,
    evaluationGateMode: parsedArgs.evaluationGatePolicy.mode,
    evaluationGateTarget: parsedArgs.evaluationGatePolicy.target,
    evaluationGateAggregationMode: parsedArgs.evaluationGatePolicy.aggregationMode,
    evaluationGateRequireEvaluation: parsedArgs.evaluationGatePolicy.requireEvaluation,
    evaluationGateMinResults: parsedArgs.evaluationGatePolicy.minResultCount,
    evaluationGateMetricKey: parsedArgs.evaluationGatePolicy.metricKey,
    evaluationGateMinMetricAverageScore: parsedArgs.evaluationGatePolicy.minMetricAverageScore,
    evaluationGateMinimumWeightedScore: parsedArgs.evaluationGatePolicy.minimumWeightedScore,
    evaluationGateStatus: parsedArgs.evaluationGatePolicy.mode === 'off' ? 'disabled' : 'not-evaluated',
    evaluationGateReason: parsedArgs.evaluationGatePolicy.mode === 'off'
      ? 'Evaluation gate disabled.'
      : 'Evaluation gate has not been evaluated yet.',
    evaluationGateBlocks: [],
    evaluationGateWeightedAverageScore: null,
    evaluationGateScorecardStatus: 'not-evaluated',
    evaluationGateBaselineExperiment: parsedArgs.evaluationGatePolicy.baselineExperimentName || '',
    evaluationGateComparisonUrl: '',
    repairStatus: parsedArgs.autonomousEditEnabled ? 'idle' : 'not-needed',
    repairDecisionReason: '',
    repairIntentSummary: '',
    repairSignalCount: 0,
    autonomousOperationMode: 'idle',
    improvementIntentSummary: '',
    improvementSignalCount: 0,
    repairSessionId: '',
    repairRollbackStatus: 'not-required',
    repairSmokeJobCount: 0,
    repairSmokeFailedCount: 0,
    postRepairValidationStatus: 'not-needed',
    postRepairValidationJobCount: 0,
    postRepairValidationFailedCount: 0,
    repairPromotedPaths: [],
    repairRollbackPaths: [],
    repairTouchedPaths: [],
    experimentalRestartStatus: 'not-needed',
    experimentalRestartReason: '',
    governanceGateStatus: 'not-evaluated',
    governanceGateReason: 'Governance gate has not been evaluated yet.',
    governanceGateBlocks: [],
    governanceGateActionableFlags: [],
    promptSelectedChannel: '',
    promptAvailableChannels: [],
    promptRollbackReference: '',
    promptPromotionReason: '',
    promptPromotionBlockedReason: '',
    observabilityTags: [],
    ...langSmithRunnerStatusSeed,
    lastUpdatedAt: now,
    startedAt: now,
    sawInterrupt: false,
  };
}

function mergeRunnerStatus(status: RunnerStatus, patch: Partial<RunnerStatus>): RunnerStatus {
  return {
    ...status,
    ...patch,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): ParsedArgs {
  const argMap = new Map<string, string>();
  let executePlan = false;
  let allowDeploy = false;
  let autoApprove = false;
  let continuous = false;
  let autonomous = false;
  let autonomousEditEnabled = false;

  for (const arg of argv) {
    if (arg === '--execute') {
      executePlan = true;
      continue;
    }
    if (arg === '--allow-deploy') {
      allowDeploy = true;
      continue;
    }
    if (arg === '--auto-approve') {
      autoApprove = true;
      continue;
    }
    if (arg === '--continuous') {
      continuous = true;
      continue;
    }
    if (arg === '--autonomous') {
      autonomous = true;
      continuous = true;
      executePlan = true;
      autoApprove = true;
      autonomousEditEnabled = true;
      continue;
    }
    if (arg === '--autonomous-edits') {
      autonomousEditEnabled = true;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, value] = arg.slice(2).split(/=(.*)/s, 2);
      argMap.set(key, value);
    }
  }

  const scopes = (argMap.get('scopes') || 'repo')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const repoRoot = path.resolve(
    argMap.get('repo-root')
    || process.env.CONTROL_PLANE_REPO_ROOT
    || DEFAULT_REPO_ROOT,
  );
  const intervalMs = parseIntegerArg(
    argMap.get('interval-ms') || process.env.CONTROL_PLANE_INTERVAL_MS,
    continuous || autonomous ? 10_000 : 60_000,
    1_000,
  );
  const maxIterations = parseMaxIterations(argMap.get('max-iterations'));
  const maxEditActions = parseIntegerArg(argMap.get('max-edit-actions'), 5, 1);
  const promptIdentifier = String(
    argMap.get('prompt-identifier')
    || process.env.CONTROL_PLANE_PROMPT_IDENTIFIER
    || DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER,
  ).trim() || DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER;
  const promptRef = String(argMap.get('prompt-ref') || process.env.CONTROL_PLANE_PROMPT_REF || '').trim();
  const promptChannel = String(
    argMap.get('prompt-channel')
    || process.env.CONTROL_PLANE_PROMPT_CHANNEL
    || DEFAULT_CONTROL_PLANE_PROMPT_CHANNEL,
  ).trim() || DEFAULT_CONTROL_PLANE_PROMPT_CHANNEL;
  const promptSyncEnabled = parseBooleanArg(
    argMap.get('prompt-sync') || process.env.CONTROL_PLANE_PROMPT_SYNC,
    true,
  );
  const promptSyncChannel = String(
    argMap.get('prompt-sync-channel')
    || process.env.CONTROL_PLANE_PROMPT_SYNC_CHANNEL
    || DEFAULT_CONTROL_PLANE_PROMPT_SYNC_CHANNEL,
  ).trim() || DEFAULT_CONTROL_PLANE_PROMPT_SYNC_CHANNEL;
  const promptPromoteChannel = String(
    argMap.get('prompt-promote')
    || process.env.CONTROL_PLANE_PROMPT_PROMOTE_CHANNEL
    || '',
  ).trim();
  const editAllowlist = resolveAutonomousEditAllowlist(
    argMap.get('edit-allowlist') || process.env.CONTROL_PLANE_EDIT_ALLOWLIST,
  );
  const editDenylist = resolveAutonomousEditDenylist(
    argMap.get('edit-denylist') || process.env.CONTROL_PLANE_EDIT_DENYLIST,
  );
  const evaluationGatePolicy: ControlPlaneEvaluationGatePolicy = {
    mode: parseEvaluationGateMode(argMap.get('eval-gate-mode') || process.env.CONTROL_PLANE_EVAL_GATE_MODE),
    target: parseEvaluationGateTarget(argMap.get('eval-gate-target') || process.env.CONTROL_PLANE_EVAL_GATE_TARGET),
    aggregationMode: parseEvaluationGateAggregationMode(
      argMap.get('eval-gate-aggregation-mode') || process.env.CONTROL_PLANE_EVAL_GATE_AGGREGATION_MODE,
    ),
    requireEvaluation: parseBooleanArg(
      argMap.get('eval-gate-require-evaluation') || process.env.CONTROL_PLANE_EVAL_GATE_REQUIRE_EVALUATION,
      false,
    ),
    minResultCount: parseIntegerArg(
      argMap.get('eval-gate-min-results') || process.env.CONTROL_PLANE_EVAL_GATE_MIN_RESULTS,
      1,
      1,
    ),
    metricKey: String(
      argMap.get('eval-gate-metric')
      || process.env.CONTROL_PLANE_EVAL_GATE_METRIC
      || 'contains_goal_context',
    ).trim() || 'contains_goal_context',
    minMetricAverageScore: parseNormalizedScore(
      argMap.get('eval-gate-min-score') || process.env.CONTROL_PLANE_EVAL_GATE_MIN_SCORE,
      1,
    ),
    requiredMetricKeys: parseStringArrayArg(
      argMap.get('eval-gate-required-metrics') || process.env.CONTROL_PLANE_EVAL_GATE_REQUIRED_METRICS,
    ),
    additionalMetricThresholds: parseMetricThresholdMap(
      argMap.get('eval-gate-metric-thresholds') || process.env.CONTROL_PLANE_EVAL_GATE_METRIC_THRESHOLDS,
    ),
    metricWeights: parseMetricWeightMap(
      argMap.get('eval-gate-metric-weights') || process.env.CONTROL_PLANE_EVAL_GATE_METRIC_WEIGHTS,
    ),
    minimumWeightedScore: parseNormalizedScore(
      argMap.get('eval-gate-min-weighted-score') || process.env.CONTROL_PLANE_EVAL_GATE_MIN_WEIGHTED_SCORE,
      0,
    ),
    scorecardName: String(
      argMap.get('eval-gate-scorecard-name')
      || process.env.CONTROL_PLANE_EVAL_GATE_SCORECARD_NAME
      || 'control-plane-scorecard',
    ).trim() || 'control-plane-scorecard',
    baselineExperimentName: String(
      argMap.get('eval-gate-baseline-experiment')
      || process.env.CONTROL_PLANE_EVAL_GATE_BASELINE_EXPERIMENT
      || '',
    ).trim(),
  };

  return {
    goal: argMap.get('goal') || 'Build, test, and prepare deployment steps for this repository.',
    scopes,
    threadId: argMap.get('thread-id') || randomUUID(),
    approvalMode: autoApprove ? 'auto' : 'manual',
    continuous,
    autonomous,
    autonomousEditEnabled,
    editAllowlist,
    editDenylist,
    maxEditActions,
    intervalMs,
    maxIterations,
    executePlan,
    allowDeploy,
    deployCommand: argMap.get('deploy-command') || '',
    promptIdentifier,
    promptRef,
    promptChannel,
    promptSyncEnabled,
    promptSyncChannel,
    promptPromoteChannel,
    evaluationGatePolicy,
    repoRoot,
    mcpConfigPath: argMap.get('mcp-config') || '.roo/mcp.json',
    checkpointPath: resolveControlPlaneCheckpointPath(repoRoot, argMap.get('checkpoint-path')),
    statusFilePath: resolveRunnerStatusPath(repoRoot, argMap.get('status-file')),
    pidFilePath: resolveRunnerPidPath(repoRoot, argMap.get('pid-file')),
    streamMode: argMap.get('stream-mode') === 'values' ? 'values' : 'updates',
    resumeValue: parseResumeValue(argMap.get('resume')),
  };
}

async function runGraphOnce(
  parsedArgs: ParsedArgs,
  controlPlaneGraph: Awaited<ReturnType<typeof createControlPlaneGraph>>['graph'],
  runnerStatus: RunnerStatus,
): Promise<{ result: ReturnType<typeof ControlPlaneStateSchema.parse>; sawInterrupt: boolean }> {
  const initialState = ControlPlaneStateSchema.parse(parsedArgs);
  const config = {
    configurable: {
      thread_id: parsedArgs.threadId,
    },
    streamMode: parsedArgs.streamMode,
  };
  const input = typeof parsedArgs.resumeValue === 'undefined'
    ? initialState
    : new Command({ resume: parsedArgs.resumeValue });
  let lastChunk: unknown = undefined;
  let sawInterrupt = false;

  console.log(`[langgraph-control-plane] thread_id=${parsedArgs.threadId}`);
  console.log(`[langgraph-control-plane] checkpoint_path=${path.relative(parsedArgs.repoRoot, parsedArgs.checkpointPath)}`);
  console.log(`[langgraph-control-plane] status_file=${path.relative(parsedArgs.repoRoot, parsedArgs.statusFilePath)}`);

  writeRunnerStatus(
    parsedArgs.statusFilePath,
    mergeRunnerStatus(runnerStatus, {
      running: true,
      phase: 'streaming',
      lastRunStartedAt: new Date().toISOString(),
      sawInterrupt: false,
      summary: undefined,
      lastError: undefined,
    }),
  );

  for await (const chunk of await controlPlaneGraph.stream(input as any, config as any)) {
    lastChunk = chunk;
    if (isInterruptChunk(chunk)) {
      sawInterrupt = true;
    }
    printStreamChunk(chunk);
  }

  const stateSnapshot = await controlPlaneGraph.getState(config as any).catch(() => undefined);
  const fallbackValues = lastChunk && typeof lastChunk === 'object' ? lastChunk : {};
  const result = ControlPlaneStateSchema.parse({
    ...initialState,
    ...(stateSnapshot?.values || {}),
    ...(fallbackValues as Record<string, unknown>),
  });

  console.log(result.summary);
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(result, null, 2));

  if (sawInterrupt) {
    console.log('\n--- RESUME ---');
    console.log(`bash ./bun.sh run ./apps/langgraph-control-plane/src/index.ts --thread-id=${parsedArgs.threadId} --resume=approve`);
  }

  return { result, sawInterrupt };
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  loadEnvForControlPlane(parsedArgs.repoRoot);
  await configureLangSmithRuntime();
  const { graph: controlPlaneGraph, checkpointer } = await createControlPlaneGraph({
    repoRoot: parsedArgs.repoRoot,
    checkpointPath: parsedArgs.checkpointPath,
  });
  let runnerStatus = createBaseRunnerStatus(parsedArgs);
  writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);
  installRunnerLifecycleHooks(parsedArgs, () => runnerStatus);

  let iteration = 0;
  while (true) {
    iteration += 1;
    runnerStatus = mergeRunnerStatus(runnerStatus, {
      iteration,
      running: true,
      phase: 'starting',
    });
    writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);

    try {
      const { result, sawInterrupt } = await runGraphOnce(parsedArgs, controlPlaneGraph, runnerStatus);
      runnerStatus = mergeRunnerStatus(runnerStatus, {
        running: parsedArgs.continuous && !sawInterrupt,
        phase: sawInterrupt ? 'paused' : 'completed',
        sawInterrupt,
        proposedEditCount: Array.isArray(result.proposedEdits) ? result.proposedEdits.length : 0,
        appliedEditCount: Array.isArray(result.appliedEdits)
          ? result.appliedEdits.filter((edit: any) => edit?.status === 'applied').length
          : 0,
        lastAppliedEditPaths: Array.isArray(result.appliedEdits)
          ? result.appliedEdits
              .filter((edit: any) => edit?.status === 'applied' && typeof edit?.path === 'string')
              .map((edit: any) => edit.path)
          : [],
        repairStatus: typeof (result as any).repairStatus === 'string'
          ? (result as any).repairStatus
          : runnerStatus.repairStatus,
        repairDecisionReason: typeof (result as any).repairDecisionReason === 'string'
          ? (result as any).repairDecisionReason
          : runnerStatus.repairDecisionReason,
        repairIntentSummary: typeof (result as any).repairIntentSummary === 'string'
          ? (result as any).repairIntentSummary
          : runnerStatus.repairIntentSummary,
        repairSignalCount: Array.isArray((result as any).repairSignals)
          ? (result as any).repairSignals.length
          : 0,
        autonomousOperationMode: typeof (result as any).autonomousOperationMode === 'string'
          ? (result as any).autonomousOperationMode
          : runnerStatus.autonomousOperationMode,
        improvementIntentSummary: typeof (result as any).improvementIntentSummary === 'string'
          ? (result as any).improvementIntentSummary
          : runnerStatus.improvementIntentSummary,
        improvementSignalCount: Array.isArray((result as any).improvementSignals)
          ? (result as any).improvementSignals.length
          : 0,
        repairSessionId: typeof (result as any).repairSessionManifest?.sessionId === 'string'
          ? (result as any).repairSessionManifest.sessionId
          : '',
        repairRollbackStatus: typeof (result as any).repairSessionManifest?.rollbackStatus === 'string'
          ? (result as any).repairSessionManifest.rollbackStatus
          : '',
        repairSmokeJobCount: Array.isArray((result as any).repairSmokeResults)
          ? (result as any).repairSmokeResults.length
          : Array.isArray((result as any).repairSmokeJobs)
            ? (result as any).repairSmokeJobs.length
            : 0,
        repairSmokeFailedCount: Array.isArray((result as any).repairSmokeResults)
          ? (result as any).repairSmokeResults.filter((job: any) => job?.status === 'failed').length
          : 0,
        postRepairValidationStatus: typeof (result as any).postRepairValidationStatus === 'string'
          ? (result as any).postRepairValidationStatus
          : runnerStatus.postRepairValidationStatus,
        postRepairValidationJobCount: Array.isArray((result as any).postRepairValidationResults)
          ? (result as any).postRepairValidationResults.length
          : Array.isArray((result as any).postRepairValidationJobs)
            ? (result as any).postRepairValidationJobs.length
            : 0,
        postRepairValidationFailedCount: Array.isArray((result as any).postRepairValidationResults)
          ? (result as any).postRepairValidationResults.filter((job: any) => job?.status === 'failed').length
          : 0,
        repairPromotedPaths: Array.isArray((result as any).repairPromotedPaths)
          ? (result as any).repairPromotedPaths
              .map((entry: any) => String(entry || '').trim())
              .filter(Boolean)
          : [],
        repairRollbackPaths: Array.isArray((result as any).repairRollbackPaths)
          ? (result as any).repairRollbackPaths
              .map((entry: any) => String(entry || '').trim())
              .filter(Boolean)
          : [],
        experimentalRestartStatus: typeof (result as any).experimentalRestartStatus === 'string'
          ? (result as any).experimentalRestartStatus
          : runnerStatus.experimentalRestartStatus,
        experimentalRestartReason: typeof (result as any).experimentalRestartReason === 'string'
          ? (result as any).experimentalRestartReason
          : runnerStatus.experimentalRestartReason,
        langSmithOrganizationId: typeof (result as any).langSmithWorkspace?.id === 'string'
          && String((result as any).langSmithWorkspace.id).trim()
          ? String((result as any).langSmithWorkspace.id).trim()
          : runnerStatus.langSmithOrganizationId,
        langSmithWorkspaceId: typeof (result as any).langSmithWorkspace?.id === 'string'
          && String((result as any).langSmithWorkspace.id).trim()
          ? String((result as any).langSmithWorkspace.id).trim()
          : runnerStatus.langSmithWorkspaceId,
        langSmithWorkspaceName: typeof (result as any).langSmithWorkspace?.displayName === 'string'
          && String((result as any).langSmithWorkspace.displayName).trim()
          ? String((result as any).langSmithWorkspace.displayName).trim()
          : runnerStatus.langSmithWorkspaceName,
        langSmithWorkspaceRole: typeof (result as any).langSmithWorkspace?.roleName === 'string'
          && String((result as any).langSmithWorkspace.roleName).trim()
          ? String((result as any).langSmithWorkspace.roleName).trim()
          : runnerStatus.langSmithWorkspaceRole,
        langSmithProjectName: typeof (result as any).langSmithProject?.name === 'string'
          && String((result as any).langSmithProject.name).trim()
          ? String((result as any).langSmithProject.name).trim()
          : typeof (result as any).langSmithProjectName === 'string'
            && String((result as any).langSmithProjectName).trim()
            ? String((result as any).langSmithProjectName).trim()
            : runnerStatus.langSmithProjectName,
        langSmithWorkspaceCount: Array.isArray((result as any).langSmithAccessibleWorkspaces)
          ? (result as any).langSmithAccessibleWorkspaces.length
          : 0,
        langSmithAccessibleWorkspaceNames: Array.isArray((result as any).langSmithAccessibleWorkspaces)
          ? (result as any).langSmithAccessibleWorkspaces
              .map((workspace: any) => String(workspace?.displayName || '').trim())
              .filter(Boolean)
              .slice(0, 10)
          : [],
        langSmithProjectId: typeof (result as any).langSmithProject?.id === 'string'
          ? (result as any).langSmithProject.id
          : '',
        langSmithProjectDescription: typeof (result as any).langSmithProject?.description === 'string'
          ? (result as any).langSmithProject.description
          : '',
        langSmithProjectVisibility: typeof (result as any).langSmithProject?.visibility === 'string'
          && String((result as any).langSmithProject.visibility).trim()
          ? String((result as any).langSmithProject.visibility).trim()
          : runnerStatus.langSmithProjectVisibility,
        langSmithAnnotationQueueCount: Array.isArray((result as any).langSmithAnnotationQueues)
          ? (result as any).langSmithAnnotationQueues.length
          : 0,
        langSmithAnnotationQueueItemCount: Array.isArray((result as any).langSmithAnnotationQueueItems)
          ? (result as any).langSmithAnnotationQueueItems.length
          : 0,
        langSmithFeedbackCount: Array.isArray((result as any).langSmithFeedback)
          ? (result as any).langSmithFeedback.length
          : 0,
        langSmithFeedbackKeys: Array.isArray((result as any).langSmithFeedback)
          ? (result as any).langSmithFeedback
              .reduce((keys: string[], entry: any) => {
                const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
                if (key && !keys.includes(key)) {
                  keys.push(key);
                }
                return keys;
              }, [])
              .slice(0, 10)
          : [],
        langSmithEvaluationCount: Array.isArray((result as any).langSmithEvaluations)
          ? (result as any).langSmithEvaluations.length
          : 0,
        langSmithEvaluationDatasets: Array.isArray((result as any).langSmithEvaluations)
          ? (result as any).langSmithEvaluations
              .map((evaluation: any) => String(evaluation?.datasetName || '').trim())
              .filter(Boolean)
          : [],
        langSmithEvaluationMetrics: Array.isArray((result as any).langSmithEvaluations)
          ? (result as any).langSmithEvaluations
              .flatMap((evaluation: any) => Array.isArray(evaluation?.metrics)
                ? evaluation.metrics.map((metric: any) => {
                    const key = String(metric?.key || '').trim();
                    const average = typeof metric?.averageScore === 'number' ? metric.averageScore : 'n/a';
                    const count = typeof metric?.count === 'number' ? metric.count : 0;
                    return key ? `${key}=${average}x${count}` : '';
                  })
                : [])
              .filter(Boolean)
              .slice(0, 12)
          : [],
        langSmithGovernanceFlagCount: Array.isArray((result as any).langSmithGovernance?.flags)
          ? (result as any).langSmithGovernance.flags.length
          : 0,
        langSmithGovernanceAttentionFlags: Array.isArray((result as any).langSmithGovernance?.flags)
          ? (result as any).langSmithGovernance.flags
              .filter((flag: any) => typeof flag?.status === 'string' && flag.status !== 'pass')
              .map((flag: any) => `${String(flag?.key || '').trim()}:${String(flag?.status || '').trim()}`)
              .filter(Boolean)
              .slice(0, 10)
          : [],
        langSmithGovernanceMutationCount: Array.isArray((result as any).langSmithGovernance?.mutations)
          ? (result as any).langSmithGovernance.mutations.length
          : 0,
        langSmithGovernanceMutations: Array.isArray((result as any).langSmithGovernance?.mutations)
          ? (result as any).langSmithGovernance.mutations
              .map((mutation: any) => `${String(mutation?.key || '').trim()}:${String(mutation?.status || '').trim()}`)
              .filter(Boolean)
              .slice(0, 10)
          : [],
        promptSelectionSource: typeof (result as any).selectedPromptSource === 'string'
          ? (result as any).selectedPromptSource
          : 'local',
        promptSelectedRef: typeof (result as any).selectedPromptReference === 'string'
          ? (result as any).selectedPromptReference
          : parsedArgs.promptIdentifier,
        promptSelectedChannel: typeof (result as any).selectedPromptChannel === 'string'
          ? (result as any).selectedPromptChannel
          : '',
        promptAvailableChannels: Array.isArray((result as any).selectedPromptAvailableChannels)
          ? (result as any).selectedPromptAvailableChannels
              .map((channel: any) => String(channel || '').trim())
              .filter(Boolean)
              .slice(0, 10)
          : [],
        promptCommitHash: typeof (result as any).selectedPromptCommitHash === 'string'
          ? (result as any).selectedPromptCommitHash
          : '',
        promptRollbackReference: typeof (result as any).promptRollbackReference === 'string'
          ? (result as any).promptRollbackReference
          : '',
        promptSyncUrl: typeof (result as any).promptSyncUrl === 'string'
          ? (result as any).promptSyncUrl
          : '',
        promptPromotionUrl: typeof (result as any).promptPromotionUrl === 'string'
          ? (result as any).promptPromotionUrl
          : '',
        promptPromotionReason: typeof (result as any).promptPromotionReason === 'string'
          ? (result as any).promptPromotionReason
          : '',
        promptPromotionBlockedReason: typeof (result as any).promptPromotionBlockedReason === 'string'
          ? (result as any).promptPromotionBlockedReason
          : '',
        governanceProfile: typeof (result as any).governanceProfile === 'string'
          ? (result as any).governanceProfile
          : runnerStatus.governanceProfile,
        governanceGateStatus: typeof (result as any).governanceGateResult?.status === 'string'
          ? (result as any).governanceGateResult.status
          : runnerStatus.governanceGateStatus,
        governanceGateReason: typeof (result as any).governanceGateResult?.reason === 'string'
          ? (result as any).governanceGateResult.reason
          : runnerStatus.governanceGateReason,
        governanceGateBlocks: [
          (result as any).governanceGateResult?.blocksAutonomousEdits ? 'autonomous-edits' : '',
          (result as any).governanceGateResult?.blocksExecution ? 'execution' : '',
        ].filter(Boolean),
        governanceGateActionableFlags: Array.isArray((result as any).governanceGateResult?.actionableFlagKeys)
          ? (result as any).governanceGateResult.actionableFlagKeys
              .map((flag: any) => String(flag || '').trim())
              .filter(Boolean)
              .slice(0, 10)
          : [],
        controlPlaneAiBackend: typeof (result as any).aiAgentBackend === 'string'
          ? (result as any).aiAgentBackend
          : runnerStatus.controlPlaneAiBackend,
        controlPlaneAiModel: typeof (result as any).aiAgentModel === 'string'
          ? (result as any).aiAgentModel
          : runnerStatus.controlPlaneAiModel,
        experimentalApiBaseUrl: typeof (result as any).experimentalApiBaseUrl === 'string'
          ? (result as any).experimentalApiBaseUrl
          : runnerStatus.experimentalApiBaseUrl,
        experimentalServiceName: typeof (result as any).experimentalServiceName === 'string'
          ? (result as any).experimentalServiceName
          : runnerStatus.experimentalServiceName,
        promptSelectionNotes: Array.isArray((result as any).promptSelectionNotes)
          ? (result as any).promptSelectionNotes
              .map((note: any) => String(note || '').trim())
              .filter(Boolean)
              .slice(-10)
          : [],
        evaluationGateStatus: typeof (result as any).evaluationGateResult?.status === 'string'
          ? (result as any).evaluationGateResult.status
          : runnerStatus.evaluationGateStatus,
        evaluationGateReason: typeof (result as any).evaluationGateResult?.reason === 'string'
          ? (result as any).evaluationGateResult.reason
          : runnerStatus.evaluationGateReason,
        evaluationGateAggregationMode: typeof (result as any).evaluationGateResult?.aggregationMode === 'string'
          ? (result as any).evaluationGateResult.aggregationMode
          : runnerStatus.evaluationGateAggregationMode,
        evaluationGateBlocks: [
          (result as any).evaluationGateResult?.blocksAutonomousEdits ? 'autonomous-edits' : '',
          (result as any).evaluationGateResult?.blocksExecution ? 'execution' : '',
        ].filter(Boolean),
        evaluationGateMetricAverageScore: typeof (result as any).evaluationGateResult?.metricAverageScore === 'number'
          ? (result as any).evaluationGateResult.metricAverageScore
          : null,
        evaluationGateWeightedAverageScore: typeof (result as any).evaluationGateResult?.weightedAverageScore === 'number'
          ? (result as any).evaluationGateResult.weightedAverageScore
          : null,
        evaluationGateMetricCount: typeof (result as any).evaluationGateResult?.metricCount === 'number'
          ? (result as any).evaluationGateResult.metricCount
          : 0,
        evaluationGateMinimumWeightedScore: typeof (result as any).evaluationGateResult?.minimumWeightedScore === 'number'
          ? (result as any).evaluationGateResult.minimumWeightedScore
          : runnerStatus.evaluationGateMinimumWeightedScore,
        evaluationGateScorecardStatus: typeof (result as any).evaluationGateResult?.scorecardStatus === 'string'
          ? (result as any).evaluationGateResult.scorecardStatus
          : runnerStatus.evaluationGateScorecardStatus,
        evaluationGateBaselineExperiment: typeof (result as any).evaluationGateResult?.baselineExperimentName === 'string'
          ? (result as any).evaluationGateResult.baselineExperimentName
          : runnerStatus.evaluationGateBaselineExperiment,
        evaluationGateComparisonUrl: typeof (result as any).evaluationGateResult?.comparisonUrl === 'string'
          ? (result as any).evaluationGateResult.comparisonUrl
          : runnerStatus.evaluationGateComparisonUrl,
        evaluationGateMetricResults: Array.isArray((result as any).evaluationGateResult?.metricResults)
          ? (result as any).evaluationGateResult.metricResults
              .map((metric: any) => {
                const key = String(metric?.key || '').trim();
                if (!key) return '';
                const average = typeof metric?.averageScore === 'number' ? metric.averageScore : 'n/a';
                const count = typeof metric?.count === 'number' ? metric.count : 0;
                const threshold = typeof metric?.minAverageScore === 'number' ? metric.minAverageScore : 0;
                const baseline = typeof metric?.baselineAverageScore === 'number' ? metric.baselineAverageScore : null;
                const delta = typeof metric?.deltaAverageScore === 'number' ? metric.deltaAverageScore : null;
                const weight = typeof metric?.weight === 'number' ? metric.weight : null;
                return `${key}=${average}x${count}/${threshold}${baseline !== null ? ` baseline=${baseline}` : ''}${delta !== null ? ` delta=${delta}` : ''}${weight !== null ? ` weight=${weight}` : ''}`;
              })
              .filter(Boolean)
              .slice(0, 12)
          : [],
        evaluationResultCount: typeof (result as any).evaluationGateResult?.resultCount === 'number'
          ? (result as any).evaluationGateResult.resultCount
          : 0,
        repairTouchedPaths: Array.isArray((result as any).repairSessionManifest?.touchedFiles)
          ? (result as any).repairSessionManifest.touchedFiles
              .map((file: any) => String(file?.path || '').trim())
              .filter(Boolean)
          : [],
        observabilityTags: Array.isArray((result as any).observabilityTags)
          ? (result as any).observabilityTags
              .map((tag: any) => String(tag || '').trim())
              .filter(Boolean)
              .slice(0, 20)
          : [],
        summary: result.summary,
        lastRunCompletedAt: new Date().toISOString(),
      });
      writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);

      if (!parsedArgs.continuous || sawInterrupt) {
        break;
      }

      await checkpointer.deleteThread(parsedArgs.threadId).catch((error) => {
        console.warn(`[langgraph-control-plane] Failed to compact completed checkpoint thread ${parsedArgs.threadId}: ${formatError(error)}`);
      });

      if (parsedArgs.maxIterations !== null && iteration >= parsedArgs.maxIterations) {
        runnerStatus = mergeRunnerStatus(runnerStatus, {
          running: false,
          phase: 'completed',
        });
        writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);
        break;
      }

      runnerStatus = mergeRunnerStatus(runnerStatus, {
        running: true,
        phase: 'sleeping',
      });
      writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);
      console.log(`\n[langgraph-control-plane] sleeping ${parsedArgs.intervalMs}ms before next iteration...`);
      await sleep(parsedArgs.intervalMs);
    } catch (error) {
      runnerStatus = mergeRunnerStatus(runnerStatus, {
        running: false,
        phase: 'failed',
        lastError: formatError(error),
      });
      writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);
      throw error;
    }
  }
}

main().catch((error) => {
  console.error('[langgraph-control-plane] Failed to run workflow.');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
