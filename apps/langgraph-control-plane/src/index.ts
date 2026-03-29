import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from '@langchain/langgraph';
import dotenv from 'dotenv';

import {
  ControlPlaneStateSchema,
  createControlPlaneGraph,
  resolveControlPlaneAiConfig,
  resolveControlPlaneCheckpointPath,
  writeSemanticMemoryNotes,
  type ControlPlaneEvaluationGatePolicy,
  type ScopeExpansionMode,
} from './workflow.js';
import {
  AppliedAutonomousEditSchema,
  resolveAutonomousEditAllowlist,
  resolveAutonomousEditDenylist,
} from './autonomousEdits.js';
import { resolveLangSmithRuntimeConfig } from './langsmithClient.js';

type ParsedArgs = {
  goal: string;
  scopes: string[];
  threadId: string;
  multiRunner: boolean;
  coordinatorChildId?: string;
  coordinatorParentThreadId?: string;
  scopeExpansionMode: ScopeExpansionMode;
  approvalMode: 'manual' | 'auto';
  continuous: boolean;
  autonomous: boolean;
  autonomousEditEnabled: boolean;
  mcpActionEnabled: boolean;
  maxMcpActions: number;
  mcpTargetUrls: string[];
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
  replayCheckpointId?: string;
  forkCheckpointId?: string;
  forkStateJson?: string;
  subgraphs: boolean;
};

type RunnerStatus = {
  goal: string;
  scopes: string[];
  effectiveScopes?: string[];
  scopeExpansionReason?: string;
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
  recentAutonomousEditFailures?: unknown[];
  recentAutonomousLearningNotes?: string[];
  noProgressStreak?: number;
  noProgressReason?: string;
  lastProgressSignature?: string;
  repairStatus?: string;
  healthClass?: 'healthy' | 'degraded' | 'waiting_evidence' | 'blocked_external' | 'failed';
  deferReason?: string;
  evidenceStatus?: 'unknown' | 'not-required' | 'planned' | 'collected' | 'validated' | 'missing';
  lastAiFailureClass?: 'none' | 'timeout' | 'backpressure' | 'malformed-output' | 'backend-error';
  validationRequired?: boolean;
  repairDecisionReason?: string;
  repairIntentSummary?: string;
  repairSignalCount?: number;
  autonomousOperationMode?: string;
  autonomousPlannerAgentCount?: number;
  autonomousPlannerFocuses?: string[];
  autonomousPlannerStrategy?: string;
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
  productionRestartStatus?: string;
  productionRestartReason?: string;
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
  productionServiceName?: string;
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
  latestCheckpointId?: string;
  latestCheckpointCreatedAt?: string;
  checkpointCount?: number;
  checkpointNextNodes?: string[];
  replayCheckpointId?: string;
  lastForkCheckpointId?: string;
  subgraphStreamingEnabled?: boolean;
  observabilityTags?: string[];
  summary?: string;
  runnerMode?: 'single-runner' | 'multi-runner-coordinator' | 'multi-runner-child';
  coordinatorChildId?: string;
  coordinatorParentThreadId?: string;
  scopeExpansionMode?: ScopeExpansionMode;
  coordinatorStrategy?: string;
  coordinatorPollMs?: number;
  coordinatedRunnerCount?: number;
  coordinatedRunners?: CoordinatedRunnerStatusEntry[];
};

type CoordinatedRunnerStatusEntry = {
  id: string;
  label: string;
  threadId: string;
  scopes: string[];
  editAllowlist: string[];
  checkpointPath: string;
  statusFilePath: string;
  pidFilePath?: string;
  logFilePath: string;
  pid?: number;
  running: boolean;
  phase: string;
  iteration: number;
  proposedEditCount: number;
  appliedEditCount: number;
  repairStatus?: string;
  healthClass?: RunnerStatus['healthClass'];
  deferReason?: string;
  evidenceStatus?: RunnerStatus['evidenceStatus'];
  lastAiFailureClass?: RunnerStatus['lastAiFailureClass'];
  validationRequired?: boolean;
  lastError?: string;
  lastUpdatedAt?: string;
  restartedCount: number;
  selfHealCount: number;
  lastSelfHealAt?: string;
  lastSelfHealReason?: string;
  summary?: string;
  scopeExpansionMode: ScopeExpansionMode;
};

type CoordinatorChildSpec = {
  id: string;
  label: string;
  scopes: string[];
  intervalMs: number;
  maxIterations: number | null;
  respawnDelayMs: number;
  editAllowlist: string[];
  checkpointPath: string;
  statusFilePath: string;
  pidFilePath: string;
  logFilePath: string;
  threadId: string;
  scopeExpansionMode: ScopeExpansionMode;
};

type CoordinatorChildRuntime = {
  spec: CoordinatorChildSpec;
  process?: ChildProcess;
  logStream?: fs.WriteStream;
  pid?: number;
  lastSpawnedAtMs?: number;
  restartCount: number;
  lastExitCode?: number | null;
  lastExitSignal?: NodeJS.Signals | null;
  nextRestartAt: number;
  lastStatus?: Partial<RunnerStatus>;
  lastSpawnError?: string;
  lastSemanticProgressSignature?: string;
  lastSemanticProgressAtMs?: number;
  lastStatusHeartbeatAtMs?: number;
  selfHealCount: number;
  lastSelfHealAt?: string;
  lastSelfHealReason?: string;
  selfHealRequestedAtMs?: number;
  selfHealEscalateAtMs?: number;
  lastAiBackpressureAtMs?: number;
};

const DEFAULT_RUNNER_STATUS_PATH = './apps/langgraph-control-plane/.control-plane/runner-status.json';
const DEFAULT_CONTROL_PLANE_PROMPT_IDENTIFIER = 'anygpt-control-plane-agent';
const DEFAULT_CONTROL_PLANE_PROMPT_CHANNEL = 'live';
const DEFAULT_CONTROL_PLANE_PROMPT_SYNC_CHANNEL = 'default';
const MAX_NO_PROGRESS_STREAK = 3;
const DEFAULT_AUTONOMOUS_FULL_COVERAGE_SCOPES = ['repo', 'api', 'api-experimental', 'control-plane', 'repo-surface'];
const EXPANSIVE_SCOPE_ALIASES = new Set(['all', 'everything', 'adaptive', '*']);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_CONTROL_PLANE_EXPERIMENTAL_API_BASE_URL = 'http://127.0.0.1:3310';
const DEFAULT_CONTROL_PLANE_EXPERIMENTAL_SERVICE = 'anygpt-experimental.service';
const DEFAULT_CONTROL_PLANE_PRODUCTION_SERVICE = 'anygpt.service';
const DEFAULT_CONTINUOUS_INTERVAL_MS = 1_000;
const RUNNER_STATUS_HEARTBEAT_MS = 5_000;
const RUNNER_STATUS_STREAM_WRITE_THROTTLE_MS = 2_000;
const RUNNER_STATUS_TRANSIENT_SUMMARY_NOTES = [
  'Lane inactive. No live PID was found for this status file.',
  'Child autonomous lanes are still active; status was reattached after coordinator PID drift.',
  'Runner inactive. Stale runtime state was cleaned.',
] as const;
const RUNNER_STREAM_CHUNK_TIMEOUT_MS = (() => {
  const configured = Number(
    process.env.CONTROL_PLANE_STREAM_CHUNK_TIMEOUT_MS
    ?? process.env.CONTROL_PLANE_GRAPH_CHUNK_TIMEOUT_MS
    ?? process.env.CONTROL_PLANE_GRAPH_STALL_TIMEOUT_MS
    ?? 180_000,
  );
  return Math.max(15_000, Number.isFinite(configured) ? Math.floor(configured) : 180_000);
})();
const RUNNER_CHECKPOINT_HISTORY_LIMIT = (() => {
  const configured = Number(
    process.env.CONTROL_PLANE_RUNNER_CHECKPOINT_HISTORY_LIMIT
    ?? process.env.CONTROL_PLANE_MAX_CHECKPOINTS_PER_NAMESPACE
    ?? 96,
  );
  return Math.max(12, Number.isFinite(configured) ? Math.floor(configured) : 96);
})();
const MULTI_RUNNER_COORDINATOR_POLL_MS = 2_000;
const MULTI_RUNNER_RESTART_DELAY_MS = 1_500;
const MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MIN = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_BACKGROUND_ACTIVE_CAP ?? 1);
  return Math.max(0, Number.isFinite(configured) ? Math.floor(configured) : 1);
})();
const MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX = (() => {
  const configured = Number(
    process.env.CONTROL_PLANE_MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX
    ?? process.env.CONTROL_PLANE_MULTI_RUNNER_BACKGROUND_ACTIVE_CAP
    ?? 2,
  );
  return Math.max(MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MIN, Number.isFinite(configured) ? Math.floor(configured) : 2);
})();
const MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_BUSY_PERCENT = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_BUSY_PERCENT ?? 85);
  return Math.max(50, Math.min(99, Number.isFinite(configured) ? configured : 85));
})();
const MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_COOLDOWN_PERCENT = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_COOLDOWN_PERCENT ?? 70);
  return Math.max(20, Math.min(MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_BUSY_PERCENT, Number.isFinite(configured) ? configured : 70));
})();
const MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_WARMUP_MS = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_WARMUP_MS ?? 60_000);
  return Math.max(0, Number.isFinite(configured) ? Math.floor(configured) : 60_000);
})();
const MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_WARMUP_MAX = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_WARMUP_MAX ?? 2);
  const normalized = Number.isFinite(configured) ? Math.floor(configured) : 2;
  return Math.max(0, Math.min(MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX, normalized));
})();
const MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_BACKPRESSURE_MAX = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_BACKPRESSURE_MAX ?? 2);
  const normalized = Number.isFinite(configured) ? Math.floor(configured) : 2;
  return Math.max(0, Math.min(MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX, normalized));
})();
const MULTI_RUNNER_AI_BACKPRESSURE_COOLDOWN_MS = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_AI_BACKPRESSURE_COOLDOWN_MS ?? 45_000);
  return Math.max(5_000, Number.isFinite(configured) ? Math.floor(configured) : 45_000);
})();
const MULTI_RUNNER_SELF_HEAL_STATUS_STALE_MS = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_SELF_HEAL_STATUS_STALE_MS ?? 60_000);
  return Math.max(15_000, Number.isFinite(configured) ? Math.floor(configured) : 60_000);
})();
const MULTI_RUNNER_SELF_HEAL_STARTUP_STALL_MS = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_SELF_HEAL_STARTUP_STALL_MS ?? 240_000);
  return Math.max(60_000, Number.isFinite(configured) ? Math.floor(configured) : 240_000);
})();
const MULTI_RUNNER_SELF_HEAL_ROLLED_BACK_STALL_MS = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_SELF_HEAL_ROLLED_BACK_STALL_MS ?? 180_000);
  return Math.max(30_000, Number.isFinite(configured) ? Math.floor(configured) : 180_000);
})();
const MULTI_RUNNER_SELF_HEAL_NO_PROGRESS_STALL_MS = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_SELF_HEAL_NO_PROGRESS_STALL_MS ?? 90_000);
  return Math.max(15_000, Number.isFinite(configured) ? Math.floor(configured) : 90_000);
})();
const MULTI_RUNNER_SELF_HEAL_COOLDOWN_MS = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_SELF_HEAL_COOLDOWN_MS ?? 180_000);
  return Math.max(30_000, Number.isFinite(configured) ? Math.floor(configured) : 180_000);
})();
const MULTI_RUNNER_SELF_HEAL_TERM_GRACE_MS = (() => {
  const configured = Number(process.env.CONTROL_PLANE_MULTI_RUNNER_SELF_HEAL_TERM_GRACE_MS ?? 10_000);
  return Math.max(2_000, Number.isFinite(configured) ? Math.floor(configured) : 10_000);
})();

let boundRunnerPidFilePath: string | undefined;
const runnerStatusWriteCache = new Map<string, {
  lastWriteAtMs: number;
  lastComparable: string;
}>();

type CpuSnapshot = {
  idle: number;
  total: number;
};

function readCpuSnapshot(): CpuSnapshot | null {
  try {
    const raw = fs.readFileSync('/proc/stat', 'utf8');
    const line = raw.split('\n').find((entry) => entry.startsWith('cpu '));
    if (!line) return null;
    const parts = line.trim().split(/\s+/).slice(1).map((entry) => Number(entry));
    if (parts.length < 5 || parts.some((value) => !Number.isFinite(value))) return null;
    const idle = (parts[3] || 0) + (parts[4] || 0);
    const total = parts.reduce((sum, value) => sum + value, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function computeCpuBusyPercent(previous: CpuSnapshot | null, next: CpuSnapshot | null): number | null {
  if (!previous || !next) return null;
  const totalDelta = next.total - previous.total;
  const idleDelta = next.idle - previous.idle;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
  const busyPercent = (1 - Math.max(0, idleDelta) / totalDelta) * 100;
  return Math.max(0, Math.min(100, busyPercent));
}

function resolveAdaptiveBackgroundActiveCap(cpuBusyPercent: number | null): number {
  if (MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX <= MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MIN) {
    return MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MIN;
  }
  if (cpuBusyPercent === null) {
    return MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MIN;
  }
  if (cpuBusyPercent >= MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_BUSY_PERCENT) {
    return MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MIN;
  }
  if (cpuBusyPercent <= MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_COOLDOWN_PERCENT) {
    return MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX;
  }
  return Math.max(
    MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MIN,
    Math.min(
      MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX,
      MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX - 1,
    ),
  );
}

function isAiBackendBackpressureText(value: unknown): boolean {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return /request queue is busy/.test(text)
    || /service temporarily unavailable/.test(text)
    || /retry in a few seconds/.test(text)
    || (/status code 503/.test(text) && /queue|busy|retry/.test(text));
}

function coordinatorChildStatusHasAiBackpressure(status: Partial<RunnerStatus> | undefined): boolean {
  if (!status) return false;
  return [
    status.summary,
    status.lastError,
    status.repairDecisionReason,
    status.noProgressReason,
  ].some((value) => isAiBackendBackpressureText(value));
}

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

function replacePathExtension(filePath: string, nextExtension: string): string {
  const normalizedExtension = nextExtension.startsWith('.') ? nextExtension : `.${nextExtension}`;
  const currentExtension = path.extname(filePath);
  if (!currentExtension) return `${filePath}${normalizedExtension}`;
  return `${filePath.slice(0, -currentExtension.length)}${normalizedExtension}`;
}

function appendPathSuffix(filePath: string, suffix: string): string {
  const currentExtension = path.extname(filePath);
  if (!currentExtension) return `${filePath}.${suffix}`;
  return `${filePath.slice(0, -currentExtension.length)}.${suffix}${currentExtension}`;
}

function normalizeRepoRelativePath(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

function pathMatchesPrefix(targetPath: string, prefix: string): boolean {
  return targetPath === prefix || targetPath.startsWith(`${prefix}/`);
}

function uniqueNormalizedPaths(entries: string[]): string[] {
  return Array.from(new Set(entries.map((entry) => normalizeRepoRelativePath(entry)).filter(Boolean)));
}

function intersectAllowlists(parentAllowlist: string[], laneAllowlist: string[]): string[] {
  const normalizedParent = uniqueNormalizedPaths(parentAllowlist);
  const normalizedLane = uniqueNormalizedPaths(laneAllowlist);
  if (normalizedLane.length === 0) return [];
  if (normalizedParent.length === 0 || normalizedParent.includes('*')) return normalizedLane;

  const intersections = new Set<string>();
  for (const parentEntry of normalizedParent) {
    for (const laneEntry of normalizedLane) {
      if (parentEntry === '*') {
        intersections.add(laneEntry);
        continue;
      }
      if (parentEntry === laneEntry) {
        intersections.add(laneEntry);
        continue;
      }
      if (pathMatchesPrefix(parentEntry, laneEntry)) {
        intersections.add(parentEntry);
        continue;
      }
      if (pathMatchesPrefix(laneEntry, parentEntry)) {
        intersections.add(laneEntry);
      }
    }
  }

  return Array.from(intersections);
}

function sanitizeCoordinatorId(value: string): string {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'runner';
}

function parseScopeExpansionMode(value: string | undefined, fallback: ScopeExpansionMode): ScopeExpansionMode {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'locked') return 'locked';
  if (normalized === 'adaptive') return 'adaptive';
  return fallback;
}

function readPidFile(pidFilePath: string | undefined): number | undefined {
  if (!pidFilePath || !fs.existsSync(pidFilePath)) return undefined;
  const parsed = Number(fs.readFileSync(pidFilePath, 'utf8').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function isPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRunnerStatusSnapshot(statusFilePath: string): Partial<RunnerStatus> | undefined {
  if (!fs.existsSync(statusFilePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(statusFilePath, 'utf8')) as Partial<RunnerStatus> | null;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readCoordinatorChildStatusSnapshot(spec: CoordinatorChildSpec): Partial<RunnerStatus> | undefined {
  const snapshot = readRunnerStatusSnapshot(spec.statusFilePath);
  if (!snapshot) return undefined;
  const snapshotThreadId = typeof snapshot.threadId === 'string' ? snapshot.threadId.trim() : '';
  const expectedThreadId = String(spec.threadId || '').trim();
  if (snapshotThreadId && expectedThreadId && snapshotThreadId !== expectedThreadId) {
    return undefined;
  }
  return snapshot;
}

function parseIsoTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDurationMs(value: number): string {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (normalized < 1_000) return `${normalized}ms`;

  const totalSeconds = Math.floor(normalized / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function buildCoordinatorChildSemanticProgressSignature(status: Partial<RunnerStatus> | undefined): string {
  if (!status || typeof status !== 'object') return '';
  return JSON.stringify({
    phase: typeof status.phase === 'string' ? status.phase : '',
    repairStatus: typeof status.repairStatus === 'string' ? status.repairStatus : '',
    healthClass: typeof status.healthClass === 'string' ? status.healthClass : '',
    deferReason: typeof status.deferReason === 'string' ? status.deferReason.trim() : '',
    evidenceStatus: typeof status.evidenceStatus === 'string' ? status.evidenceStatus : '',
    lastAiFailureClass: typeof status.lastAiFailureClass === 'string' ? status.lastAiFailureClass : '',
    validationRequired: status.validationRequired === true,
    summary: typeof status.summary === 'string' ? status.summary.trim() : '',
    proposedEditCount: typeof status.proposedEditCount === 'number' && Number.isFinite(status.proposedEditCount)
      ? status.proposedEditCount
      : 0,
    appliedEditCount: typeof status.appliedEditCount === 'number' && Number.isFinite(status.appliedEditCount)
      ? status.appliedEditCount
      : 0,
    repairDecisionReason: typeof status.repairDecisionReason === 'string'
      ? status.repairDecisionReason.trim()
      : '',
    repairIntentSummary: typeof status.repairIntentSummary === 'string'
      ? status.repairIntentSummary.trim()
      : '',
    noProgressReason: typeof status.noProgressReason === 'string'
      ? status.noProgressReason.trim()
      : '',
    lastError: typeof status.lastError === 'string'
      ? status.lastError.trim()
      : '',
    postRepairValidationStatus: typeof status.postRepairValidationStatus === 'string'
      ? status.postRepairValidationStatus.trim()
      : '',
    evaluationGateStatus: typeof status.evaluationGateStatus === 'string'
      ? status.evaluationGateStatus.trim()
      : '',
  });
}

function isCoordinatorChildPlaceholderSummary(summary: string | undefined): boolean {
  const normalized = String(summary || '').trim();
  if (!normalized) return true;
  return [
    'Waiting for graph output...',
  ].includes(normalized)
    || /^inspectMcp:/.test(normalized)
    || /^qualityAgent:/.test(normalized)
    || /^plannerAgent:/.test(normalized)
    || /^preplanMcpActions:/.test(normalized)
    || /^mergePlan:/.test(normalized)
    || /^reviewAutonomousEdits:/.test(normalized)
    || /^autonomousEditPlanner:/.test(normalized);
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

function expandRequestedScopes(scopes: string[]): string[] {
  const expanded: string[] = [];
  for (const scope of scopes.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)) {
    if (EXPANSIVE_SCOPE_ALIASES.has(scope)) {
      expanded.push(...DEFAULT_AUTONOMOUS_FULL_COVERAGE_SCOPES);
      continue;
    }
    expanded.push(scope);
  }

  const normalized = expanded.length > 0 ? expanded : ['repo'];
  return Array.from(new Set(normalized));
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

function summarizeStreamChunk(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return undefined;

  const chunkRecord = chunk as Record<string, unknown>;
  const sectionNames = Object.keys(chunkRecord)
    .map((key) => String(key || '').trim())
    .filter(Boolean);
  if (sectionNames.length === 0) return undefined;

  const previewParts = sectionNames.slice(0, 3).map((sectionName) => {
    const sectionValue = chunkRecord[sectionName];
    if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
      return sectionName;
    }

    const sectionRecord = sectionValue as Record<string, unknown>;
    const nestedKeys = Object.keys(sectionRecord)
      .map((key) => String(key || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    return nestedKeys.length > 0
      ? `${sectionName}:${nestedKeys.join(',')}`
      : sectionName;
  });

  const suffix = sectionNames.length > previewParts.length
    ? ` (+${sectionNames.length - previewParts.length} more)`
    : '';
  return `${previewParts.join(' | ')}${suffix}`;
}

function writeRunnerStatus(statusFilePath: string, status: RunnerStatus): void {
  ensureRunnerPidFile(boundRunnerPidFilePath, process.pid);
  fs.mkdirSync(path.dirname(statusFilePath), { recursive: true });
  const tempPath = `${statusFilePath}.tmp`;
  const nextSummary = sanitizeLiveRunnerSummary(status.summary);
  const nextStatus = nextSummary === status.summary
    ? status
    : {
        ...status,
        summary: nextSummary,
      };
  const cacheKey = path.resolve(statusFilePath);
  const comparableStatus = {
    ...nextStatus,
    lastUpdatedAt: '',
  };
  const comparable = JSON.stringify(comparableStatus);
  const nowMs = Date.now();
  const previous = runnerStatusWriteCache.get(cacheKey);
  if (
    nextStatus.phase === 'streaming'
    && previous
    && nowMs - previous.lastWriteAtMs < RUNNER_STATUS_STREAM_WRITE_THROTTLE_MS
  ) {
    return;
  }
  fs.writeFileSync(tempPath, JSON.stringify(nextStatus, null, 2), 'utf8');
  fs.renameSync(tempPath, statusFilePath);
  runnerStatusWriteCache.set(cacheKey, {
    lastWriteAtMs: nowMs,
    lastComparable: comparable,
  });
}

function writeRunnerPidFile(pidFilePath: string, pid: number): void {
  fs.mkdirSync(path.dirname(pidFilePath), { recursive: true });
  fs.writeFileSync(pidFilePath, `${pid}\n`, 'utf8');
}

function ensureRunnerPidFile(pidFilePath: string | undefined, pid: number): void {
  if (!pidFilePath || !Number.isFinite(pid) || pid <= 0) return;

  try {
    const existingPid = fs.readFileSync(pidFilePath, 'utf8').trim();
    if (existingPid === String(pid)) return;
  } catch {
    // Rewrite missing or unreadable PID files below.
  }

  writeRunnerPidFile(pidFilePath, pid);
}

function bindRunnerPidFile(pidFilePath: string | undefined): void {
  boundRunnerPidFilePath = pidFilePath;
  ensureRunnerPidFile(pidFilePath, process.pid);
}

function sanitizeLiveRunnerSummary(summary: string | undefined): string | undefined {
  if (typeof summary !== 'string') return summary;

  const filteredLines = summary
    .split(/\r?\n/)
    .filter((line) => !RUNNER_STATUS_TRANSIENT_SUMMARY_NOTES.some((note) => line.includes(note)));
  const normalizedSummary = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalizedSummary || undefined;
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
  bindRunnerPidFile(pidFilePath);
  process.once('exit', () => {
    if (pidFilePath) {
      removeRunnerPidFile(pidFilePath, process.pid);
      if (boundRunnerPidFilePath === pidFilePath) {
        boundRunnerPidFilePath = undefined;
      }
    }
  });

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
      if (boundRunnerPidFilePath === pidFilePath) {
        boundRunnerPidFilePath = undefined;
      }
    }
  };

  const handleSignal = (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void => {
    if (parsedArgs.continuous) {
      finalize({
        running: false,
        phase: 'completed',
        lastError: undefined,
        lastRunCompletedAt: new Date().toISOString(),
        summary: `${getRunnerStatus().summary || 'Runner stopped.'}\nShutdown reason: ${signal}`,
      });
      process.exit(0);
    }

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
  const aiConfig = resolveControlPlaneAiConfig();
  const configuredWorkspaceName = String(process.env.CONTROL_PLANE_LANGSMITH_WORKSPACE_NAME || '').trim();

  return {
    langSmithOrganizationId: runtimeConfig?.workspaceId || undefined,
    langSmithWorkspaceId: runtimeConfig?.workspaceId || undefined,
    langSmithWorkspaceName: configuredWorkspaceName || undefined,
    langSmithProjectName: runtimeConfig?.projectName || undefined,
    promptAvailableChannels: ['candidate', 'default', 'live'],
    controlPlaneAiBackend: aiConfig.enabled ? aiConfig.baseUrl : '',
    controlPlaneAiModel: aiConfig.enabled ? aiConfig.model : '',
  };
}

function readPersistedLangSmithRunnerStatusSeed(
  statusFilePath: string,
  currentThreadId?: string,
): Partial<RunnerStatus> {
  if (!fs.existsSync(statusFilePath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(statusFilePath, 'utf8')) as Partial<RunnerStatus> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    const persistedThreadId = typeof parsed.threadId === 'string' && parsed.threadId.trim()
      ? parsed.threadId.trim()
      : '';
    const shouldCarryFailureHistory = Boolean(
      currentThreadId
      && persistedThreadId
      && persistedThreadId === currentThreadId,
    );

    const accessibleWorkspaceNames = Array.isArray(parsed.langSmithAccessibleWorkspaceNames)
      ? parsed.langSmithAccessibleWorkspaceNames
          .map((entry) => String(entry || '').trim())
          .filter(Boolean)
          .slice(0, 10)
      : undefined;
    const recentAutonomousEditFailures = shouldCarryFailureHistory && Array.isArray(parsed.recentAutonomousEditFailures)
      ? parsed.recentAutonomousEditFailures
          .map((entry) => AppliedAutonomousEditSchema.safeParse(entry))
          .flatMap((result) => result.success ? [result.data] : [])
          .slice(-4)
      : undefined;
    const recentAutonomousLearningNotes = shouldCarryFailureHistory && Array.isArray(parsed.recentAutonomousLearningNotes)
      ? parsed.recentAutonomousLearningNotes
          .map((entry: unknown) => String(entry || '').trim())
          .filter(Boolean)
          .slice(-8)
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
      recentAutonomousEditFailures,
      recentAutonomousLearningNotes,
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
    ...readPersistedLangSmithRunnerStatusSeed(parsedArgs.statusFilePath, parsedArgs.threadId),
    ...readPersistedLangSmithCheckpointSeed(parsedArgs.checkpointPath, parsedArgs.threadId),
    ...resolveLangSmithRunnerStatusSeed(),
  };
  return {
    goal: parsedArgs.goal,
    scopes: parsedArgs.scopes,
    effectiveScopes: parsedArgs.scopes,
    scopeExpansionReason: '',
    scopeExpansionMode: parsedArgs.scopeExpansionMode,
    threadId: parsedArgs.threadId,
    runnerMode: parsedArgs.coordinatorChildId
      ? 'multi-runner-child'
      : (parsedArgs.multiRunner ? 'multi-runner-coordinator' : 'single-runner'),
    coordinatorChildId: parsedArgs.coordinatorChildId,
    coordinatorParentThreadId: parsedArgs.coordinatorParentThreadId,
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
    productionServiceName: DEFAULT_CONTROL_PLANE_PRODUCTION_SERVICE,
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
    noProgressStreak: 0,
    noProgressReason: '',
    lastProgressSignature: '',
    repairStatus: parsedArgs.autonomousEditEnabled ? 'idle' : 'not-needed',
    healthClass: 'healthy',
    deferReason: '',
    evidenceStatus: 'unknown',
    lastAiFailureClass: 'none',
    validationRequired: false,
    repairDecisionReason: '',
    repairIntentSummary: '',
    repairSignalCount: 0,
    autonomousOperationMode: 'idle',
    autonomousPlannerAgentCount: 0,
    autonomousPlannerFocuses: [],
    autonomousPlannerStrategy: '',
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
    latestCheckpointId: undefined,
    latestCheckpointCreatedAt: undefined,
    checkpointCount: 0,
    checkpointNextNodes: [],
    replayCheckpointId: parsedArgs.replayCheckpointId,
    lastForkCheckpointId: parsedArgs.forkCheckpointId,
    subgraphStreamingEnabled: parsedArgs.subgraphs,
    experimentalRestartStatus: 'not-needed',
    experimentalRestartReason: '',
    productionRestartStatus: 'not-needed',
    productionRestartReason: '',
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
    coordinatorStrategy: parsedArgs.multiRunner && !parsedArgs.coordinatorChildId ? 'disjoint-lane-supervisor' : undefined,
    coordinatedRunnerCount: parsedArgs.multiRunner && !parsedArgs.coordinatorChildId ? 0 : undefined,
    coordinatedRunners: parsedArgs.multiRunner && !parsedArgs.coordinatorChildId ? [] : undefined,
    coordinatorPollMs: parsedArgs.multiRunner && !parsedArgs.coordinatorChildId ? MULTI_RUNNER_COORDINATOR_POLL_MS : undefined,
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

async function collectCheckpointHistorySeed(
  graph: Awaited<ReturnType<typeof createControlPlaneGraph>>['graph'],
  threadId: string,
): Promise<Partial<RunnerStatus>> {
  const config = { configurable: { thread_id: threadId } };
  const history: any[] = [];
  try {
    for await (const state of graph.getStateHistory(config as any)) {
      history.push(state);
      if (history.length >= RUNNER_CHECKPOINT_HISTORY_LIMIT) break;
    }
  } catch {
    return {};
  }

  if (history.length === 0) return {};
  const latest = history[0] as any;
  const latestCheckpointId = typeof latest?.config?.configurable?.checkpoint_id === 'string'
    ? latest.config.configurable.checkpoint_id.trim()
    : '';
  const latestCheckpointCreatedAt = typeof latest?.createdAt === 'string' && latest.createdAt.trim()
    ? latest.createdAt.trim()
    : '';
  const checkpointNextNodes = Array.isArray(latest?.next)
    ? latest.next.map((entry: unknown) => String(entry || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const replayCandidate = history.find((state) => Array.isArray((state as any)?.next) && (state as any).next.length > 0) as any;
  const replayCheckpointId = typeof replayCandidate?.config?.configurable?.checkpoint_id === 'string'
    ? replayCandidate.config.configurable.checkpoint_id.trim()
    : latestCheckpointId;

  return {
    latestCheckpointId: latestCheckpointId || undefined,
    latestCheckpointCreatedAt: latestCheckpointCreatedAt || undefined,
    checkpointCount: history.length,
    checkpointNextNodes,
    replayCheckpointId: replayCheckpointId || undefined,
  };
}

function buildCoordinatorChildParsedArgs(parsedArgs: ParsedArgs, spec: CoordinatorChildSpec): ParsedArgs {
  return {
    ...parsedArgs,
    scopes: spec.scopes,
    threadId: spec.threadId,
    intervalMs: spec.intervalMs,
    maxIterations: spec.maxIterations,
    multiRunner: false,
    coordinatorChildId: spec.id,
    coordinatorParentThreadId: parsedArgs.threadId,
    scopeExpansionMode: spec.scopeExpansionMode,
    checkpointPath: spec.checkpointPath,
    statusFilePath: spec.statusFilePath,
    pidFilePath: spec.pidFilePath,
    editAllowlist: spec.editAllowlist,
    resumeValue: undefined,
  };
}

function seedCoordinatorChildStatus(
  parsedArgs: ParsedArgs,
  spec: CoordinatorChildSpec,
  options?: { running?: boolean; phase?: RunnerStatus['phase']; summary?: string },
): void {
  const childArgs = buildCoordinatorChildParsedArgs(parsedArgs, spec);
  const seededStatus = mergeRunnerStatus(createBaseRunnerStatus(childArgs), {
    running: options?.running === true,
    phase: options?.phase || (options?.running === true ? 'starting' : 'completed'),
    summary: options?.summary || (options?.running === true ? 'Waiting for graph output...' : 'Queued for background slot.'),
    coordinatedRunnerCount: undefined,
    coordinatedRunners: undefined,
    coordinatorStrategy: undefined,
    coordinatorPollMs: undefined,
  });
  writeRunnerStatus(spec.statusFilePath, seededStatus);
}

function buildInitialGraphInput(
  initialState: ReturnType<typeof ControlPlaneStateSchema.parse>,
  runnerStatus: RunnerStatus,
): ReturnType<typeof ControlPlaneStateSchema.parse> {
  const seededFailedEdits = Array.isArray(runnerStatus.recentAutonomousEditFailures)
    ? runnerStatus.recentAutonomousEditFailures
        .map((entry) => AppliedAutonomousEditSchema.safeParse(entry))
        .flatMap((result) => result.success && shouldCarryForwardAutonomousEditFailure(result.data) ? [result.data] : [])
    : [];

  return ControlPlaneStateSchema.parse({
    ...initialState,
    appliedEdits: seededFailedEdits.length > 0 ? seededFailedEdits : initialState.appliedEdits,
    recentAutonomousLearningNotes: Array.isArray(runnerStatus.recentAutonomousLearningNotes)
      ? runnerStatus.recentAutonomousLearningNotes.map((entry: string) => String(entry || '').trim()).filter(Boolean).slice(-8)
      : initialState.recentAutonomousLearningNotes,
    recentRepairValidationFailureCount: Math.max(
      0,
      (typeof runnerStatus.repairSmokeFailedCount === 'number' ? runnerStatus.repairSmokeFailedCount : 0)
        + (typeof runnerStatus.postRepairValidationFailedCount === 'number' ? runnerStatus.postRepairValidationFailedCount : 0),
    ),
    repairStatus: typeof runnerStatus.repairStatus === 'string' && runnerStatus.repairStatus.trim()
      ? runnerStatus.repairStatus
      : initialState.repairStatus,
    repairDecisionReason: typeof runnerStatus.repairDecisionReason === 'string'
      ? runnerStatus.repairDecisionReason
      : initialState.repairDecisionReason,
  });
}

function shouldCarryForwardAutonomousEditFailure(failure: ReturnType<typeof AppliedAutonomousEditSchema.parse>): boolean {
  const message = String(failure?.message || '').trim().toLowerCase();
  if (!message) return false;

  // Keep only failures that benefit from refreshed anchored context,
  // explicit compile-shape cleanup, or manual narrowing on the next pass.
  // General build/typecheck failures are still dropped once they are out of
  // the current batch so they do not permanently bias later repair planning.
  if (/unused local symbols|declared but its value is never read/.test(message)) {
    return true;
  }
  if (/cannot redeclare block-scoped variable|duplicate identifier|duplicate function implementation|same-file typescript diagnostics/.test(message)) {
    return true;
  }

  if (/typecheck|build validation|compile validation/.test(message)) {
    return false;
  }

  return /replace target text was not found|anchor fragment|anchored block|matched \d+ times|preflight/i.test(message);
}

function deriveRecentAutonomousEditFailures(
  appliedEdits: unknown,
  autonomousEditNotes: unknown,
  previousFailures: unknown[] | undefined,
): unknown[] {
  const parsedAppliedEdits = Array.isArray(appliedEdits)
    ? appliedEdits
        .map((entry) => AppliedAutonomousEditSchema.safeParse(entry))
        .flatMap((result) => result.success ? [result.data] : [])
    : [];
  const syntheticFailures = Array.isArray(autonomousEditNotes)
    ? autonomousEditNotes
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .slice(-24)
        .map((note) => note.match(/Skipped autonomous (replace|write) proposal for ([^:]+):\s*(.+)$/i))
        .flatMap((match) => {
          if (!match) return [];
          const type = String(match[1] || '').trim().toLowerCase();
          const path = String(match[2] || '').trim();
          const message = String(match[3] || '').trim();
          if (!path || !message) return [];
          const parsed = AppliedAutonomousEditSchema.safeParse({
            type,
            path,
            reason: '',
            status: 'failed',
            message,
          });
          return parsed.success ? [parsed.data] : [];
        })
    : [];
  const failedEdits = [...parsedAppliedEdits, ...syntheticFailures]
    .filter((edit: any) => edit?.status === 'failed')
    .filter((edit: any) => shouldCarryForwardAutonomousEditFailure(edit))
    .slice(-6);

  if (failedEdits.length > 0) {
    return failedEdits.slice(-4);
  }
  if (parsedAppliedEdits.some((edit: any) => edit?.status === 'applied')) {
    return [];
  }
  return Array.isArray(previousFailures)
    ? previousFailures
        .map((entry) => AppliedAutonomousEditSchema.safeParse(entry))
        .flatMap((result) => result.success && shouldCarryForwardAutonomousEditFailure(result.data) ? [result.data] : [])
    : [];
}

function deriveRecentAutonomousLearningNotes(
  result: Record<string, unknown>,
  previousNotes: string[] | undefined,
): string[] {
  const notes = new Set<string>(Array.isArray(previousNotes)
    ? previousNotes.map((entry) => String(entry || '').trim()).filter(Boolean).slice(-8)
    : []);

  const repairDecisionReason = typeof result.repairDecisionReason === 'string'
    ? result.repairDecisionReason.trim()
    : '';
  if (/path fit score \(0\)|too weak for the active signals/i.test(repairDecisionReason)) {
    notes.add('Avoid repeating broad or weakly justified proposals; prefer edits whose reason text directly matches the active signal class and touched path.');
  }
  if (/Build experimental API after autonomous promotion \(exit 1\)|Build api \(repair smoke\) \(exit 1\)/i.test(repairDecisionReason)) {
    notes.add('When an API edit fails experimental build validation, treat that edit shape as unsafe until a narrower proposal or stronger anchored replace block is available.');
  }

  const recentFailures = Array.isArray(result.appliedEdits)
    ? result.appliedEdits
        .map((entry) => AppliedAutonomousEditSchema.safeParse(entry))
        .flatMap((parsed) => parsed.success ? [parsed.data] : [])
        .filter((entry) => entry.status === 'failed')
    : [];
  for (const failure of recentFailures) {
    const message = String(failure.message || '').trim();
    if (/Replace target text was not found|anchor fragment|anchored block|matched \d+ times/i.test(message)) {
      notes.add('When replace anchors fail, prefer refreshed anchored excerpts or narrower blocks before retrying the same path.');
    }
    if (/unused local symbols|declared but its value is never read/i.test(message)) {
      notes.add('When an autonomous edit introduces unused locals, do not retry the same path with another helper/predicate/detector addition unless the same patch clearly wires that declaration into an existing branch and resolves the compile failure.');
    }
    if (/cannot redeclare block-scoped variable|duplicate identifier|duplicate function implementation|same-file typescript diagnostics/i.test(message)) {
      notes.add('When an autonomous edit introduces duplicate declarations in the same file, do not retry the same path unless the next proposal explicitly removes, renames, or consolidates the conflicting declaration.');
    }
  }

  const recentAutonomousEditNotes = Array.isArray(result.autonomousEditNotes)
    ? result.autonomousEditNotes.map((entry) => String(entry || '').trim()).filter(Boolean).slice(-16)
    : [];
  for (const note of recentAutonomousEditNotes) {
    if (/Skipped autonomous replace proposal for apps\/api\/modules\/modelUpdater\.ts: .*'key' is declared but its value is never read\./i.test(note)) {
      notes.add('When editing apps/api/modules/modelUpdater.ts for capability-skip normalization, reuse the existing normalizedKey branch inside collectAvailabilityConstraintMetadata rather than introducing another [key, value] loop that leaves key unused.');
    }
    if (/Skipped autonomous replace proposal for apps\/api\/modules\/modelUpdater\.ts: Replace target text was not found in the file\. First anchor fragment: if \(providerCount === 0\) \{/i.test(note)) {
      notes.add('When revisiting apps/api/modules/modelUpdater.ts failed paths, anchor around collectAvailabilityConstraintMetadata, hasAvailabilityConstraint, or the constrained-model retention branch instead of the older providerCount===0 block.');
    }
    if (/duplicate package\.json scripts/i.test(note)) {
      notes.add('When editing package.json, preserve unique scripts keys and update an existing workspace/frontend alias instead of adding another script entry with the same name.');
    }
  }

  return Array.from(notes).slice(-8);
}

function summarizeFailedExecutedJobs(executedJobs: unknown): string {
  const failedJobs = Array.isArray(executedJobs)
    ? executedJobs.filter((job: any) => job?.status === 'failed')
    : [];
  if (failedJobs.length === 0) return '';

  const firstFailed = failedJobs[0] as Record<string, unknown>;
  const title = typeof firstFailed.title === 'string' && firstFailed.title.trim()
    ? firstFailed.title.trim()
    : 'job';
  const exitSuffix = typeof firstFailed.exitCode === 'number'
    ? ` (exit ${firstFailed.exitCode})`
    : '';
  return `${failedJobs.length} executed job(s) failed; first failure: ${title}${exitSuffix}.`;
}

function summarizeTerminalRunFailure(result: unknown): string {
  const resultRecord = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : {};

  const executedJobFailure = summarizeFailedExecutedJobs(resultRecord.executedJobs);
  if (executedJobFailure) return executedJobFailure;

  const repairStatus = typeof resultRecord.repairStatus === 'string'
    ? resultRecord.repairStatus.trim()
    : '';
  const healthClass = typeof resultRecord.healthClass === 'string'
    ? resultRecord.healthClass.trim()
    : '';
  const repairDecisionReason = typeof resultRecord.repairDecisionReason === 'string'
    ? resultRecord.repairDecisionReason.trim()
    : '';
  if (
    (repairStatus === 'failed' || repairStatus === 'rolled-back')
    && !['waiting_evidence', 'blocked_external'].includes(healthClass)
  ) {
    return repairDecisionReason || (repairStatus === 'rolled-back'
      ? 'Autonomous repair failed and was rolled back.'
      : 'Autonomous repair failed.');
  }

  const postRepairValidationStatus = typeof resultRecord.postRepairValidationStatus === 'string'
    ? resultRecord.postRepairValidationStatus.trim()
    : '';
  if (postRepairValidationStatus === 'failed') {
    return repairDecisionReason || 'Post-repair validation failed.';
  }

  const experimentalRestartStatus = typeof resultRecord.experimentalRestartStatus === 'string'
    ? resultRecord.experimentalRestartStatus.trim()
    : '';
  const experimentalRestartReason = typeof resultRecord.experimentalRestartReason === 'string'
    ? resultRecord.experimentalRestartReason.trim()
    : '';
  if (experimentalRestartStatus === 'failed') {
    return experimentalRestartReason || 'Experimental service restart failed after a promoted repair.';
  }

  return '';
}

function deriveNoProgressSignature(result: Record<string, unknown>): string {
  const proposedEdits = Array.isArray(result.proposedEdits)
    ? result.proposedEdits
        .map((edit: any) => `${String(edit?.type || '').trim()}:${String(edit?.path || '').trim()}:${String(edit?.reason || '').trim()}`)
        .filter((entry: string) => entry !== '::')
        .slice(0, 6)
    : [];
  const appliedPaths = Array.isArray(result.appliedEdits)
    ? result.appliedEdits
        .filter((edit: any) => edit?.status === 'applied' && typeof edit?.path === 'string')
        .map((edit: any) => String(edit.path || '').trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const executedJobSummary = Array.isArray(result.executedJobs)
    ? result.executedJobs
        .filter((job: any) => job?.status === 'failed' || (job?.status === 'success' && job?.kind !== 'note'))
        .map((job: any) => `${String(job?.status || '').trim()}:${String(job?.title || '').trim()}:${typeof job?.exitCode === 'number' ? job.exitCode : 'n/a'}`)
        .slice(0, 6)
    : [];

  return JSON.stringify({
    repairStatus: typeof result.repairStatus === 'string' ? result.repairStatus.trim() : '',
    repairDecisionReason: typeof result.repairDecisionReason === 'string' ? result.repairDecisionReason.trim() : '',
    repairIntentSummary: typeof result.repairIntentSummary === 'string' ? result.repairIntentSummary.trim() : '',
    improvementIntentSummary: typeof result.improvementIntentSummary === 'string' ? result.improvementIntentSummary.trim() : '',
    proposedEdits,
    appliedPaths,
    executedJobSummary,
  });
}

function hasMeaningfulIterationProgress(result: Record<string, unknown>): boolean {
  const appliedEditCount = Array.isArray(result.appliedEdits)
    ? result.appliedEdits.filter((edit: any) => edit?.status === 'applied').length
    : 0;
  if (appliedEditCount > 0) return true;

  const promotedPathCount = Array.isArray(result.repairPromotedPaths)
    ? result.repairPromotedPaths.map((entry: any) => String(entry || '').trim()).filter(Boolean).length
    : 0;
  if (promotedPathCount > 0) return true;

  const rollbackPathCount = Array.isArray(result.repairRollbackPaths)
    ? result.repairRollbackPaths.map((entry: any) => String(entry || '').trim()).filter(Boolean).length
    : 0;
  if (rollbackPathCount > 0) return true;

  const successfulExecutableJobs = Array.isArray(result.executedJobs)
    ? result.executedJobs.filter((job: any) => job?.status === 'success' && job?.kind !== 'note').length
    : 0;
  return successfulExecutableJobs > 0;
}

function getNoProgressDelayMs(baseIntervalMs: number, noProgressStreak: number): number {
  const normalizedBase = Number.isFinite(baseIntervalMs) ? Math.max(1_000, Math.floor(baseIntervalMs)) : 1_000;
  const normalizedStreak = Number.isFinite(noProgressStreak) ? Math.max(0, Math.floor(noProgressStreak)) : 0;
  if (normalizedStreak < MAX_NO_PROGRESS_STREAK) return normalizedBase;

  const backoffStep = Math.min(3, normalizedStreak - MAX_NO_PROGRESS_STREAK + 1);
  return Math.min(30_000, Math.max(5_000, normalizedBase * (2 ** backoffStep)));
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function sleep(ms: number, jitterMs = 0): Promise<void> {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const safeJitterMs = Number.isFinite(jitterMs) ? Math.max(0, jitterMs) : 0;
  const delay = safeJitterMs > 0
    ? safeMs + Math.floor(Math.random() * (safeJitterMs + 1))
    : safeMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function readNextStreamChunkWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  context: string,
): Promise<IteratorResult<T>> {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timeoutId = setTimeout(() => {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
          reject(new Error(`Graph stream stalled for ${timeoutMs}ms while ${context}.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, context: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${context} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function getContinuousRetryDelayMs(consecutiveFailures: number): number {
  const normalizedFailures = Number.isFinite(consecutiveFailures)
    ? Math.max(0, Math.floor(consecutiveFailures))
    : 0;
  const configuredBaseDelayMs = Number(
    process.env.CONTROL_PLANE_CONTINUOUS_RETRY_BASE_MS ?? process.env.CONTROL_PLANE_CONTINUOUS_RETRY_MS ?? 5_000
  );
  const baseDelayMs = Math.max(
    1_000,
    Number.isFinite(configuredBaseDelayMs) ? configuredBaseDelayMs : 5_000
  );
  const configuredMaxDelayMs = Number(
    process.env.CONTROL_PLANE_CONTINUOUS_RETRY_MAX_MS ?? 30_000
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    Number.isFinite(configuredMaxDelayMs) ? configuredMaxDelayMs : 30_000
  );
  const backoffStep = Math.max(0, normalizedFailures - 1);
  const exponentialDelayMs = Math.min(
    maxDelayMs,
    baseDelayMs * (2 ** Math.min(backoffStep, 3))
  );
  const jitterCapMs = Math.min(2_000, Math.max(500, Math.floor(exponentialDelayMs * 0.2)));
  return Math.min(maxDelayMs, exponentialDelayMs + Math.floor(Math.random() * (jitterCapMs + 1)));
}

function shellEscapeArg(value: string): string {
  if (!value) return "''";
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildRunnerInvocationArgs(parsedArgs: ParsedArgs): string[] {
  const args = [
    './bun.sh',
    'run',
    './apps/langgraph-control-plane/src/index.ts',
    `--goal=${parsedArgs.goal}`,
    `--scopes=${parsedArgs.scopes.join(',')}`,
    `--thread-id=${parsedArgs.threadId}`,
    `--repo-root=${parsedArgs.repoRoot}`,
    `--interval-ms=${parsedArgs.intervalMs}`,
    `--max-edit-actions=${parsedArgs.maxEditActions}`,
    `--prompt-identifier=${parsedArgs.promptIdentifier}`,
    `--prompt-channel=${parsedArgs.promptChannel}`,
    `--prompt-sync=${parsedArgs.promptSyncEnabled ? 'true' : 'false'}`,
    `--prompt-sync-channel=${parsedArgs.promptSyncChannel}`,
    `--eval-gate-mode=${parsedArgs.evaluationGatePolicy.mode}`,
    `--eval-gate-target=${parsedArgs.evaluationGatePolicy.target}`,
    `--eval-gate-aggregation-mode=${parsedArgs.evaluationGatePolicy.aggregationMode || 'all'}`,
    `--eval-gate-require-evaluation=${parsedArgs.evaluationGatePolicy.requireEvaluation ? 'true' : 'false'}`,
    `--eval-gate-min-results=${parsedArgs.evaluationGatePolicy.minResultCount}`,
    `--eval-gate-metric=${parsedArgs.evaluationGatePolicy.metricKey}`,
    `--eval-gate-min-score=${parsedArgs.evaluationGatePolicy.minMetricAverageScore}`,
    `--eval-gate-min-weighted-score=${parsedArgs.evaluationGatePolicy.minimumWeightedScore ?? 0}`,
    `--eval-gate-scorecard-name=${parsedArgs.evaluationGatePolicy.scorecardName}`,
    `--mcp-config=${parsedArgs.mcpConfigPath}`,
    `--checkpoint-path=${parsedArgs.checkpointPath}`,
    `--status-file=${parsedArgs.statusFilePath}`,
    `--stream-mode=${parsedArgs.streamMode}`,
    `--edit-allowlist=${parsedArgs.editAllowlist.join(',')}`,
    `--scope-expansion=${parsedArgs.scopeExpansionMode}`,
    `--mcp-actions=${parsedArgs.mcpActionEnabled ? 'true' : 'false'}`,
    `--max-mcp-actions=${parsedArgs.maxMcpActions}`,
  ];

  if (parsedArgs.mcpTargetUrls.length > 0) {
    args.push(`--mcp-target-urls=${parsedArgs.mcpTargetUrls.join(',')}`);
  }

  if (parsedArgs.pidFilePath) {
    args.push(`--pid-file=${parsedArgs.pidFilePath}`);
  }
  if (parsedArgs.multiRunner && !parsedArgs.coordinatorChildId) {
    args.push('--multi-runner');
  }
  if (parsedArgs.coordinatorChildId) {
    args.push(`--coordinator-child=${parsedArgs.coordinatorChildId}`);
  }
  if (parsedArgs.coordinatorParentThreadId) {
    args.push(`--coordinator-parent-thread-id=${parsedArgs.coordinatorParentThreadId}`);
  }
  if (parsedArgs.maxIterations !== null) {
    args.push(`--max-iterations=${parsedArgs.maxIterations}`);
  }
  if (parsedArgs.promptRef.trim()) {
    args.push(`--prompt-ref=${parsedArgs.promptRef}`);
  }
  if (parsedArgs.promptPromoteChannel.trim()) {
    args.push(`--prompt-promote=${parsedArgs.promptPromoteChannel}`);
  }
  if (parsedArgs.replayCheckpointId?.trim()) {
    args.push(`--replay-checkpoint-id=${parsedArgs.replayCheckpointId}`);
  }
  if (parsedArgs.forkCheckpointId?.trim()) {
    args.push(`--fork-checkpoint-id=${parsedArgs.forkCheckpointId}`);
  }
  if (parsedArgs.forkStateJson?.trim()) {
    args.push(`--fork-state=${parsedArgs.forkStateJson}`);
  }
  if (parsedArgs.subgraphs) {
    args.push('--subgraphs');
  }
  if (parsedArgs.editDenylist.length > 0) {
    args.push(`--edit-denylist=${parsedArgs.editDenylist.join(',')}`);
  }
  if (parsedArgs.evaluationGatePolicy.requiredMetricKeys.length > 0) {
    args.push(`--eval-gate-required-metrics=${parsedArgs.evaluationGatePolicy.requiredMetricKeys.join(',')}`);
  }
  const metricThresholds = Object.entries(parsedArgs.evaluationGatePolicy.additionalMetricThresholds || {})
    .map(([key, value]) => `${key}:${value}`);
  if (metricThresholds.length > 0) {
    args.push(`--eval-gate-metric-thresholds=${metricThresholds.join(',')}`);
  }
  const metricWeights = Object.entries(parsedArgs.evaluationGatePolicy.metricWeights || {})
    .map(([key, value]) => `${key}:${value}`);
  if (metricWeights.length > 0) {
    args.push(`--eval-gate-metric-weights=${metricWeights.join(',')}`);
  }
  if (parsedArgs.evaluationGatePolicy.baselineExperimentName.trim()) {
    args.push(`--eval-gate-baseline-experiment=${parsedArgs.evaluationGatePolicy.baselineExperimentName}`);
  }
  if (parsedArgs.executePlan) {
    args.push('--execute');
  }
  if (parsedArgs.allowDeploy) {
    args.push('--allow-deploy');
  }
  if (parsedArgs.approvalMode === 'auto') {
    args.push('--auto-approve');
  }
  if (parsedArgs.continuous) {
    args.push('--continuous');
  }
  if (parsedArgs.autonomous) {
    args.push('--autonomous');
  }
  if (parsedArgs.autonomousEditEnabled) {
    args.push('--autonomous-edits');
  }
  if (parsedArgs.deployCommand.trim()) {
    args.push(`--deploy-command=${parsedArgs.deployCommand}`);
  }

  return args;
}

function buildResumeCommand(parsedArgs: ParsedArgs, resumeValue: unknown): string {
  const resumeArg = typeof resumeValue === 'string'
    ? resumeValue
    : JSON.stringify(resumeValue);
  const args = [
    ...buildRunnerInvocationArgs(parsedArgs),
    `--resume=${resumeArg}`,
  ];
  return `bash ${args.map((arg) => shellEscapeArg(arg)).join(' ')}`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const argMap = new Map<string, string>();
  let executePlan = false;
  let allowDeploy = false;
  let autoApprove = false;
  let continuous = false;
  let autonomous = false;
  let autonomousEditEnabled = false;
  let mcpActionEnabled = false;
  let multiRunner = false;
  let subgraphs = false;

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
      mcpActionEnabled = true;
      continue;
    }
    if (arg === '--autonomous-edits') {
      autonomousEditEnabled = true;
      continue;
    }
    if (arg === '--mcp-actions') {
      mcpActionEnabled = true;
      continue;
    }
    if (arg === '--multi-runner') {
      multiRunner = true;
      continue;
    }
    if (arg === '--subgraphs') {
      subgraphs = true;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, value] = arg.slice(2).split(/=(.*)/s, 2);
      argMap.set(key, value);
    }
  }

  const scopes = expandRequestedScopes(
    (argMap.get('scopes') || 'repo')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  const repoRoot = path.resolve(
    argMap.get('repo-root')
    || process.env.CONTROL_PLANE_REPO_ROOT
    || DEFAULT_REPO_ROOT,
  );
  const intervalMs = parseIntegerArg(
    argMap.get('interval-ms') || process.env.CONTROL_PLANE_INTERVAL_MS,
    continuous || autonomous ? DEFAULT_CONTINUOUS_INTERVAL_MS : 60_000,
    1_000,
  );
  const maxIterations = parseMaxIterations(argMap.get('max-iterations'));
  const maxEditActions = parseIntegerArg(argMap.get('max-edit-actions'), 12, 1);
  const maxMcpActions = parseIntegerArg(
    argMap.get('max-mcp-actions') || process.env.CONTROL_PLANE_MAX_MCP_ACTIONS,
    4,
    0,
  );
  const coordinatorChildId = String(argMap.get('coordinator-child') || '').trim() || undefined;
  const coordinatorParentThreadId = String(argMap.get('coordinator-parent-thread-id') || '').trim() || undefined;
  const scopeExpansionMode = parseScopeExpansionMode(
    argMap.get('scope-expansion') || process.env.CONTROL_PLANE_SCOPE_EXPANSION,
    coordinatorChildId ? 'locked' : 'adaptive',
  );
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
  autonomousEditEnabled = parseBooleanArg(
    argMap.get('autonomous-edits')
    || argMap.get('autonomous-edit-enabled')
    || process.env.CONTROL_PLANE_AUTONOMOUS_EDITS,
    autonomousEditEnabled,
  );
  mcpActionEnabled = parseBooleanArg(
    argMap.get('mcp-actions')
    || process.env.CONTROL_PLANE_MCP_ACTIONS,
    mcpActionEnabled,
  );
  const mcpTargetUrls = parseStringArrayArg(
    argMap.get('mcp-target-urls')
    || argMap.get('mcp-target-url')
    || process.env.CONTROL_PLANE_MCP_TARGET_URLS,
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
    multiRunner,
    coordinatorChildId,
    coordinatorParentThreadId,
    scopeExpansionMode,
    approvalMode: autoApprove ? 'auto' : 'manual',
    continuous,
    autonomous,
    autonomousEditEnabled,
    mcpActionEnabled,
    maxMcpActions,
    mcpTargetUrls,
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
    replayCheckpointId: String(argMap.get('replay-checkpoint-id') || '').trim() || undefined,
    forkCheckpointId: String(argMap.get('fork-checkpoint-id') || '').trim() || undefined,
    forkStateJson: String(argMap.get('fork-state') || '').trim() || undefined,
    subgraphs,
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
      ...(parsedArgs.replayCheckpointId ? { checkpoint_id: parsedArgs.replayCheckpointId } : {}),
      ...(parsedArgs.forkCheckpointId ? { checkpoint_id: parsedArgs.forkCheckpointId } : {}),
    },
    streamMode: parsedArgs.streamMode,
    ...(parsedArgs.subgraphs ? { subgraphs: true } : {}),
  };
  const input = parsedArgs.forkCheckpointId && parsedArgs.forkStateJson
    ? null
    : typeof parsedArgs.resumeValue === 'undefined'
      ? buildInitialGraphInput(initialState, runnerStatus)
      : new Command({ resume: parsedArgs.resumeValue });
  let lastChunk: unknown = undefined;
  let sawInterrupt = false;

  if (parsedArgs.forkCheckpointId && parsedArgs.forkStateJson) {
    const forkState = JSON.parse(parsedArgs.forkStateJson) as Record<string, unknown>;
    const forkConfig = await controlPlaneGraph.updateState(
      {
        configurable: {
          thread_id: parsedArgs.threadId,
          checkpoint_id: parsedArgs.forkCheckpointId,
        },
      } as any,
      forkState,
    );
    Object.assign(config.configurable, (forkConfig as any)?.configurable || {});
  }

  console.log(`[langgraph-control-plane] thread_id=${parsedArgs.threadId}`);
  console.log(`[langgraph-control-plane] checkpoint_path=${path.relative(parsedArgs.repoRoot, parsedArgs.checkpointPath)}`);
  console.log(`[langgraph-control-plane] status_file=${path.relative(parsedArgs.repoRoot, parsedArgs.statusFilePath)}`);

  writeRunnerStatus(
    parsedArgs.statusFilePath,
    mergeRunnerStatus(runnerStatus, {
      running: true,
      phase: 'streaming',
      lastRunStartedAt: new Date().toISOString(),
      lastRunCompletedAt: undefined,
      sawInterrupt: false,
      summary: 'Waiting for graph output...',
      lastError: undefined,
    }),
  );

  const getRunnerStatusSummaryFallback = (): string => {
    const persistedStatus = readRunnerStatusSnapshot(parsedArgs.statusFilePath);
    const currentSummary = typeof persistedStatus?.summary === 'string'
      ? String(persistedStatus.summary || '').trim()
      : '';
    return currentSummary || 'Streaming graph output...';
  };

  const heartbeat = setInterval(() => {
    try {
      writeRunnerStatus(
        parsedArgs.statusFilePath,
        mergeRunnerStatus(runnerStatus, {
          running: true,
          phase: sawInterrupt ? 'paused' : 'streaming',
          sawInterrupt,
          lastError: undefined,
          summary: getRunnerStatusSummaryFallback(),
        }),
      );
    } catch (error) {
      console.warn(`[langgraph-control-plane] Failed to write runner heartbeat: ${formatError(error)}`);
    }
  }, RUNNER_STATUS_HEARTBEAT_MS);

  let streamedChunkCount = 0;
  try {
    const stream = await withTimeout(
      controlPlaneGraph.stream(input as any, config as any),
      RUNNER_STREAM_CHUNK_TIMEOUT_MS,
      `Graph stream initialization for thread ${parsedArgs.threadId}`,
    );
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const nextChunk = await readNextStreamChunkWithTimeout(
        iterator,
        RUNNER_STREAM_CHUNK_TIMEOUT_MS,
        `${getRunnerStatusSummaryFallback()} (thread ${parsedArgs.threadId})`,
      );
      if (nextChunk.done) break;
      const chunk = nextChunk.value;
      lastChunk = chunk;
      streamedChunkCount += 1;
      if (isInterruptChunk(chunk)) {
        sawInterrupt = true;
      }
      writeRunnerStatus(
        parsedArgs.statusFilePath,
        mergeRunnerStatus(runnerStatus, {
          running: true,
          phase: sawInterrupt ? 'paused' : 'streaming',
          sawInterrupt,
          lastError: undefined,
          summary: summarizeStreamChunk(chunk) || `Streaming graph output (${streamedChunkCount} chunk${streamedChunkCount === 1 ? '' : 's'})...`,
        }),
      );
      printStreamChunk(chunk);
    }
  } finally {
    clearInterval(heartbeat);
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
    console.log(buildResumeCommand(parsedArgs, 'approve'));
  }

  return { result, sawInterrupt };
}

function buildCoordinatorChildSpecs(parsedArgs: ParsedArgs): CoordinatorChildSpec[] {
  const requestedScopes = new Set(parsedArgs.scopes.map((scope) => String(scope || '').trim().toLowerCase()).filter(Boolean));
  const laneTemplates: Array<{ id: string; label: string; scopes: string[]; editAllowlist: string[]; intervalMs?: number }> = [];
  const baseIntervalMs = Math.max(1_000, parsedArgs.intervalMs);
  const idleSurfaceRespawnDelayMs = Math.max(baseIntervalMs * 30, 30_000);
  const researchRespawnDelayMs = Math.max(baseIntervalMs * 60, 60_000);
  const apiBackgroundRespawnDelayMs = Math.max(baseIntervalMs * 10, 10_000);

  const includeApiFamilyLanes = requestedScopes.has('repo') || requestedScopes.has('api') || requestedScopes.has('api-experimental');
  const includeRepoSurfaceFamilyLanes = requestedScopes.has('repo') || requestedScopes.has('repo-surface');

  if (includeApiFamilyLanes) {
    laneTemplates.push({
      id: 'api-routing',
      label: 'API Routing & Providers',
      scopes: ['api-routing'],
      editAllowlist: [
        'apps/api/providers',
        'apps/api/routes/openai.ts',
        'apps/api/modules/openaiProviderSelection.ts',
        'apps/api/modules/openaiRequestSupport.ts',
        'apps/api/modules/openaiRouteSupport.ts',
        'apps/api/modules/openaiRouteUtils.ts',
        'apps/api/modules/openaiResponsesFormat.ts',
        'apps/api/modules/geminiMediaValidation.ts',
        'apps/api/modules/responsesHistory.ts',
      ],
    });
    laneTemplates.push({
      id: 'api-runtime',
      label: 'API Runtime & Queue',
      scopes: ['api-runtime'],
      editAllowlist: [
        'apps/api/modules/requestQueue.ts',
        'apps/api/modules/requestIntake.ts',
        'apps/api/modules/rateLimit.ts',
        'apps/api/modules/rateLimitRedis.ts',
        'apps/api/modules/tokenEstimation.ts',
        'apps/api/modules/userData.ts',
        'apps/api/modules/errorClassification.ts',
        'apps/api/modules/errorLogger.ts',
        'apps/api/modules/middlewareFactory.ts',
      ],
    });
    laneTemplates.push({
      id: 'api-data',
      label: 'API Data & Model Sync',
      scopes: ['api-data'],
      intervalMs: Math.max(baseIntervalMs * 2, 2_000),
      editAllowlist: [
        'apps/api/models.json',
        'apps/api/pricing.json',
        'apps/api/modules/modelUpdater.ts',
        'apps/api/modules/dataManager.ts',
        'apps/api/modules/adminKeySync.ts',
        'apps/api/modules/keyChecker.ts',
        'apps/api/modules/db.ts',
        'apps/api/dev/fetchPricing.ts',
        'apps/api/dev/checkModelCapabilities.ts',
        'apps/api/dev/refreshModels.ts',
        'apps/api/dev/updatemodels.ts',
        'apps/api/dev/updateproviders.ts',
        'apps/api/routes/models.ts',
      ],
    });
    laneTemplates.push({
      id: 'api-platform',
      label: 'API Platform & Validation',
      scopes: ['api-platform'],
      intervalMs: Math.max(baseIntervalMs * 2, 2_000),
      editAllowlist: [
        'apps/api/server.ts',
        'apps/api/server.launcher.bun.ts',
        'apps/api/ws',
        'apps/api/anygpt-api.service',
        'apps/api/anygpt-experimental.service',
      ],
    });
  }

  if (requestedScopes.has('repo') || requestedScopes.has('control-plane')) {
    laneTemplates.push({
      id: 'control-plane',
      label: 'Control Plane',
      scopes: ['control-plane'],
      intervalMs: Math.max(baseIntervalMs * 2, 2_000),
      editAllowlist: ['apps/langgraph-control-plane'],
    });
    laneTemplates.push({
      id: 'research-scout',
      label: 'Research Scout',
      scopes: ['research-scout'],
      intervalMs: Math.max(baseIntervalMs * 10, 10_000),
      editAllowlist: ['apps/langgraph-control-plane'],
    });
  }

  if (includeRepoSurfaceFamilyLanes) {
    laneTemplates.push({
      id: 'workspace-surface',
      label: 'Workspace Surface',
      scopes: ['workspace-surface'],
      intervalMs: Math.max(baseIntervalMs * 5, 5_000),
      editAllowlist: ['package.json', 'turbo.json', 'bun.sh', 'README.md', 'SETUP.md', 'pnpm-workspace.yaml', 'tsconfig.json', 'scripts'],
    });
    laneTemplates.push({
      id: 'homepage-surface',
      label: 'Homepage Surface',
      scopes: ['homepage-surface'],
      intervalMs: Math.max(baseIntervalMs * 5, 5_000),
      editAllowlist: ['apps/homepage'],
    });
    laneTemplates.push({
      id: 'ui-surface',
      label: 'UI Surface',
      scopes: ['ui-surface'],
      intervalMs: Math.max(baseIntervalMs * 5, 5_000),
      editAllowlist: ['apps/ui'],
    });
  }

  if (laneTemplates.length === 0) {
    laneTemplates.push({
      id: 'primary',
      label: 'Primary',
      scopes: parsedArgs.scopes,
      intervalMs: baseIntervalMs,
      editAllowlist: parsedArgs.editAllowlist,
    });
  }

  const specs: CoordinatorChildSpec[] = [];
  for (const lane of laneTemplates) {
    const childAllowlist = intersectAllowlists(parsedArgs.editAllowlist, lane.editAllowlist);
    if (childAllowlist.length === 0) continue;
    const laneId = sanitizeCoordinatorId(lane.id);
    const statusFilePath = appendPathSuffix(parsedArgs.statusFilePath, laneId);
    const checkpointPath = appendPathSuffix(parsedArgs.checkpointPath, laneId);
    const pidFilePath = parsedArgs.pidFilePath
      ? appendPathSuffix(parsedArgs.pidFilePath, laneId)
      : replacePathExtension(statusFilePath, '.pid');
    specs.push({
      id: laneId,
      label: lane.label,
      scopes: lane.scopes,
      intervalMs: typeof lane.intervalMs === 'number' && Number.isFinite(lane.intervalMs)
        ? Math.max(1_000, Math.floor(lane.intervalMs))
        : baseIntervalMs,
      maxIterations: laneId === 'research-scout'
        ? 1
        : laneId === 'control-plane'
          ? 1
        : ['workspace-surface', 'homepage-surface', 'ui-surface'].includes(laneId)
          ? 1
          : ['api-data', 'api-platform'].includes(laneId)
            ? 1
            : parsedArgs.maxIterations,
      respawnDelayMs: laneId === 'research-scout'
        ? researchRespawnDelayMs
        : laneId === 'control-plane'
          ? apiBackgroundRespawnDelayMs
        : ['workspace-surface', 'homepage-surface', 'ui-surface'].includes(laneId)
          ? idleSurfaceRespawnDelayMs
          : ['api-data', 'api-platform'].includes(laneId)
            ? apiBackgroundRespawnDelayMs
            : MULTI_RUNNER_RESTART_DELAY_MS,
      editAllowlist: childAllowlist,
      checkpointPath,
      statusFilePath,
      pidFilePath,
      logFilePath: replacePathExtension(statusFilePath, '.log'),
      threadId: `${parsedArgs.threadId}:${laneId}`,
      scopeExpansionMode: 'locked',
    });
  }

  if (specs.length === 0) {
    throw new Error('Multi-runner coordinator could not derive any child lanes from the requested scopes and allowlist.');
  }

  return specs;
}

function buildCoordinatorChildArgs(parsedArgs: ParsedArgs, spec: CoordinatorChildSpec): string[] {
  return buildRunnerInvocationArgs(buildCoordinatorChildParsedArgs(parsedArgs, spec));
}

function spawnCoordinatorChild(parsedArgs: ParsedArgs, runtime: CoordinatorChildRuntime): void {
  fs.mkdirSync(path.dirname(runtime.spec.logFilePath), { recursive: true });
  seedCoordinatorChildStatus(parsedArgs, runtime.spec, {
    running: true,
    phase: 'starting',
    summary: 'Waiting for graph output...',
  });
  const logFlags = runtime.restartCount === 0 ? 'w' : 'a';
  fs.writeFileSync(
    runtime.spec.logFilePath,
    `${logFlags === 'w' ? '' : '\n'}[${new Date().toISOString()}] coordinator spawning ${runtime.spec.id} (${runtime.spec.label})\n`,
    { encoding: 'utf8', flag: logFlags },
  );

  const childEnv: Record<string, string> = {
    ...process.env,
    CONTROL_PLANE_COORDINATED_RUNNER: 'true',
  } as Record<string, string>;
  if (runtime.spec.id === 'research-scout') {
    childEnv.CONTROL_PLANE_AI_MODEL = String(
      process.env.CONTROL_PLANE_RESEARCH_SCOUT_AI_MODEL
      || 'gpt-5.4',
    ).trim() || 'gpt-5.4';
    childEnv.CONTROL_PLANE_AI_REASONING_EFFORT = String(
      process.env.CONTROL_PLANE_RESEARCH_SCOUT_AI_REASONING_EFFORT
      || 'xhigh',
    ).trim() || 'xhigh';
    childEnv.CONTROL_PLANE_GRAPH_STALL_TIMEOUT_MS = String(
      process.env.CONTROL_PLANE_RESEARCH_SCOUT_GRAPH_STALL_TIMEOUT_MS
      || '600000',
    ).trim() || '600000';
    childEnv.CONTROL_PLANE_RESEARCH_SCOUT_LIGHTWEIGHT_INSPECT = String(
      process.env.CONTROL_PLANE_RESEARCH_SCOUT_LIGHTWEIGHT_INSPECT
      || 'true',
    ).trim() || 'true';
  } else if (runtime.spec.id === 'api-routing') {
    childEnv.CONTROL_PLANE_AI_MODEL = String(
      process.env.CONTROL_PLANE_API_ROUTING_AI_MODEL
      || 'gpt-5.4',
    ).trim() || 'gpt-5.4';
    childEnv.CONTROL_PLANE_AI_REASONING_EFFORT = String(
      process.env.CONTROL_PLANE_API_ROUTING_AI_REASONING_EFFORT
      || 'xhigh',
    ).trim() || 'xhigh';
  } else if (runtime.spec.id === 'control-plane') {
    childEnv.CONTROL_PLANE_AI_MODEL = String(
      process.env.CONTROL_PLANE_CONTROL_PLANE_AI_MODEL
      || 'gpt-5.4',
    ).trim() || 'gpt-5.4';
    childEnv.CONTROL_PLANE_AI_REASONING_EFFORT = String(
      process.env.CONTROL_PLANE_CONTROL_PLANE_AI_REASONING_EFFORT
      || 'xhigh',
    ).trim() || 'xhigh';
  }

  const child = spawn('bash', buildCoordinatorChildArgs(parsedArgs, runtime.spec), {
    cwd: parsedArgs.repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logStream = fs.createWriteStream(runtime.spec.logFilePath, { flags: 'a' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  runtime.process = child;
  runtime.logStream = logStream;
  runtime.pid = typeof child.pid === 'number' ? child.pid : readPidFile(runtime.spec.pidFilePath);
  runtime.lastSpawnedAtMs = Date.now();
  runtime.lastSpawnError = undefined;
  runtime.lastExitCode = undefined;
  runtime.lastExitSignal = undefined;
  runtime.nextRestartAt = 0;
  runtime.lastSemanticProgressSignature = undefined;
  runtime.lastSemanticProgressAtMs = Date.now();
  runtime.lastStatusHeartbeatAtMs = Date.now();
  runtime.selfHealRequestedAtMs = undefined;
  runtime.selfHealEscalateAtMs = undefined;

  child.on('error', (error) => {
    runtime.lastSpawnError = formatError(error);
    fs.appendFileSync(
      runtime.spec.logFilePath,
      `[${new Date().toISOString()}] coordinator child spawn error: ${runtime.lastSpawnError}\n`,
      'utf8',
    );
  });

  child.on('exit', (code, signal) => {
    runtime.lastExitCode = code;
    runtime.lastExitSignal = signal;
    runtime.pid = undefined;
    runtime.process = undefined;
    runtime.nextRestartAt = Date.now() + Math.max(1_000, runtime.spec.respawnDelayMs || MULTI_RUNNER_RESTART_DELAY_MS);
    fs.appendFileSync(
      runtime.spec.logFilePath,
      `[${new Date().toISOString()}] coordinator observed exit code=${code ?? 'null'} signal=${signal ?? 'null'} next_restart_in_ms=${Math.max(1_000, runtime.spec.respawnDelayMs || MULTI_RUNNER_RESTART_DELAY_MS)}\n`,
      'utf8',
    );
    runtime.logStream?.end();
    runtime.logStream = undefined;
  });
}

function isCoordinatorCoreLane(runtime: CoordinatorChildRuntime): boolean {
  return ['api-routing', 'api-runtime'].includes(runtime.spec.id);
}

function getCoordinatorBackgroundActiveCount(runtimes: CoordinatorChildRuntime[]): number {
  return runtimes.filter((runtime) => {
    if (isCoordinatorCoreLane(runtime)) return false;
    const processAlive = runtime.process ? runtime.process.exitCode === null : false;
    const pidAlive = isPidAlive(runtime.process?.pid) || isPidAlive(runtime.pid) || isPidAlive(readPidFile(runtime.spec.pidFilePath));
    return processAlive || pidAlive;
  }).length;
}

function canCoordinatorChildRestart(
  parsedArgs: ParsedArgs,
  runtime: CoordinatorChildRuntime,
): boolean {
  return parsedArgs.continuous
    && parsedArgs.maxIterations === null
    && (!runtime.lastStatus || runtime.lastStatus.phase !== 'paused');
}

function selectNextCoordinatorBackgroundLaneToSpawn(
  parsedArgs: ParsedArgs,
  runtimes: CoordinatorChildRuntime[],
  nowMs: number,
  backgroundActiveCap: number,
): CoordinatorChildRuntime | null {
  if (backgroundActiveCap <= 0) return null;
  if (getCoordinatorBackgroundActiveCount(runtimes) >= backgroundActiveCap) {
    return null;
  }

  const eligible = runtimes.filter((runtime) => {
    if (isCoordinatorCoreLane(runtime)) return false;
    if (!canCoordinatorChildRestart(parsedArgs, runtime)) return false;
    const processAlive = runtime.process ? runtime.process.exitCode === null : false;
    const pidAlive = isPidAlive(runtime.process?.pid) || isPidAlive(runtime.pid) || isPidAlive(readPidFile(runtime.spec.pidFilePath));
    if (processAlive || pidAlive) return false;
    return nowMs >= runtime.nextRestartAt;
  });

  if (eligible.length === 0) return null;
  eligible.sort((left, right) =>
    (left.lastSpawnedAtMs ?? 0) - (right.lastSpawnedAtMs ?? 0)
    || left.restartCount - right.restartCount
    || left.spec.id.localeCompare(right.spec.id)
  );
  return eligible[0] || null;
}

function updateCoordinatorChildProgressObservation(runtime: CoordinatorChildRuntime, nowMs: number): void {
  const status = runtime.lastStatus;
  const statusHeartbeatAtMs = parseIsoTimestampMs(status?.lastUpdatedAt);
  if (typeof statusHeartbeatAtMs === 'number') {
    runtime.lastStatusHeartbeatAtMs = Math.max(runtime.lastStatusHeartbeatAtMs || 0, statusHeartbeatAtMs);
  } else if (typeof runtime.lastStatusHeartbeatAtMs !== 'number') {
    runtime.lastStatusHeartbeatAtMs = nowMs;
  }

  const nextSignature = buildCoordinatorChildSemanticProgressSignature(status);
  if (!runtime.lastSemanticProgressSignature) {
    runtime.lastSemanticProgressSignature = nextSignature;
    runtime.lastSemanticProgressAtMs = nowMs;
    return;
  }

  if (runtime.lastSemanticProgressSignature !== nextSignature) {
    runtime.lastSemanticProgressSignature = nextSignature;
    runtime.lastSemanticProgressAtMs = nowMs;
  } else if (typeof runtime.lastSemanticProgressAtMs !== 'number') {
    runtime.lastSemanticProgressAtMs = nowMs;
  }
}

function updateCoordinatorChildAiBackpressureObservation(runtime: CoordinatorChildRuntime, nowMs: number): void {
  if (coordinatorChildStatusHasAiBackpressure(runtime.lastStatus)) {
    runtime.lastAiBackpressureAtMs = nowMs;
  }
}

function resolveCoordinatorAiBackpressureActiveUntilMs(runtimes: CoordinatorChildRuntime[]): number {
  return runtimes.reduce((latest, runtime) => {
    if (typeof runtime.lastAiBackpressureAtMs !== 'number') return latest;
    return Math.max(latest, runtime.lastAiBackpressureAtMs + MULTI_RUNNER_AI_BACKPRESSURE_COOLDOWN_MS);
  }, 0);
}

function appendCoordinatorChildRuntimeNote(runtime: CoordinatorChildRuntime, message: string): void {
  fs.appendFileSync(
    runtime.spec.logFilePath,
    `[${new Date().toISOString()}] ${message}\n`,
    'utf8',
  );
}

function requestCoordinatorChildSelfHeal(runtime: CoordinatorChildRuntime, reason: string, nowMs: number): void {
  if (runtime.selfHealRequestedAtMs) return;

  runtime.selfHealCount += 1;
  runtime.lastSelfHealAt = new Date(nowMs).toISOString();
  runtime.lastSelfHealReason = reason;
  runtime.selfHealRequestedAtMs = nowMs;
  runtime.selfHealEscalateAtMs = nowMs + MULTI_RUNNER_SELF_HEAL_TERM_GRACE_MS;
  runtime.nextRestartAt = 0;
  appendCoordinatorChildRuntimeNote(
    runtime,
    `coordinator self-heal #${runtime.selfHealCount}: ${reason}`,
  );

  const pid = runtime.process?.pid || runtime.pid || readPidFile(runtime.spec.pidFilePath);
  if (typeof pid === 'number' && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      appendCoordinatorChildRuntimeNote(
        runtime,
        `coordinator self-heal failed to send SIGTERM: ${formatError(error)}`,
      );
    }
    return;
  }

  runtime.selfHealRequestedAtMs = undefined;
  runtime.selfHealEscalateAtMs = undefined;
}

function serviceCoordinatorChildSelfHeal(runtime: CoordinatorChildRuntime, nowMs: number): void {
  if (!runtime.selfHealRequestedAtMs) return;

  const pid = runtime.process?.pid || runtime.pid || readPidFile(runtime.spec.pidFilePath);
  if (!(typeof pid === 'number' && isPidAlive(pid))) {
    runtime.selfHealRequestedAtMs = undefined;
    runtime.selfHealEscalateAtMs = undefined;
    runtime.nextRestartAt = 0;
    return;
  }

  if (typeof runtime.selfHealEscalateAtMs === 'number' && nowMs >= runtime.selfHealEscalateAtMs) {
    appendCoordinatorChildRuntimeNote(
      runtime,
      `coordinator self-heal escalating to SIGKILL after ${formatDurationMs(MULTI_RUNNER_SELF_HEAL_TERM_GRACE_MS)} grace period`,
    );
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      appendCoordinatorChildRuntimeNote(
        runtime,
        `coordinator self-heal failed to send SIGKILL: ${formatError(error)}`,
      );
    }
    runtime.selfHealEscalateAtMs = undefined;
  }
}

function evaluateCoordinatorChildSelfHealReason(runtime: CoordinatorChildRuntime, nowMs: number): string | undefined {
  if (runtime.selfHealRequestedAtMs) return undefined;

  const lastSelfHealAtMs = parseIsoTimestampMs(runtime.lastSelfHealAt);
  if (typeof lastSelfHealAtMs === 'number' && nowMs - lastSelfHealAtMs < MULTI_RUNNER_SELF_HEAL_COOLDOWN_MS) {
    return undefined;
  }

  const status = runtime.lastStatus;
  const statusSummary = typeof status?.summary === 'string' ? status.summary.trim() : '';
  const repairStatus = typeof status?.repairStatus === 'string' ? status.repairStatus.trim() : '';
  const noProgressReason = typeof status?.noProgressReason === 'string' ? status.noProgressReason.trim() : '';
  const proposedEditCount = typeof status?.proposedEditCount === 'number' && Number.isFinite(status.proposedEditCount)
    ? status.proposedEditCount
    : 0;
  const appliedEditCount = typeof status?.appliedEditCount === 'number' && Number.isFinite(status.appliedEditCount)
    ? status.appliedEditCount
    : 0;

  const statusAgeMs = typeof runtime.lastStatusHeartbeatAtMs === 'number'
    ? nowMs - runtime.lastStatusHeartbeatAtMs
    : 0;
  const semanticStallMs = typeof runtime.lastSemanticProgressAtMs === 'number'
    ? nowMs - runtime.lastSemanticProgressAtMs
    : 0;

  if (statusAgeMs >= MULTI_RUNNER_SELF_HEAL_STATUS_STALE_MS) {
    return `lane status heartbeat stalled for ${formatDurationMs(statusAgeMs)} while the child process remained alive`;
  }

  if (
    noProgressReason
    && semanticStallMs >= MULTI_RUNNER_SELF_HEAL_NO_PROGRESS_STALL_MS
  ) {
    return `lane stayed in no-progress guard for ${formatDurationMs(semanticStallMs)} (${noProgressReason})`;
  }

  if (
    repairStatus === 'rolled-back'
    && semanticStallMs >= MULTI_RUNNER_SELF_HEAL_ROLLED_BACK_STALL_MS
  ) {
    return `lane remained rolled back for ${formatDurationMs(semanticStallMs)} without a new bounded repair attempt`;
  }

  if (
    repairStatus === 'idle'
    && proposedEditCount === 0
    && appliedEditCount === 0
    && isCoordinatorChildPlaceholderSummary(statusSummary)
    && semanticStallMs >= MULTI_RUNNER_SELF_HEAL_STARTUP_STALL_MS
  ) {
    return `lane stayed in ${statusSummary || 'startup placeholder'} for ${formatDurationMs(semanticStallMs)} without semantic progress`;
  }

  return undefined;
}

function collectCoordinatedRunnerEntry(runtime: CoordinatorChildRuntime): CoordinatedRunnerStatusEntry {
  const status = runtime.lastStatus || {};
  const pidFromFile = readPidFile(runtime.spec.pidFilePath);
  const processPid = runtime.process?.pid;
  const processAlive = runtime.process ? runtime.process.exitCode === null : false;
  const filePidAlive = isPidAlive(pidFromFile);
  const cachedPidAlive = !filePidAlive && isPidAlive(runtime.pid) ? runtime.pid : undefined;
  const pid = processAlive
    ? processPid
    : (filePidAlive ? pidFromFile : cachedPidAlive);
  const running = processAlive || Boolean(filePidAlive || cachedPidAlive);

  let phase = typeof status.phase === 'string' ? status.phase : '';
  if (!running && ['starting', 'streaming', 'sleeping'].includes(phase)) {
    phase = '';
  }
  if (!phase) {
    phase = running
      ? 'streaming'
      : (
        (typeof status.healthClass === 'string' && status.healthClass === 'failed')
        || (
        (typeof status.lastError === 'string' && status.lastError.trim())
        || runtime.lastSpawnError
        || (typeof runtime.lastExitCode === 'number' && runtime.lastExitCode !== 0)
        )
      )
        ? 'failed'
        : 'completed';
  }
  if (
    phase === 'failed'
    && (status.healthClass === 'waiting_evidence' || status.healthClass === 'blocked_external')
  ) {
    phase = running ? 'streaming' : 'completed';
  }

  return {
    id: runtime.spec.id,
    label: runtime.spec.label,
    threadId: runtime.spec.threadId,
    scopes: runtime.spec.scopes,
    editAllowlist: runtime.spec.editAllowlist,
    checkpointPath: runtime.spec.checkpointPath,
    statusFilePath: runtime.spec.statusFilePath,
    pidFilePath: runtime.spec.pidFilePath,
    logFilePath: runtime.spec.logFilePath,
    pid,
    running,
    phase,
    iteration: typeof status.iteration === 'number' && Number.isFinite(status.iteration) ? status.iteration : 0,
    proposedEditCount: typeof status.proposedEditCount === 'number' && Number.isFinite(status.proposedEditCount) ? status.proposedEditCount : 0,
    appliedEditCount: typeof status.appliedEditCount === 'number' && Number.isFinite(status.appliedEditCount) ? status.appliedEditCount : 0,
    repairStatus: typeof status.repairStatus === 'string' ? status.repairStatus : undefined,
    healthClass: typeof status.healthClass === 'string' ? status.healthClass as RunnerStatus['healthClass'] : undefined,
    deferReason: typeof status.deferReason === 'string' && status.deferReason.trim()
      ? status.deferReason
      : undefined,
    evidenceStatus: typeof status.evidenceStatus === 'string' ? status.evidenceStatus as RunnerStatus['evidenceStatus'] : undefined,
    lastAiFailureClass: typeof status.lastAiFailureClass === 'string'
      ? status.lastAiFailureClass as RunnerStatus['lastAiFailureClass']
      : undefined,
    validationRequired: status.validationRequired === true,
    lastError: typeof status.lastError === 'string' && status.lastError.trim()
      ? status.lastError
      : runtime.lastSpawnError,
    lastUpdatedAt: typeof status.lastUpdatedAt === 'string' ? status.lastUpdatedAt : undefined,
    restartedCount: runtime.restartCount,
    selfHealCount: runtime.selfHealCount,
    lastSelfHealAt: runtime.lastSelfHealAt,
    lastSelfHealReason: runtime.lastSelfHealReason,
    summary: typeof status.summary === 'string' ? status.summary : undefined,
    scopeExpansionMode: runtime.spec.scopeExpansionMode,
  };
}

function summarizeCoordinatorRepairStatus(children: CoordinatedRunnerStatusEntry[]): RunnerStatus['repairStatus'] {
  const statuses = children.map((child) => String(child.repairStatus || '').trim()).filter(Boolean);
  const failedChildren = children.filter((child) => child.healthClass === 'failed');
  if (failedChildren.length > 0 || statuses.includes('failed')) return 'failed';
  if (statuses.includes('promoted')) return 'promoted';
  if (statuses.includes('planned')) return 'planned';
  if (statuses.includes('rolled-back')) return 'rolled-back';
  if (statuses.includes('not-needed')) return 'not-needed';
  return 'idle';
}

function summarizeCoordinatorHealthClass(children: CoordinatedRunnerStatusEntry[]): RunnerStatus['healthClass'] {
  const healthClasses = children.map((child) => String(child.healthClass || '').trim()).filter(Boolean);
  if (healthClasses.includes('failed')) return 'failed';
  if (healthClasses.includes('waiting_evidence')) return 'waiting_evidence';
  if (healthClasses.includes('blocked_external')) return 'blocked_external';
  if (healthClasses.includes('degraded')) return 'degraded';
  return 'healthy';
}

function buildCoordinatorSummary(
  parsedArgs: ParsedArgs,
  children: CoordinatedRunnerStatusEntry[],
  backgroundActiveCap: number,
  cpuBusyPercent: number | null,
  options: {
    warmupRemainingMs?: number;
    aiBackpressureRemainingMs?: number;
  } = {},
): string {
  const runningChildren = children.filter((child) => child.running);
  const failedChildren = children.filter((child) => child.healthClass === 'failed');
  const deferredChildren = children.filter((child) => child.healthClass === 'blocked_external' || child.healthClass === 'waiting_evidence');
  const degradedChildren = children.filter((child) => child.healthClass === 'degraded');
  const selfHealedChildren = children.filter((child) => child.selfHealCount > 0);
  const backgroundRunningChildren = runningChildren.filter((child) => !['api-routing', 'api-runtime', 'control-plane'].includes(child.id));
  const lines = [
    `Goal: ${parsedArgs.goal}`,
    `Coordinator mode: multi-runner (${children.length} child lane(s), interval=${parsedArgs.intervalMs}ms)`,
    `Background lane cap: ${backgroundActiveCap}/${MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX} concurrent background lane(s)${cpuBusyPercent !== null ? ` (cpu_busy=${cpuBusyPercent.toFixed(1)}%)` : ''}`,
    `Requested scopes: ${parsedArgs.scopes.join(', ')}`,
    `Children: ${children.map((child) => `${child.id}=${child.phase}${child.running ? '/running' : ''}`).join('; ') || 'none'}`,
    `Autonomous edits: ${children.reduce((sum, child) => sum + child.proposedEditCount, 0)} proposed, ${children.reduce((sum, child) => sum + child.appliedEditCount, 0)} applied`,
  ];

  if ((options.warmupRemainingMs || 0) > 0 && backgroundActiveCap < MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_MAX) {
    lines.push(
      `Warmup throttle: limiting background lanes to ${backgroundActiveCap} for another ${formatDurationMs(options.warmupRemainingMs || 0)} while the coordinator ramps up.`,
    );
  }
  if ((options.aiBackpressureRemainingMs || 0) > 0) {
    lines.push(
      `AI backpressure throttle: recent shared-backend queue saturation is limiting background lanes to ${backgroundActiveCap} for another ${formatDurationMs(options.aiBackpressureRemainingMs || 0)}.`,
    );
  }

  if (failedChildren.length > 0) {
    lines.push(`Failures: ${failedChildren.map((child) => `${child.id}${child.lastError ? ` (${child.lastError})` : ''}`).join('; ')}`);
  }
  if (deferredChildren.length > 0) {
    lines.push(`Deferred lanes: ${deferredChildren.map((child) => `${child.id}${child.deferReason ? ` (${child.deferReason})` : ''}`).join('; ')}`);
  }
  if (degradedChildren.length > 0) {
    lines.push(`Degraded lanes: ${degradedChildren.map((child) => `${child.id}${child.lastAiFailureClass ? ` (${child.lastAiFailureClass})` : ''}`).join('; ')}`);
  }
  if (selfHealedChildren.length > 0) {
    lines.push(
      `Self-heal: ${selfHealedChildren.map((child) => `${child.id}#${child.selfHealCount}${child.lastSelfHealReason ? ` (${child.lastSelfHealReason})` : ''}`).join('; ')}`,
    );
  }
  if (runningChildren.length > 0) {
    lines.push(`Active lanes: ${runningChildren.map((child) => `${child.id}@${child.iteration}`).join(', ')}`);
  }
  if (backgroundRunningChildren.length > 0) {
    lines.push(`Active background lanes: ${backgroundRunningChildren.map((child) => `${child.id}@${child.iteration}`).join(', ')}`);
  }

  return lines.join('\n');
}

async function runMultiRunnerCoordinator(parsedArgs: ParsedArgs): Promise<void> {
  if (typeof parsedArgs.resumeValue !== 'undefined') {
    throw new Error('Multi-runner coordinator does not support --resume; resume a child runner directly by thread id instead.');
  }

  const childSpecs = buildCoordinatorChildSpecs(parsedArgs);
  const childRuntimes: CoordinatorChildRuntime[] = childSpecs.map((spec) => ({
    spec,
    restartCount: 0,
    nextRestartAt: 0,
    selfHealCount: 0,
  }));

  let coordinatorStatus = mergeRunnerStatus(createBaseRunnerStatus(parsedArgs), {
    running: true,
    phase: 'starting',
    runnerMode: 'multi-runner-coordinator',
    coordinatorStrategy: `disjoint-lane-supervisor:${childSpecs.map((spec) => spec.id).join(',')}`,
    coordinatedRunnerCount: childSpecs.length,
    coordinatedRunners: childSpecs.map((spec) => ({
      id: spec.id,
      label: spec.label,
      threadId: spec.threadId,
      scopes: spec.scopes,
      editAllowlist: spec.editAllowlist,
      checkpointPath: spec.checkpointPath,
      statusFilePath: spec.statusFilePath,
      pidFilePath: spec.pidFilePath,
      logFilePath: spec.logFilePath,
      running: false,
      phase: 'starting',
      iteration: 0,
      proposedEditCount: 0,
      appliedEditCount: 0,
      healthClass: 'healthy',
      deferReason: '',
      evidenceStatus: 'unknown',
      lastAiFailureClass: 'none',
      validationRequired: false,
      restartedCount: 0,
      selfHealCount: 0,
      scopeExpansionMode: spec.scopeExpansionMode,
    })),
    summary: `Preparing multi-runner coordinator for ${childSpecs.length} child lane(s).`,
  });
  bindRunnerPidFile(parsedArgs.pidFilePath);
  writeRunnerStatus(parsedArgs.statusFilePath, coordinatorStatus);

  let shuttingDown = false;
  const requestShutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    coordinatorStatus = mergeRunnerStatus(coordinatorStatus, {
      running: false,
      phase: 'completed',
      summary: `${coordinatorStatus.summary || 'Coordinator shutting down.'}\nShutdown reason: ${reason}`,
    });
    for (const runtime of childRuntimes) {
      const pid = runtime.process?.pid || runtime.pid || readPidFile(runtime.spec.pidFilePath);
      if (typeof pid === 'number' && isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Ignore child shutdown errors.
        }
      }
    }
  };

  const sigintHandler = () => requestShutdown('SIGINT');
  const sigtermHandler = () => requestShutdown('SIGTERM');
  const sighupHandler = () => requestShutdown('SIGHUP');
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  process.on('SIGHUP', sighupHandler);

  try {
    const coordinatorStartedAtMs = Date.now();
    let previousCpuSnapshot = readCpuSnapshot();
    for (const runtime of childRuntimes) {
      const existingPid = readPidFile(runtime.spec.pidFilePath);
      if (isPidAlive(existingPid)) {
        runtime.pid = existingPid;
        runtime.lastSpawnedAtMs = Date.now();
        runtime.lastStatus = readCoordinatorChildStatusSnapshot(runtime.spec);
        runtime.lastSemanticProgressSignature = buildCoordinatorChildSemanticProgressSignature(runtime.lastStatus);
        runtime.lastSemanticProgressAtMs = Date.now();
        runtime.lastStatusHeartbeatAtMs = parseIsoTimestampMs(runtime.lastStatus?.lastUpdatedAt) ?? Date.now();
        continue;
      }
      seedCoordinatorChildStatus(parsedArgs, runtime.spec, {
        running: false,
        phase: 'completed',
        summary: isCoordinatorCoreLane(runtime) ? 'Waiting for core lane spawn...' : 'Queued for background slot.',
      });
      if (isCoordinatorCoreLane(runtime)) {
        spawnCoordinatorChild(parsedArgs, runtime);
      } else {
        runtime.nextRestartAt = 0;
      }
    }

    while (true) {
      const nowMs = Date.now();
      const nextCpuSnapshot = readCpuSnapshot();
      const cpuBusyPercent = computeCpuBusyPercent(previousCpuSnapshot, nextCpuSnapshot);
      previousCpuSnapshot = nextCpuSnapshot;
      let backgroundActiveCap = resolveAdaptiveBackgroundActiveCap(cpuBusyPercent);
      for (const runtime of childRuntimes) {
        runtime.lastStatus = readCoordinatorChildStatusSnapshot(runtime.spec);
        const pidFromFile = readPidFile(runtime.spec.pidFilePath);
        if (!runtime.process) {
          if (isPidAlive(pidFromFile)) {
            runtime.pid = pidFromFile;
          } else if (!isPidAlive(runtime.pid)) {
            runtime.pid = undefined;
          }
        }

        updateCoordinatorChildProgressObservation(runtime, nowMs);
        updateCoordinatorChildAiBackpressureObservation(runtime, nowMs);
        serviceCoordinatorChildSelfHeal(runtime, nowMs);

        const canRestart = !shuttingDown && canCoordinatorChildRestart(parsedArgs, runtime);
        const processAlive = runtime.process ? runtime.process.exitCode === null : false;
        const pidAlive = isPidAlive(pidFromFile) || isPidAlive(runtime.pid);
        if ((processAlive || pidAlive) && canRestart) {
          const selfHealReason = evaluateCoordinatorChildSelfHealReason(runtime, nowMs);
          if (selfHealReason) {
            requestCoordinatorChildSelfHeal(runtime, selfHealReason, nowMs);
          }
        }
        if (isCoordinatorCoreLane(runtime) && !processAlive && !pidAlive && canRestart && Date.now() >= runtime.nextRestartAt) {
          runtime.restartCount += 1;
          spawnCoordinatorChild(parsedArgs, runtime);
        }
      }

      const warmupRemainingMs = Math.max(
        0,
        (coordinatorStartedAtMs + MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_WARMUP_MS) - nowMs,
      );
      if (warmupRemainingMs > 0) {
        backgroundActiveCap = Math.min(backgroundActiveCap, MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_WARMUP_MAX);
      }
      const aiBackpressureActiveUntilMs = resolveCoordinatorAiBackpressureActiveUntilMs(childRuntimes);
      const aiBackpressureRemainingMs = Math.max(0, aiBackpressureActiveUntilMs - nowMs);
      if (aiBackpressureRemainingMs > 0) {
        backgroundActiveCap = Math.min(backgroundActiveCap, MULTI_RUNNER_BACKGROUND_ACTIVE_CAP_BACKPRESSURE_MAX);
      }

      while (!shuttingDown) {
        const nextBackgroundLane = selectNextCoordinatorBackgroundLaneToSpawn(parsedArgs, childRuntimes, nowMs, backgroundActiveCap);
        if (!nextBackgroundLane) break;
        nextBackgroundLane.restartCount += 1;
        spawnCoordinatorChild(parsedArgs, nextBackgroundLane);
      }

      const coordinatedRunners = childRuntimes.map((runtime) => collectCoordinatedRunnerEntry(runtime));
      const phase = coordinatedRunners.some((child) => child.phase === 'paused')
        ? 'paused'
        : coordinatedRunners.some((child) => child.running)
          ? 'streaming'
          : coordinatedRunners.some((child) => child.healthClass === 'failed' || child.phase === 'failed')
            ? 'failed'
            : 'completed';
      const iteration = coordinatedRunners.reduce((maxIteration, child) => Math.max(maxIteration, child.iteration), 0);
      const proposedEditCount = coordinatedRunners.reduce((sum, child) => sum + child.proposedEditCount, 0);
      const appliedEditCount = coordinatedRunners.reduce((sum, child) => sum + child.appliedEditCount, 0);
      const lastAppliedEditPaths = Array.from(new Set(
        childRuntimes.flatMap((runtime) => Array.isArray(runtime.lastStatus?.lastAppliedEditPaths)
          ? runtime.lastStatus?.lastAppliedEditPaths || []
          : []),
      ));

      coordinatorStatus = mergeRunnerStatus(coordinatorStatus, {
        running: !shuttingDown && coordinatedRunners.some((child) => child.running),
        phase,
        iteration,
        proposedEditCount,
        appliedEditCount,
        lastAppliedEditPaths,
        repairStatus: summarizeCoordinatorRepairStatus(coordinatedRunners),
        healthClass: summarizeCoordinatorHealthClass(coordinatedRunners),
        deferReason: coordinatedRunners
          .filter((child) => child.healthClass === 'blocked_external' || child.healthClass === 'waiting_evidence')
          .map((child) => `${child.id}:${child.deferReason || child.healthClass}`)
          .join('; '),
        evidenceStatus: coordinatedRunners.some((child) => child.evidenceStatus === 'missing')
          ? 'missing'
          : coordinatedRunners.some((child) => child.evidenceStatus === 'planned')
            ? 'planned'
            : coordinatedRunners.some((child) => child.evidenceStatus === 'collected')
              ? 'collected'
              : coordinatedRunners.some((child) => child.evidenceStatus === 'validated')
                ? 'validated'
                : coordinatedRunners.every((child) => child.validationRequired === false)
                  ? 'not-required'
                  : 'unknown',
        lastAiFailureClass: coordinatedRunners
          .map((child) => child.lastAiFailureClass)
          .find((value) => value && value !== 'none') || 'none',
        validationRequired: coordinatedRunners.some((child) => child.validationRequired === true),
        repairDecisionReason: coordinatedRunners
          .filter((child) => child.repairStatus && child.repairStatus !== 'idle' && child.repairStatus !== 'not-needed')
          .map((child) => `${child.id}:${child.repairStatus}`)
          .join('; '),
        coordinatedRunnerCount: coordinatedRunners.length,
        coordinatedRunners,
        summary: buildCoordinatorSummary(parsedArgs, coordinatedRunners, backgroundActiveCap, cpuBusyPercent, {
          warmupRemainingMs,
          aiBackpressureRemainingMs,
        }),
        lastRunStartedAt: coordinatedRunners
          .map((child) => child.lastUpdatedAt || '')
          .filter(Boolean)
          .sort()
          .slice(-1)[0] || coordinatorStatus.lastRunStartedAt,
        lastRunCompletedAt: coordinatedRunners.every((child) => !child.running) ? new Date().toISOString() : coordinatorStatus.lastRunCompletedAt,
        lastError: coordinatedRunners
          .filter((child) => Boolean(child.lastError))
          .map((child) => `${child.id}: ${child.lastError}`)
          .join(' | ') || undefined,
      });
      writeRunnerStatus(parsedArgs.statusFilePath, coordinatorStatus);

      const activeChildren = coordinatedRunners.filter((child) => child.running).length;
      if (shuttingDown && activeChildren === 0) {
        break;
      }
      if ((!parsedArgs.continuous || parsedArgs.maxIterations !== null) && activeChildren === 0) {
        break;
      }

      await sleep(MULTI_RUNNER_COORDINATOR_POLL_MS);
    }
  } finally {
    coordinatorStatus = mergeRunnerStatus(coordinatorStatus, {
      running: false,
      phase: coordinatorStatus.phase === 'failed' ? 'failed' : 'completed',
    });
    writeRunnerStatus(parsedArgs.statusFilePath, coordinatorStatus);
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGHUP', sighupHandler);
    if (parsedArgs.pidFilePath) {
      removeRunnerPidFile(parsedArgs.pidFilePath, process.pid);
      if (boundRunnerPidFilePath === parsedArgs.pidFilePath) {
        boundRunnerPidFilePath = undefined;
      }
    }
  }
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  loadEnvForControlPlane(parsedArgs.repoRoot);
  await configureLangSmithRuntime();
  if (parsedArgs.multiRunner && !parsedArgs.coordinatorChildId) {
    await runMultiRunnerCoordinator(parsedArgs);
    return;
  }
  const { graph: controlPlaneGraph, store } = await createControlPlaneGraph({
    repoRoot: parsedArgs.repoRoot,
    checkpointPath: parsedArgs.checkpointPath,
  });
  let runnerStatus = createBaseRunnerStatus(parsedArgs);
  bindRunnerPidFile(parsedArgs.pidFilePath);
  writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);
  installRunnerLifecycleHooks(parsedArgs, () => runnerStatus);

  let iteration = 0;
  let consecutiveTerminalFailures = 0;
  while (true) {
    iteration += 1;
    runnerStatus = mergeRunnerStatus(runnerStatus, {
      iteration,
      running: true,
      phase: 'starting',
      lastRunCompletedAt: undefined,
      summary: 'Starting graph run...',
    });
    writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);

    try {
      const { result, sawInterrupt } = await runGraphOnce(parsedArgs, controlPlaneGraph, runnerStatus);
      const terminalFailureSummary = summarizeTerminalRunFailure(result);
      const resultRecord = result as Record<string, unknown>;
      const progressSignature = deriveNoProgressSignature(resultRecord);
      const meaningfulProgress = hasMeaningfulIterationProgress(resultRecord);
      const previousNoProgressStreak = typeof runnerStatus.noProgressStreak === 'number'
        ? runnerStatus.noProgressStreak
        : 0;
      const noProgressStreak = meaningfulProgress
        ? 0
        : (
          progressSignature
          && runnerStatus.lastProgressSignature === progressSignature
            ? previousNoProgressStreak + 1
            : 1
        );
      const noProgressReason = noProgressStreak >= MAX_NO_PROGRESS_STREAK
        ? `No-progress loop guard: repeated the same non-progress outcome ${noProgressStreak} time(s); back off and require a stronger path-bounded change or an explicit no-op.`
        : '';
      const recentAutonomousLearningNotes = deriveRecentAutonomousLearningNotes(
        resultRecord,
        runnerStatus.recentAutonomousLearningNotes,
      );
      const sameThreadValidationObserved = Boolean(
        resultRecord.langSmithSameThreadRunObserved
        || resultRecord.sameThreadLangSmithRunObserved
        || resultRecord.sameThreadValidationObserved,
      );
      const currentThreadId = typeof parsedArgs.threadId === 'string'
        ? parsedArgs.threadId.trim()
        : '';
      const sameThreadPendingThreadId = typeof resultRecord.sameThreadPendingThreadId === 'string'
        ? resultRecord.sameThreadPendingThreadId.trim()
        : '';
      const sameThreadPendingObserved = Boolean(
        resultRecord.sameThreadLangSmithPendingObserved
        || resultRecord.langSmithSameThreadPendingObserved
        || sameThreadPendingThreadId,
      );
      const partialReadinessObserved = Boolean(
        resultRecord.controlPlanePartialReadinessObserved
        || resultRecord.startupFlushedSoonAfterReady
        || resultRecord.serverStartedThenExited
      );
      const localhostApiRefusalObserved = Boolean(
        resultRecord.localhostApiRefusalObserved
        || resultRecord.localhostApiRefusalSignal
        || resultRecord.blockedAppsApiLocalhostRefusalObserved,
      );
      const blockedAppsApiLocalhostRefusalNote = localhostApiRefusalObserved
        ? ' The direct fix for apps/api/logs/provider-unique-errors.jsonl openai sendMessage ECONNREFUSED at http://localhost:3101/v1/responses remains out of scope in apps/api provider/runtime routing for this bounded control-plane iteration, and retrying the same openai sendMessage localhost target is unlikely to help until that blocked runtime is serving again.'
        : '';
      const operatorFacingNoRunDeferReason = !sameThreadValidationObserved
        ? (
            sameThreadPendingObserved && partialReadinessObserved
              ? `No fresh same-thread LangSmith control-plane run/trace was completed for current thread ${currentThreadId || 'unknown-thread'}; sampled LangSmith visibility is pending-only for thread ${sameThreadPendingThreadId || 'unknown-thread'} and startup evidence is partial readiness only because the control-plane registered graphs, started workers, or reported server-running before flushing/exiting.${blockedAppsApiLocalhostRefusalNote} Cross-thread activity does not satisfy this iteration, so preserve a clear no-run defer reason until one fresh same-thread run/trace with explicit goal context and a passed smoke/typecheck result exists.`
              :
            partialReadinessObserved
              ? `No fresh same-thread LangSmith control-plane run/trace was observed for current thread ${currentThreadId || 'unknown-thread'} during this iteration; startup logs only provide partial readiness evidence because the control-plane registered graphs, started workers, or reported server-running before flushing/exiting.${blockedAppsApiLocalhostRefusalNote} Preserve a no-run defer reason until the same thread emits a fresh completed LangSmith run/trace with explicit goal context and control-plane smoke/typecheck passes.`
              :             partialReadinessObserved
              ? `No fresh same-thread LangSmith control-plane run/trace was observed for thread ${runnerStatus.threadId}. Control-plane startup showed only partial readiness evidence (for example graph registration, worker startup, or server-running followed by an immediate flush/exit), so do not treat this iteration as validated yet.`
              :
          sameThreadPendingObserved && partialReadinessObserved
            ? `No fresh same-thread LangSmith control-plane run/trace was completed for this iteration; pending same-thread visibility for ${sameThreadPendingThreadId || 'the current control-plane thread'} and startup logs that registered graphs, started workers, or reported server-running before an immediate flush/exit are only partial observability plus partial readiness evidence. Preserve a clear operator-facing no-run defer reason until same-thread validation and smoke/typecheck results exist.`
            : sameThreadPendingObserved
              ? `No fresh same-thread LangSmith control-plane run/trace was completed for this iteration; pending same-thread visibility for ${sameThreadPendingThreadId || 'the current control-plane thread'} is partial observability evidence only, not completed validation. Preserve a clear operator-facing no-run defer reason until same-thread validation and smoke/typecheck results exist.`
              : partialReadinessObserved
                ? 'No fresh same-thread LangSmith control-plane run/trace was completed for this iteration; startup logs showed graph registration, worker startup, or server-running evidence followed by an immediate flush/exit, which is partial readiness evidence only. Preserve a clear operator-facing no-run defer reason until same-thread validation and smoke/typecheck results exist.'
                : 'No fresh same-thread LangSmith control-plane run/trace was observed for this iteration; treat any startup logs as readiness evidence only and preserve a clear operator-facing no-run defer reason until same-thread validation and smoke/typecheck results exist.'
        )
        : '';
      if (noProgressReason && !recentAutonomousLearningNotes.includes('When the same outcome repeats without new edits or job deltas, either propose one stronger path-bounded change or explicitly no-op and defer instead of re-planning the same idea.')) {
        recentAutonomousLearningNotes.push('When the same outcome repeats without new edits or job deltas, either propose one stronger path-bounded change or explicitly no-op and defer instead of re-planning the same idea.');
      }
      if (operatorFacingNoRunDeferReason && !recentAutonomousLearningNotes.includes(operatorFacingNoRunDeferReason)) {
        recentAutonomousLearningNotes.push(operatorFacingNoRunDeferReason);
      }
      consecutiveTerminalFailures = terminalFailureSummary
        ? consecutiveTerminalFailures + 1
        : 0;
      const checkpointHistorySeed = await collectCheckpointHistorySeed(controlPlaneGraph, parsedArgs.threadId);
      runnerStatus = mergeRunnerStatus(runnerStatus, {
        running: parsedArgs.continuous && !sawInterrupt && !terminalFailureSummary,
        phase: sawInterrupt ? 'paused' : (terminalFailureSummary ? 'failed' : 'completed'),
        sawInterrupt,
        lastError: terminalFailureSummary || undefined,
        proposedEditCount: Array.isArray(result.proposedEdits) ? result.proposedEdits.length : 0,
        appliedEditCount: Array.isArray(result.appliedEdits)
          ? result.appliedEdits.filter((edit: any) => edit?.status === 'applied').length
          : 0,
        lastAppliedEditPaths: Array.isArray(result.appliedEdits)
          ? result.appliedEdits
              .filter((edit: any) => edit?.status === 'applied' && typeof edit?.path === 'string')
              .map((edit: any) => edit.path)
          : [],
        recentAutonomousEditFailures: deriveRecentAutonomousEditFailures(
          result.appliedEdits,
          result.autonomousEditNotes,
          runnerStatus.recentAutonomousEditFailures,
        ),
        recentAutonomousLearningNotes,
        noProgressStreak,
        noProgressReason,
        lastProgressSignature: progressSignature,
        effectiveScopes: Array.isArray((result as any).effectiveScopes)
          ? (result as any).effectiveScopes.map((scope: any) => String(scope || '').trim()).filter(Boolean)
          : runnerStatus.effectiveScopes,
        scopeExpansionReason: typeof (result as any).scopeExpansionReason === 'string'
          ? (result as any).scopeExpansionReason
          : runnerStatus.scopeExpansionReason,
        repairStatus: typeof (result as any).repairStatus === 'string'
          ? (result as any).repairStatus
          : runnerStatus.repairStatus,
        healthClass: typeof (result as any).healthClass === 'string'
          ? (result as any).healthClass
          : runnerStatus.healthClass,
        deferReason: typeof (result as any).deferReason === 'string'
          ? (result as any).deferReason
          : runnerStatus.deferReason,
        evidenceStatus: typeof (result as any).evidenceStatus === 'string'
          ? (result as any).evidenceStatus
          : runnerStatus.evidenceStatus,
        lastAiFailureClass: typeof (result as any).lastAiFailureClass === 'string'
          ? (result as any).lastAiFailureClass
          : runnerStatus.lastAiFailureClass,
        validationRequired: typeof (result as any).validationRequired === 'boolean'
          ? (result as any).validationRequired
          : runnerStatus.validationRequired,
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
        autonomousPlannerAgentCount: typeof (result as any).autonomousPlannerAgentCount === 'number'
          && Number.isFinite((result as any).autonomousPlannerAgentCount)
          ? Math.max(0, Math.floor((result as any).autonomousPlannerAgentCount))
          : runnerStatus.autonomousPlannerAgentCount,
        autonomousPlannerFocuses: Array.isArray((result as any).autonomousPlannerFocuses)
          ? (result as any).autonomousPlannerFocuses.map((entry: any) => String(entry || '').trim()).filter(Boolean)
          : runnerStatus.autonomousPlannerFocuses,
        autonomousPlannerStrategy: typeof (result as any).autonomousPlannerStrategy === 'string'
          ? (result as any).autonomousPlannerStrategy
          : runnerStatus.autonomousPlannerStrategy,
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
        productionRestartStatus: typeof (result as any).productionRestartStatus === 'string'
          ? (result as any).productionRestartStatus
          : runnerStatus.productionRestartStatus,
        productionRestartReason: typeof (result as any).productionRestartReason === 'string'
          ? (result as any).productionRestartReason
          : runnerStatus.productionRestartReason,
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
        latestCheckpointId: checkpointHistorySeed.latestCheckpointId,
        latestCheckpointCreatedAt: checkpointHistorySeed.latestCheckpointCreatedAt,
        checkpointCount: checkpointHistorySeed.checkpointCount,
        checkpointNextNodes: checkpointHistorySeed.checkpointNextNodes,
        replayCheckpointId: checkpointHistorySeed.replayCheckpointId,
        lastForkCheckpointId: parsedArgs.forkCheckpointId,
        subgraphStreamingEnabled: parsedArgs.subgraphs,
        observabilityTags: Array.isArray((result as any).observabilityTags)
          ? (result as any).observabilityTags
              .map((tag: any) => String(tag || '').trim())
              .filter(Boolean)
              .slice(0, 20)
          : [],
        summary: noProgressReason && typeof result.summary === 'string' && result.summary.trim()
          ? `${result.summary}\nNo-progress guard: ${noProgressReason}`
          : result.summary,
        lastRunCompletedAt: new Date().toISOString(),
      });
      await writeSemanticMemoryNotes(
        store,
        {
          langSmithProjectName: runnerStatus.langSmithProjectName || '',
          governanceProfile: runnerStatus.governanceProfile || '',
        },
        runnerStatus.recentAutonomousLearningNotes || [],
        {
          signalSignature: runnerStatus.repairIntentSummary,
          failureClass: runnerStatus.repairStatus,
          resolution: runnerStatus.repairDecisionReason,
          source: 'runner-status-memory',
        },
      ).catch(() => undefined);
      writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);

      if (terminalFailureSummary && !parsedArgs.continuous) {
        throw new Error(terminalFailureSummary);
      }

      if (!parsedArgs.continuous || sawInterrupt) {
        break;
      }

      if (parsedArgs.maxIterations !== null && iteration >= parsedArgs.maxIterations) {
        runnerStatus = mergeRunnerStatus(runnerStatus, {
          running: false,
          phase: 'completed',
        });
        writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);
        break;
      }

      const nextDelayMs = terminalFailureSummary
        ? getContinuousRetryDelayMs(consecutiveTerminalFailures)
        : getNoProgressDelayMs(parsedArgs.intervalMs, runnerStatus.noProgressStreak || 0);
      runnerStatus = mergeRunnerStatus(runnerStatus, {
        running: true,
        phase: terminalFailureSummary ? 'failed' : 'sleeping',
      });
      writeRunnerStatus(parsedArgs.statusFilePath, runnerStatus);
      if (terminalFailureSummary) {
        console.log(`\n[langgraph-control-plane] iteration ended with failure but continuous mode is enabled; sleeping ${nextDelayMs}ms before retry...`);
      } else if ((runnerStatus.noProgressStreak || 0) >= MAX_NO_PROGRESS_STREAK && runnerStatus.noProgressReason) {
        console.log(`\n[langgraph-control-plane] ${runnerStatus.noProgressReason} Sleeping ${nextDelayMs}ms before the next iteration...`);
      } else {
        console.log(`\n[langgraph-control-plane] sleeping ${nextDelayMs}ms before next iteration...`);
      }
      await sleep(nextDelayMs);
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
