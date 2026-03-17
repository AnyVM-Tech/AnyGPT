import { evaluate } from 'langsmith/evaluation';
import { Client as LangSmithClient } from 'langsmith/client';
import type { PromptCommit } from 'langsmith/schemas';

export type LangSmithRuntimeConfig = {
  apiKey: string;
  apiUrl: string;
  workspaceId?: string;
  projectName: string;
};

export type LangSmithWorkspaceSummary = {
  id: string;
  displayName: string;
  roleName?: string;
};

export type LangSmithProjectSummary = {
  id: string;
  name: string;
  description?: string;
  visibility?: string;
  metadata?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
};

export type LangSmithRunSummary = {
  id: string;
  name: string;
  status?: string;
  error?: string | null;
  runType?: string;
};

export type LangSmithDatasetSummary = {
  id: string;
  name: string;
  description?: string;
};

export type LangSmithDatasetExampleSeed = {
  inputs: Record<string, any>;
  outputs: Record<string, any>;
  metadata?: Record<string, any>;
};

export type LangSmithPromptSummary = {
  identifier: string;
  description?: string;
  updatedAt?: string;
};

export type LangSmithAnnotationQueueSummary = {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  itemCount?: number;
  feedbackCount?: number;
};

export type LangSmithAnnotationQueueItemSummary = {
  id: string;
  queueId?: string;
  queueName?: string;
  runId?: string;
  traceId?: string;
  exampleId?: string;
  runName?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  feedbackCount?: number;
};

export type LangSmithFeedbackSummary = {
  id: string;
  key: string;
  runId?: string;
  traceId?: string;
  exampleId?: string;
  score?: number | boolean | null;
  valueSummary?: string;
  correctionSummary?: string;
  comment?: string;
  feedbackSourceType?: string;
  createdAt?: string;
  modifiedAt?: string;
};

export type LangSmithFeedbackCreateInput = {
  key: string;
  runId?: string;
  traceId?: string;
  exampleId?: string;
  score?: number | boolean | null;
  value?: unknown;
  correction?: unknown;
  comment?: string;
  feedbackSourceType?: string;
};

export type LangSmithEvaluationMetricSummary = {
  key: string;
  count: number;
  averageScore?: number | null;
  minScore?: number | null;
  maxScore?: number | null;
  lastComment?: string;
};

export type LangSmithEvaluationSummary = {
  datasetName: string;
  experimentName: string;
  resultCount: number;
  averageScore?: number | null;
  metrics: LangSmithEvaluationMetricSummary[];
};

export type LangSmithFeedbackKeyCountSummary = {
  key: string;
  count: number;
};

export type LangSmithGovernanceFlag = {
  key: string;
  status: 'pass' | 'warn' | 'fail';
  summary: string;
};

export type LangSmithGovernanceMutation = {
  key: string;
  target: string;
  status: 'applied' | 'skipped' | 'failed';
  summary: string;
};

export type LangSmithGovernanceCounts = {
  workspaces: number;
  projects: number;
  runs: number;
  runFailures: number;
  runPending: number;
  datasets: number;
  prompts: number;
  annotationQueues: number;
  annotationQueueItems: number;
  annotationQueueBacklog: number;
  feedback: number;
  feedbackKeys: number;
};

export type LangSmithGovernanceSnapshot = {
  counts: LangSmithGovernanceCounts;
  feedbackKeyCounts: LangSmithFeedbackKeyCountSummary[];
  flags: LangSmithGovernanceFlag[];
  mutations: LangSmithGovernanceMutation[];
};

export type LangSmithClientSnapshot = {
  workspace?: LangSmithWorkspaceSummary;
  accessibleWorkspaces: LangSmithWorkspaceSummary[];
  currentProject: LangSmithProjectSummary | null;
  projectName: string;
  recentProjects: LangSmithProjectSummary[];
  recentRuns: LangSmithRunSummary[];
  datasets: LangSmithDatasetSummary[];
  prompts: LangSmithPromptSummary[];
  annotationQueues: LangSmithAnnotationQueueSummary[];
  annotationQueueItems: LangSmithAnnotationQueueItemSummary[];
  feedback: LangSmithFeedbackSummary[];
};

export type LangSmithClientCapabilities = {
  projects: boolean;
  datasets: boolean;
  prompts: boolean;
  annotationQueues: boolean;
  feedback: boolean;
  evaluations: boolean;
  tracing: boolean;
};

type LangSmithApiQueryValue = string | number | boolean | null | undefined;

type LangSmithApiRequestOptions = {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, LangSmithApiQueryValue | LangSmithApiQueryValue[]>;
  body?: unknown;
};

type LangSmithListFeedbackOptions = {
  runIds?: string[];
  traceIds?: string[];
  exampleIds?: string[];
  key?: string;
  limit?: number;
};

type LangSmithProjectGovernanceSyncOptions = {
  projectName?: string;
  description?: string;
  metadata?: Record<string, any>;
};

type LangSmithGovernanceSnapshotOptions = {
  snapshot?: LangSmithClientSnapshot | null;
  promptIdentifier?: string;
  expectedDatasetNames?: string[];
  requiredProjectMetadata?: Record<string, any>;
  queueBacklogWarnThreshold?: number;
  mutations?: LangSmithGovernanceMutation[];
};

function summarizeProject(project: any): LangSmithProjectSummary | null {
  const id = String(project?.id || '').trim();
  const name = String(project?.name || '').trim();
  const visibility = typeof project?.visibility === 'string' && project.visibility.trim()
    ? project.visibility.trim()
    : typeof project?.project_visibility === 'string' && project.project_visibility.trim()
      ? project.project_visibility.trim()
      : typeof project?.is_public === 'boolean'
        ? (project.is_public ? 'public' : 'private')
        : typeof project?.public === 'boolean'
          ? (project.public ? 'public' : 'private')
          : typeof project?.publicly_accessible === 'boolean'
            ? (project.publicly_accessible ? 'public' : 'private')
            : undefined;
  if (!id || !name) return null;
  return {
    id,
    name,
    description: typeof project?.description === 'string' ? project.description : undefined,
    visibility,
    metadata: extractProjectMetadata(project),
    createdAt: coerceOptionalString(project?.created_at || project?.createdAt),
    updatedAt: coerceOptionalString(project?.updated_at || project?.updatedAt),
  };
}

function summarizeRun(run: any): LangSmithRunSummary | null {
  const id = String(run?.id || '').trim();
  const name = String(run?.name || '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    status: typeof run?.status === 'string' ? run.status : undefined,
    error: typeof run?.error === 'string' ? run.error : null,
    runType: typeof run?.run_type === 'string' ? run.run_type : undefined,
  };
}

function summarizeDataset(dataset: any): LangSmithDatasetSummary | null {
  const id = String(dataset?.id || '').trim();
  const name = String(dataset?.name || '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    description: typeof dataset?.description === 'string' ? dataset.description : undefined,
  };
}

function summarizePrompt(prompt: any): LangSmithPromptSummary | null {
  const identifier = String(prompt?.identifier || prompt?.name || prompt?.full_name || '').trim();
  if (!identifier) return null;
  return {
    identifier,
    description: typeof prompt?.description === 'string' ? prompt.description : undefined,
    updatedAt: typeof prompt?.updated_at === 'string' ? prompt.updated_at : undefined,
  };
}

function coerceOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function coerceOptionalCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return undefined;
}

function coerceOptionalRecord(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => String(key || '').trim().length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

function extractProjectMetadata(project: any): Record<string, any> | undefined {
  const topLevelMetadata = coerceOptionalRecord(project?.metadata);
  const extraMetadata = coerceOptionalRecord(project?.extra?.metadata);

  if (topLevelMetadata && extraMetadata) {
    return {
      ...extraMetadata,
      ...topLevelMetadata,
    };
  }

  return topLevelMetadata || extraMetadata;
}

function normalizeStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStructuredValue(entry));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeStructuredValue(record[key])]),
    );
  }

  return value;
}

function structuredValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(normalizeStructuredValue(left)) === JSON.stringify(normalizeStructuredValue(right));
  } catch {
    return String(left) === String(right);
  }
}

function recordContainsValues(actual: Record<string, any> | undefined, expected: Record<string, any> | undefined): boolean {
  const normalizedExpected = expected || {};
  const expectedKeys = Object.keys(normalizedExpected);
  if (expectedKeys.length === 0) return true;
  if (!actual) return false;

  return expectedKeys.every((key) => structuredValuesEqual(actual[key], normalizedExpected[key]));
}

function isRunFailure(run: LangSmithRunSummary): boolean {
  const normalizedStatus = String(run.status || '').trim().toLowerCase();
  return Boolean(run.error && String(run.error).trim())
    || ['error', 'failed', 'failure'].some((token) => normalizedStatus.includes(token));
}

function isRunPending(run: LangSmithRunSummary): boolean {
  if (isRunFailure(run)) return false;
  const normalizedStatus = String(run.status || '').trim().toLowerCase();
  return ['queued', 'pending', 'running', 'started', 'in_progress', 'in-progress'].some((token) => normalizedStatus.includes(token));
}

function coerceFeedbackScore(value: unknown): number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function summarizeStructuredValue(value: unknown, maxLength = 180): string | undefined {
  if (typeof value === 'undefined' || value === null) return undefined;

  let serialized = '';
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }

  const trimmed = serialized.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function extractLangSmithCollection(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const candidateKeys = ['items', 'results', 'queues', 'runs', 'feedback', 'data', 'examples'];
  for (const key of candidateKeys) {
    if (Array.isArray((payload as any)?.[key])) {
      return (payload as any)[key];
    }
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

async function collectItemsFromUnknown(source: any, limit: number): Promise<any[]> {
  if (!source) return [];
  if (Array.isArray(source)) return source.slice(0, limit);

  const extracted = extractLangSmithCollection(source);
  if (extracted.length > 0) return extracted.slice(0, limit);

  if (typeof source?.[Symbol.asyncIterator] === 'function') {
    const items: any[] = [];
    for await (const item of source as AsyncIterable<any>) {
      items.push(item);
      if (items.length >= limit) break;
    }
    return items;
  }

  if (typeof source?.[Symbol.iterator] === 'function') {
    const items: any[] = [];
    for (const item of source as Iterable<any>) {
      items.push(item);
      if (items.length >= limit) break;
    }
    return items;
  }

  return [];
}

function dedupeById<T extends { id: string }>(items: Array<T | null>): T[] {
  const deduped = new Map<string, T>();
  for (const item of items) {
    if (!item?.id) continue;
    if (!deduped.has(item.id)) deduped.set(item.id, item);
  }
  return [...deduped.values()];
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const items = new Set<string>();
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) items.add(normalized);
  }
  return [...items.values()];
}

function summarizeAnnotationQueue(queue: any): LangSmithAnnotationQueueSummary | null {
  const id = String(queue?.id || queue?.queue_id || '').trim();
  const name = String(queue?.name || queue?.display_name || queue?.queue_name || '').trim();
  if (!id || !name) return null;

  return {
    id,
    name,
    description: coerceOptionalString(queue?.description),
    createdAt: coerceOptionalString(queue?.created_at || queue?.createdAt),
    updatedAt: coerceOptionalString(queue?.updated_at || queue?.updatedAt),
    itemCount: coerceOptionalCount(queue?.run_count ?? queue?.item_count ?? queue?.num_items ?? queue?.size),
    feedbackCount: coerceOptionalCount(queue?.feedback_count ?? queue?.review_count ?? queue?.num_reviews),
  };
}

function summarizeAnnotationQueueItem(item: any): LangSmithAnnotationQueueItemSummary | null {
  const run = item?.run && typeof item.run === 'object' ? item.run : null;
  const id = String(item?.id || item?.queue_run_id || run?.id || '').trim();
  if (!id) return null;

  return {
    id,
    queueId: coerceOptionalString(item?.queue_id || item?.queue?.id),
    queueName: coerceOptionalString(item?.queue_name || item?.queue?.name),
    runId: coerceOptionalString(item?.run_id || run?.id),
    traceId: coerceOptionalString(item?.trace_id || item?.trace?.id || run?.trace_id),
    exampleId: coerceOptionalString(item?.example_id || item?.example?.id),
    runName: coerceOptionalString(item?.run_name || run?.name || item?.name),
    status: coerceOptionalString(item?.status || item?.annotation_status || run?.status),
    createdAt: coerceOptionalString(item?.created_at || item?.createdAt || run?.start_time),
    updatedAt: coerceOptionalString(item?.updated_at || item?.updatedAt || run?.end_time),
    feedbackCount: coerceOptionalCount(item?.feedback_count ?? item?.num_feedback),
  };
}

function summarizeFeedback(feedback: any): LangSmithFeedbackSummary | null {
  const id = String(feedback?.id || '').trim();
  const key = String(feedback?.key || feedback?.feedback_key || '').trim();
  if (!id || !key) return null;

  return {
    id,
    key,
    runId: coerceOptionalString(feedback?.run_id || feedback?.run?.id),
    traceId: coerceOptionalString(feedback?.trace_id || feedback?.trace?.id),
    exampleId: coerceOptionalString(feedback?.example_id || feedback?.example?.id),
    score: coerceFeedbackScore(feedback?.score),
    valueSummary: summarizeStructuredValue(feedback?.value),
    correctionSummary: summarizeStructuredValue(feedback?.correction),
    comment: coerceOptionalString(feedback?.comment),
    feedbackSourceType: coerceOptionalString(feedback?.feedback_source_type || feedback?.feedback_source?.type),
    createdAt: coerceOptionalString(feedback?.created_at || feedback?.createdAt),
    modifiedAt: coerceOptionalString(feedback?.modified_at || feedback?.modifiedAt),
  };
}

function buildLangSmithApiUrl(
  config: LangSmithRuntimeConfig,
  requestPath: string,
  query?: Record<string, LangSmithApiQueryValue | LangSmithApiQueryValue[]>,
): string {
  const normalizedBase = config.apiUrl.replace(/\/+$/, '');
  const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  const url = new URL(`${normalizedBase}${normalizedPath}`);

  for (const [key, rawValue] of Object.entries(query || {})) {
    if (Array.isArray(rawValue)) {
      for (const entry of rawValue) {
        if (typeof entry === 'undefined' || entry === null) continue;
        url.searchParams.append(key, String(entry));
      }
      continue;
    }

    if (typeof rawValue === 'undefined' || rawValue === null) continue;
    url.searchParams.set(key, String(rawValue));
  }

  return url.toString();
}

async function requestLangSmithApi(
  config: LangSmithRuntimeConfig,
  options: LangSmithApiRequestOptions,
): Promise<any> {
  const response = await fetch(buildLangSmithApiUrl(config, options.path, options.query), {
    method: options.method || 'GET',
    headers: {
      'X-API-Key': config.apiKey,
      authorization: `Bearer ${config.apiKey}`,
      accept: 'application/json',
      ...(typeof options.body === 'undefined' ? {} : { 'content-type': 'application/json' }),
    },
    body: typeof options.body === 'undefined' ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    throw new Error(`LangSmith API ${options.method || 'GET'} ${options.path} failed with status ${response.status}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  if (!text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeApiUrl(value: string | undefined): string {
  const trimmed = String(value || '').trim();
  return trimmed || 'https://api.smith.langchain.com';
}

export function resolveLangSmithRuntimeConfig(): LangSmithRuntimeConfig | null {
  const apiKey = String(
    process.env.CONTROL_PLANE_LANGSMITH_PERSONAL_API_KEY
    || process.env.CONTROL_PLANE_LANGSMITH_SERVICE_KEY
    || process.env.CONTROL_PLANE_LANGSMITH_API_KEY
    || process.env.LANGSMITH_API_KEY
    || process.env.LANGCHAIN_API_KEY
    || '',
  ).trim();
  if (!apiKey) return null;

  const apiUrl = normalizeApiUrl(process.env.LANGSMITH_ENDPOINT || process.env.LANGCHAIN_ENDPOINT);
  const workspaceId = String(
    process.env.CONTROL_PLANE_LANGSMITH_WORKSPACE_ID
    || process.env.LANGSMITH_WORKSPACE_ID
    || process.env.LANGCHAIN_WORKSPACE_ID
    || '',
  ).trim() || undefined;
  const projectName = String(
    process.env.CONTROL_PLANE_LANGSMITH_PROJECT
    || process.env.LANGCHAIN_PROJECT
    || 'anygpt-control-plane',
  ).trim();

  return { apiKey, apiUrl, workspaceId, projectName };
}

export function createLangSmithClient(config?: LangSmithRuntimeConfig | null): LangSmithClient | null {
  const resolved = config || resolveLangSmithRuntimeConfig();
  if (!resolved) return null;

  return new LangSmithClient({
    apiKey: resolved.apiKey,
    apiUrl: resolved.apiUrl,
    workspaceId: resolved.workspaceId,
    timeout_ms: 30000,
  });
}

export function getLangSmithClientCapabilities(): LangSmithClientCapabilities {
  return {
    projects: true,
    datasets: true,
    prompts: true,
    annotationQueues: true,
    feedback: true,
    evaluations: true,
    tracing: true,
  };
}

export async function listLangSmithAnnotationQueues(
  config?: LangSmithRuntimeConfig | null,
  options?: { limit?: number },
): Promise<LangSmithAnnotationQueueSummary[]> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  if (!resolved) return [];

  const limit = Math.max(1, Math.min(25, options?.limit ?? 10));
  const anyClient = client as any;
  let queues: any[] = [];

  if (anyClient && typeof anyClient.listAnnotationQueues === 'function') {
    let sdkResponse: any = null;
    try {
      sdkResponse = anyClient.listAnnotationQueues({ limit });
    } catch {
      sdkResponse = null;
    }
    queues = await collectItemsFromUnknown(sdkResponse, limit);
  }

  if (queues.length === 0) {
    for (const requestPath of ['/api/v1/annotation-queues', '/annotation-queues']) {
      const payload = await requestLangSmithApi(resolved, {
        path: requestPath,
        query: { limit },
      }).catch(() => null);
      if (payload === null || typeof payload === 'undefined') continue;

      queues = extractLangSmithCollection(payload);
      if (Array.isArray(payload) || queues.length > 0) break;
    }
  }

  return dedupeById(queues.map((queue) => summarizeAnnotationQueue(queue))).slice(0, limit);
}

export async function readLangSmithAnnotationQueue(
  config: LangSmithRuntimeConfig | null | undefined,
  queueId: string,
): Promise<LangSmithAnnotationQueueSummary | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  const normalizedQueueId = String(queueId || '').trim();
  if (!resolved || !normalizedQueueId) return null;

  const anyClient = client as any;
  for (const methodName of ['readAnnotationQueue', 'getAnnotationQueue']) {
    if (typeof anyClient?.[methodName] !== 'function') continue;
    const payload = await anyClient[methodName](normalizedQueueId).catch(() => null);
    const summary = summarizeAnnotationQueue(payload);
    if (summary) return summary;
  }

  for (const requestPath of [`/api/v1/annotation-queues/${encodeURIComponent(normalizedQueueId)}`, `/annotation-queues/${encodeURIComponent(normalizedQueueId)}`]) {
    const payload = await requestLangSmithApi(resolved, { path: requestPath }).catch(() => null);
    const summary = summarizeAnnotationQueue(payload);
    if (summary) return summary;
  }

  return null;
}

export async function listLangSmithAnnotationQueueItems(
  config: LangSmithRuntimeConfig | null | undefined,
  queueId: string,
  options?: { limit?: number },
): Promise<LangSmithAnnotationQueueItemSummary[]> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  const normalizedQueueId = String(queueId || '').trim();
  if (!resolved || !normalizedQueueId) return [];

  const limit = Math.max(1, Math.min(25, options?.limit ?? 5));
  const anyClient = client as any;
  let items: any[] = [];

  for (const methodName of ['listAnnotationQueueItems', 'listAnnotationQueueRuns', 'listRunsFromAnnotationQueue']) {
    if (typeof anyClient?.[methodName] !== 'function') continue;

    let payload: any = null;
    try {
      payload = anyClient[methodName](normalizedQueueId, { limit });
    } catch {
      payload = null;
    }
    items = await collectItemsFromUnknown(payload, limit);
    if (items.length > 0) break;
  }

  if (items.length === 0) {
    const requestPaths = [
      `/api/v1/annotation-queues/${encodeURIComponent(normalizedQueueId)}/runs`,
      `/api/v1/annotation-queues/${encodeURIComponent(normalizedQueueId)}/items`,
      `/annotation-queues/${encodeURIComponent(normalizedQueueId)}/runs`,
    ];
    for (const requestPath of requestPaths) {
      const payload = await requestLangSmithApi(resolved, {
        path: requestPath,
        query: { limit },
      }).catch(() => null);
      if (payload === null || typeof payload === 'undefined') continue;

      items = extractLangSmithCollection(payload);
      if (Array.isArray(payload) || items.length > 0) break;
    }
  }

  return dedupeById(items.map((item) => summarizeAnnotationQueueItem(item))).slice(0, limit);
}

export async function listLangSmithFeedback(
  config?: LangSmithRuntimeConfig | null,
  options?: LangSmithListFeedbackOptions,
): Promise<LangSmithFeedbackSummary[]> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  if (!resolved) return [];

  const limit = Math.max(1, Math.min(25, options?.limit ?? 10));
  const runIds = uniqueStrings(options?.runIds || []);
  const traceIds = uniqueStrings(options?.traceIds || []);
  const exampleIds = uniqueStrings(options?.exampleIds || []);
  const key = String(options?.key || '').trim() || undefined;
  const anyClient = client as any;
  let items: any[] = [];

  if (anyClient && typeof anyClient.listFeedback === 'function' && traceIds.length === 0 && exampleIds.length === 0) {
    let sdkPayload: any = null;
    try {
      sdkPayload = anyClient.listFeedback({
        ...(runIds.length > 0 ? { runIds } : {}),
        ...(key ? { feedbackKeys: [key] } : {}),
      });
    } catch {
      sdkPayload = null;
    }
    items = await collectItemsFromUnknown(sdkPayload, limit);
  }

  if (items.length === 0) {
    const query = {
      limit,
      ...(key ? { key } : {}),
      ...(runIds.length > 0 ? { run_id: runIds, run: runIds } : {}),
      ...(traceIds.length > 0 ? { trace_id: traceIds, trace: traceIds } : {}),
      ...(exampleIds.length > 0 ? { example_id: exampleIds, example: exampleIds } : {}),
    };

    for (const requestPath of ['/feedback', '/api/v1/feedback']) {
      const payload = await requestLangSmithApi(resolved, {
        path: requestPath,
        query,
      }).catch(() => null);
      if (payload === null || typeof payload === 'undefined') continue;

      items = extractLangSmithCollection(payload);
      if (Array.isArray(payload) || items.length > 0) break;
    }
  }

  return dedupeById(items.map((item) => summarizeFeedback(item))).slice(0, limit);
}

export async function createLangSmithFeedback(
  config: LangSmithRuntimeConfig | null | undefined,
  input: LangSmithFeedbackCreateInput,
): Promise<LangSmithFeedbackSummary | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  const normalizedKey = String(input.key || '').trim();
  const runId = String(input.runId || '').trim() || undefined;
  const traceId = String(input.traceId || '').trim() || undefined;
  const exampleId = String(input.exampleId || '').trim() || undefined;
  if (!resolved || !normalizedKey || (!runId && !traceId && !exampleId)) return null;

  const anyClient = client as any;
  if (runId && anyClient && typeof anyClient.createFeedback === 'function') {
    const created = await anyClient.createFeedback(runId, normalizedKey, {
      ...(typeof input.score === 'undefined' ? {} : { score: input.score }),
      ...(typeof input.value === 'undefined' ? {} : { value: input.value }),
      ...(typeof input.correction === 'undefined' ? {} : { correction: input.correction }),
      ...(typeof input.comment === 'string' && input.comment.trim() ? { comment: input.comment.trim() } : {}),
      ...(typeof input.feedbackSourceType === 'string' && input.feedbackSourceType.trim()
        ? { feedbackSourceType: input.feedbackSourceType.trim() }
        : {}),
    }).catch(() => null);
    const summary = summarizeFeedback(created);
    if (summary) return summary;
  }

  for (const requestPath of ['/feedback', '/api/v1/feedback']) {
    const payload = await requestLangSmithApi(resolved, {
      method: 'POST',
      path: requestPath,
      body: {
        key: normalizedKey,
        ...(runId ? { run_id: runId } : {}),
        ...(traceId ? { trace_id: traceId } : {}),
        ...(exampleId ? { example_id: exampleId } : {}),
        ...(typeof input.score === 'undefined' ? {} : { score: input.score }),
        ...(typeof input.value === 'undefined' ? {} : { value: input.value }),
        ...(typeof input.correction === 'undefined' ? {} : { correction: input.correction }),
        ...(typeof input.comment === 'string' && input.comment.trim() ? { comment: input.comment.trim() } : {}),
        ...(typeof input.feedbackSourceType === 'string' && input.feedbackSourceType.trim()
          ? { feedback_source_type: input.feedbackSourceType.trim() }
          : {}),
      },
    }).catch(() => null);
    const summary = summarizeFeedback(payload?.feedback || payload);
    if (summary) return summary;
  }

  return null;
}

export function summarizeLangSmithQueueFeedbackSnapshot(snapshot: Pick<LangSmithClientSnapshot, 'annotationQueues' | 'annotationQueueItems' | 'feedback'>): string[] {
  const notes: string[] = [];

  if (snapshot.annotationQueues.length > 0) {
    const queuePreview = snapshot.annotationQueues
      .slice(0, 3)
      .map((queue) => `${queue.name}${typeof queue.itemCount === 'number' ? ` (${queue.itemCount} item(s))` : ''}`)
      .join(', ');
    notes.push(`LangSmith annotation queues: ${snapshot.annotationQueues.length} queue(s)${queuePreview ? ` sampled as ${queuePreview}` : ''}.`);
  }

  if (snapshot.annotationQueueItems.length > 0) {
    const itemPreview = snapshot.annotationQueueItems
      .slice(0, 3)
      .map((item) => item.runName || item.runId || item.id)
      .filter(Boolean)
      .join(', ');
    notes.push(`LangSmith queue items sampled: ${snapshot.annotationQueueItems.length} item(s)${itemPreview ? ` including ${itemPreview}` : ''}.`);
  }

  if (snapshot.feedback.length > 0) {
    const feedbackByKey = new Map<string, number>();
    for (const item of snapshot.feedback) {
      feedbackByKey.set(item.key, (feedbackByKey.get(item.key) || 0) + 1);
    }
    const keyPreview = [...feedbackByKey.entries()]
      .slice(0, 4)
      .map(([key, count]) => `${key} x${count}`)
      .join(', ');
    notes.push(`LangSmith feedback sampled: ${snapshot.feedback.length} item(s)${keyPreview ? ` across ${keyPreview}` : ''}.`);
  }

  return notes;
}

export function summarizeLangSmithGovernanceSnapshot(snapshot: LangSmithGovernanceSnapshot): string[] {
  const notes: string[] = [];
  const actionableFlags = snapshot.flags.filter((flag) => flag.status !== 'pass');
  notes.push(
    `LangSmith governance sampled ${snapshot.counts.workspaces} workspace(s), ${snapshot.counts.projects} project(s), ${snapshot.counts.runFailures} recent failed run(s), ${snapshot.counts.annotationQueueBacklog} queued review item(s), and ${actionableFlags.length} flag(s) needing attention.`,
  );

  for (const flag of actionableFlags.slice(0, 5)) {
    notes.push(`LangSmith governance ${flag.status}: ${flag.summary}`);
  }

  for (const mutation of snapshot.mutations.slice(0, 3)) {
    notes.push(`LangSmith governance mutation ${mutation.status}: ${mutation.summary}`);
  }

  return notes;
}

export async function readLangSmithProject(
  config?: LangSmithRuntimeConfig | null,
  projectName?: string,
): Promise<LangSmithProjectSummary | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  const normalizedProjectName = String(projectName || resolved?.projectName || '').trim();
  if (!client || !resolved || !normalizedProjectName) return null;

  const project = await client.readProject({ projectName: normalizedProjectName }).catch(() => null);
  return summarizeProject(project);
}

export async function ensureLangSmithProject(
  config?: LangSmithRuntimeConfig | null,
  options?: { description?: string; metadata?: Record<string, any>; syncMetadata?: boolean },
): Promise<LangSmithProjectSummary | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  if (!client || !resolved) return null;

  const existing = await client.readProject({ projectName: resolved.projectName }).catch(() => null);
  const existingSummary = summarizeProject(existing);
  const targetDescription = String(options?.description || '').trim();
  const targetMetadata = coerceOptionalRecord(options?.metadata) || { source: 'anygpt-langgraph-control-plane' };
  const desiredDescription = targetDescription || existingSummary?.description || 'AnyGPT LangGraph control plane runtime project';
  const desiredMetadata = {
    ...(existingSummary?.metadata || {}),
    ...targetMetadata,
  };

  if (existingSummary && options?.syncMetadata !== true) {
    return existingSummary;
  }

  if (existingSummary && options?.syncMetadata === true) {
    const descriptionMatches = !targetDescription || existingSummary.description === targetDescription;
    const metadataMatches = recordContainsValues(existingSummary.metadata, targetMetadata);
    if (descriptionMatches && metadataMatches) {
      return existingSummary;
    }

    const updated = await client.updateProject(existingSummary.id, {
      description: desiredDescription,
      metadata: desiredMetadata,
    }).catch(() => null);

    const refreshed = summarizeProject(updated)
      || await readLangSmithProject({ ...resolved, projectName: resolved.projectName }, resolved.projectName).catch(() => null);

    return refreshed || existingSummary;
  }

  const created = await client.createProject({
    projectName: resolved.projectName,
    description: desiredDescription,
    metadata: desiredMetadata,
    upsert: true,
  } as any).catch(() => null);
  return summarizeProject(created || existing);
}

export async function syncLangSmithProjectGovernance(
  config?: LangSmithRuntimeConfig | null,
  options?: LangSmithProjectGovernanceSyncOptions,
): Promise<LangSmithGovernanceMutation | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  if (!resolved) return null;

  const normalizedProjectName = String(options?.projectName || resolved.projectName || '').trim();
  if (!normalizedProjectName) return null;

  const targetDescription = String(options?.description || '').trim();
  const targetMetadata = coerceOptionalRecord(options?.metadata) || { source: 'anygpt-langgraph-control-plane' };

  try {
    const existing = await readLangSmithProject({ ...resolved, projectName: normalizedProjectName }, normalizedProjectName);
    const descriptionMatches = !targetDescription || existing?.description === targetDescription;
    const metadataMatches = recordContainsValues(existing?.metadata, targetMetadata);
    if (existing && descriptionMatches && metadataMatches) {
      return {
        key: 'project-governance-sync',
        target: normalizedProjectName,
        status: 'skipped',
        summary: `Project ${normalizedProjectName} already matched the bounded governance description and metadata.`,
      };
    }

    const synced = await ensureLangSmithProject(
      { ...resolved, projectName: normalizedProjectName },
      {
        description: targetDescription || existing?.description || 'AnyGPT LangGraph control plane runtime project',
        metadata: {
          ...(existing?.metadata || {}),
          ...targetMetadata,
        },
        syncMetadata: true,
      },
    );

    const synchronized = Boolean(synced)
      && (!targetDescription || synced?.description === (targetDescription || synced?.description))
      && recordContainsValues(synced?.metadata, targetMetadata);

    return synchronized
      ? {
          key: 'project-governance-sync',
          target: normalizedProjectName,
          status: 'applied',
          summary: existing
            ? `Project ${normalizedProjectName} governance description and metadata were reconciled.`
            : `Project ${normalizedProjectName} was created with bounded governance description and metadata.`,
        }
      : {
          key: 'project-governance-sync',
          target: normalizedProjectName,
          status: 'failed',
          summary: `Project ${normalizedProjectName} governance metadata sync did not converge on the expected bounded markers.`,
        };
  } catch (error) {
    return {
      key: 'project-governance-sync',
      target: normalizedProjectName,
      status: 'failed',
      summary: `Project ${normalizedProjectName} governance metadata sync failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function createControlPlaneRunDatasetFromProject(
  config?: LangSmithRuntimeConfig | null,
  datasetName?: string,
  options?: { description?: string; limit?: number; projectName?: string },
): Promise<LangSmithDatasetSummary | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  const normalizedDatasetName = String(datasetName || '').trim();
  if (!client || !resolved || !normalizedDatasetName) return null;

  const existing = await client.readDataset({ datasetName: normalizedDatasetName }).catch(() => null);
  if (existing) {
    return summarizeDataset(existing);
  }

  const created = await client.createDataset(normalizedDatasetName, {
    description: options?.description || `Control-plane dataset seeded from project ${options?.projectName || resolved.projectName}`,
    metadata: {
      source_project: options?.projectName || resolved.projectName,
      source: 'anygpt-langgraph-control-plane',
    },
  });

  const runLimit = Math.max(1, Math.min(50, options?.limit ?? 10));
  const projectName = options?.projectName || resolved.projectName;
  const runs: any[] = [];
  for await (const run of client.listRuns({ projectName, executionOrder: 1, error: false, limit: runLimit } as any)) {
    runs.push(run);
    if (runs.length >= runLimit) break;
  }

  for (const run of runs) {
    const inputs = run && typeof run.inputs === 'object' && run.inputs ? run.inputs : {};
    const outputs = run && typeof run.outputs === 'object' && run.outputs ? run.outputs : {};
    await client.createExample(inputs, outputs, {
      datasetId: (created as any).id,
      metadata: {
        source_run_id: String(run?.id || ''),
        source_run_name: String(run?.name || ''),
      },
    }).catch(() => undefined);
  }

  return summarizeDataset(created);
}

export async function ensureLangSmithExamplesDataset(
  config: LangSmithRuntimeConfig | null | undefined,
  datasetName: string,
  examples: LangSmithDatasetExampleSeed[],
  options?: { description?: string },
): Promise<LangSmithDatasetSummary | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  const normalizedDatasetName = String(datasetName || '').trim();
  if (!client || !resolved || !normalizedDatasetName) return null;

  let dataset = await client.readDataset({ datasetName: normalizedDatasetName }).catch(() => null);
  if (!dataset) {
    dataset = await client.createDataset(normalizedDatasetName, {
      description: options?.description || `Seed dataset for ${resolved.projectName}`,
      metadata: { source: 'anygpt-langgraph-control-plane' },
    }).catch(() => null);
  }
  if (!dataset) return null;

  const datasetId = String((dataset as any)?.id || '').trim();
  if (!datasetId) return summarizeDataset(dataset);

  const existingExamples: any[] = [];
  for await (const example of client.listExamples({ datasetId, limit: 50 } as any)) {
    existingExamples.push(example);
    if (existingExamples.length >= 50) break;
  }

  if (existingExamples.length === 0) {
    for (const example of examples) {
      await client.createExample(example.inputs, example.outputs, {
        datasetId,
        metadata: example.metadata,
      }).catch(() => undefined);
    }
  }

  return summarizeDataset(dataset);
}

export async function pullLangSmithPromptCommit(
  config: LangSmithRuntimeConfig | null | undefined,
  promptIdentifier: string,
): Promise<PromptCommit | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  const normalizedPromptIdentifier = String(promptIdentifier || '').trim();
  if (!client || !resolved || !normalizedPromptIdentifier) return null;

  return await client.pullPromptCommit(normalizedPromptIdentifier, {
    includeModel: true,
    skipCache: false,
  }).catch(() => null);
}

export async function ensureLangSmithPrompt(
  config: LangSmithRuntimeConfig | null | undefined,
  promptIdentifier: string,
  promptObject: unknown,
  options?: { description?: string; tags?: string[]; readme?: string; parentCommitHash?: string },
): Promise<string | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  const normalizedPromptIdentifier = String(promptIdentifier || '').trim();
  if (!client || !resolved || !normalizedPromptIdentifier) return null;

  const normalizedTags = Array.from(new Set(
    (options?.tags || [])
      .map((tag) => String(tag || '').trim())
      .filter(Boolean),
  ));

  const existingPrompt = await client.getPrompt(normalizedPromptIdentifier).catch(() => null);
  if (!existingPrompt) {
    await client.createPrompt(normalizedPromptIdentifier, {
      description: options?.description,
      tags: normalizedTags,
      readme: options?.readme,
      isPublic: false,
    }).catch(() => undefined);
  }

  return await client.pushPrompt(normalizedPromptIdentifier, {
    object: promptObject,
    description: options?.description,
    tags: normalizedTags,
    readme: options?.readme,
    isPublic: false,
    ...(options?.parentCommitHash
      ? {
          parentCommitHash: options.parentCommitHash,
          parent_commit_hash: options.parentCommitHash,
        }
      : {}),
  }).catch(() => null);
}

export async function runLangSmithDatasetEvaluation(
  config: LangSmithRuntimeConfig | null | undefined,
  datasetName: string,
  target: (inputs: Record<string, any>) => Promise<Record<string, any>>,
  experimentPrefix: string,
  evaluators: Array<(run: any, example: any) => Record<string, any>>,
): Promise<LangSmithEvaluationSummary | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  if (!resolved || !datasetName.trim()) return null;

  const collectedMetrics = new Map<string, { scores: number[]; comments: string[] }>();
  const wrappedEvaluators = evaluators.map((evaluator) => async (run: any, example: any) => {
    const evaluationResult = await Promise.resolve(evaluator(run, example));
    const entries = Array.isArray(evaluationResult) ? evaluationResult : [evaluationResult];

    for (const entry of entries) {
      const key = String(entry?.key || '').trim();
      if (!key) continue;

      const metric = collectedMetrics.get(key) || { scores: [], comments: [] };
      const rawScore = entry?.score;
      let normalizedScore: number | null = null;

      if (typeof rawScore === 'boolean') {
        normalizedScore = rawScore ? 1 : 0;
      } else if (typeof rawScore === 'number' && Number.isFinite(rawScore)) {
        normalizedScore = rawScore;
      } else if (typeof rawScore === 'string' && rawScore.trim()) {
        const normalized = rawScore.trim().toLowerCase();
        if (normalized === 'true') {
          normalizedScore = 1;
        } else if (normalized === 'false') {
          normalizedScore = 0;
        } else {
          const parsed = Number(rawScore);
          if (Number.isFinite(parsed)) {
            normalizedScore = parsed;
          }
        }
      }

      if (normalizedScore !== null) {
        metric.scores.push(normalizedScore);
      }
      if (typeof entry?.comment === 'string' && entry.comment.trim()) {
        metric.comments.push(entry.comment.trim());
      }

      collectedMetrics.set(key, metric);
    }

    return evaluationResult;
  });

  const results = await evaluate(target as any, {
    data: datasetName,
    evaluators: wrappedEvaluators,
    experimentPrefix,
    metadata: {
      workspace_id: resolved.workspaceId,
      project_name: resolved.projectName,
      source: 'anygpt-langgraph-control-plane',
    },
  } as any).catch(() => null);
  if (!results) return null;

  let resultCount = 0;
  if (Array.isArray((results as any).results)) {
    resultCount = (results as any).results.length;
  } else if (typeof (results as any)?.[Symbol.asyncIterator] === 'function') {
    for await (const _row of results as any) {
      resultCount += 1;
    }
  } else if (typeof (results as any)?.[Symbol.iterator] === 'function') {
    for (const _row of results as any) {
      resultCount += 1;
    }
  }

  const metrics = [...collectedMetrics.entries()].map(([key, metric]) => {
    const count = metric.scores.length;
    const total = metric.scores.reduce((sum, score) => sum + score, 0);
    return {
      key,
      count,
      averageScore: count > 0 ? Math.round((total / count) * 1000) / 1000 : null,
      minScore: count > 0 ? Math.min(...metric.scores) : null,
      maxScore: count > 0 ? Math.max(...metric.scores) : null,
      lastComment: metric.comments.length > 0 ? metric.comments[metric.comments.length - 1] : undefined,
    } satisfies LangSmithEvaluationMetricSummary;
  });
  const allScores = metrics.flatMap((metric) => collectedMetrics.get(metric.key)?.scores || []);
  const averageScore = allScores.length > 0
    ? Math.round((allScores.reduce((sum, score) => sum + score, 0) / allScores.length) * 1000) / 1000
    : null;

  return {
    datasetName,
    experimentName: String((results as any).experimentName || (results as any).experiment_name || experimentPrefix || '').trim(),
    resultCount,
    averageScore,
    metrics,
  };
}

export async function listLangSmithWorkspaces(config?: LangSmithRuntimeConfig | null): Promise<LangSmithWorkspaceSummary[]> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  if (!resolved) return [];

  const response = await fetch(`${resolved.apiUrl.replace(/\/+$/, '')}/workspaces`, {
    method: 'GET',
    headers: {
      'X-API-Key': resolved.apiKey,
      accept: 'application/json',
    },
  });
  if (!response.ok) return [];

  const payload = await response.json();
  const workspaces = Array.isArray(payload) ? payload : [];
  return workspaces.map((workspace: any) => ({
    id: String(workspace?.id || ''),
    displayName: String(workspace?.display_name || ''),
    roleName: typeof workspace?.role_name === 'string' ? workspace.role_name : undefined,
  })).filter((workspace) => workspace.id && workspace.displayName);
}

export async function collectLangSmithGovernanceSnapshot(
  config?: LangSmithRuntimeConfig | null,
  options?: LangSmithGovernanceSnapshotOptions,
): Promise<LangSmithGovernanceSnapshot | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  if (!resolved) return null;

  const snapshot = options?.snapshot || await collectLangSmithClientSnapshot(resolved).catch(() => null);
  if (!snapshot) return null;

  const accessibleWorkspaces = snapshot.accessibleWorkspaces.length > 0
    ? snapshot.accessibleWorkspaces
    : await listLangSmithWorkspaces(resolved).catch(() => []);
  const selectedWorkspace = snapshot.workspace
    || (resolved.workspaceId
      ? accessibleWorkspaces.find((workspace) => workspace.id === resolved.workspaceId)
      : accessibleWorkspaces[0]);
  const currentProject = snapshot.currentProject
    || await readLangSmithProject(resolved, snapshot.projectName || resolved.projectName).catch(() => null);

  const feedbackKeyCountsMap = new Map<string, number>();
  for (const item of snapshot.feedback) {
    const key = String(item.key || '').trim();
    if (!key) continue;
    feedbackKeyCountsMap.set(key, (feedbackKeyCountsMap.get(key) || 0) + 1);
  }
  const feedbackKeyCounts = [...feedbackKeyCountsMap.entries()]
    .map(([key, count]) => ({ key, count } satisfies LangSmithFeedbackKeyCountSummary))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, 10);

  const runFailures = snapshot.recentRuns.filter((run) => isRunFailure(run)).length;
  const runPending = snapshot.recentRuns.filter((run) => isRunPending(run)).length;
  const explicitQueueBacklog = snapshot.annotationQueues.reduce((total, queue) => total + (typeof queue.itemCount === 'number' ? queue.itemCount : 0), 0);
  const annotationQueueBacklog = explicitQueueBacklog > 0 ? explicitQueueBacklog : snapshot.annotationQueueItems.length;
  const counts: LangSmithGovernanceCounts = {
    workspaces: accessibleWorkspaces.length,
    projects: snapshot.recentProjects.length,
    runs: snapshot.recentRuns.length,
    runFailures,
    runPending,
    datasets: snapshot.datasets.length,
    prompts: snapshot.prompts.length,
    annotationQueues: snapshot.annotationQueues.length,
    annotationQueueItems: snapshot.annotationQueueItems.length,
    annotationQueueBacklog,
    feedback: snapshot.feedback.length,
    feedbackKeys: feedbackKeyCounts.length,
  };

  const queueBacklogWarnThreshold = Math.max(1, Math.min(100, Math.floor(options?.queueBacklogWarnThreshold ?? 10)));
  const requiredProjectMetadata = coerceOptionalRecord(options?.requiredProjectMetadata);
  const expectedDatasetNames = uniqueStrings(options?.expectedDatasetNames || []);
  const promptIdentifier = String(options?.promptIdentifier || '').trim();
  const mutations = (options?.mutations || []).slice(0, 10);
  const flags: LangSmithGovernanceFlag[] = [];

  if (!selectedWorkspace) {
    flags.push({
      key: 'workspace-selection',
      status: 'warn',
      summary: 'No LangSmith workspace could be resolved for the current runtime.',
    });
  } else if (resolved.workspaceId) {
    flags.push({
      key: 'workspace-selection',
      status: 'pass',
      summary: `Workspace ${selectedWorkspace.displayName} is pinned by workspace ID ${resolved.workspaceId}.`,
    });
  } else if (accessibleWorkspaces.length > 1) {
    flags.push({
      key: 'workspace-selection',
      status: 'warn',
      summary: `Workspace ${selectedWorkspace.displayName} was selected without an explicit workspace ID across ${accessibleWorkspaces.length} accessible workspaces.`,
    });
  } else {
    flags.push({
      key: 'workspace-selection',
      status: 'pass',
      summary: `Workspace ${selectedWorkspace.displayName} is the only sampled accessible workspace.`,
    });
  }

  const normalizedRoleName = String(selectedWorkspace?.roleName || '').trim().toLowerCase();
  if (!selectedWorkspace?.roleName) {
    flags.push({
      key: 'workspace-role',
      status: 'warn',
      summary: 'Workspace role could not be determined from the LangSmith workspace listing.',
    });
  } else if (normalizedRoleName.includes('viewer') || normalizedRoleName.includes('read')) {
    flags.push({
      key: 'workspace-role',
      status: 'warn',
      summary: `Workspace role ${selectedWorkspace.roleName} may not support future governance mutations beyond read-only inspection.`,
    });
  } else {
    flags.push({
      key: 'workspace-role',
      status: 'pass',
      summary: `Workspace role ${selectedWorkspace.roleName} supports bounded control-plane governance operations.`,
    });
  }

  if (!currentProject) {
    flags.push({
      key: 'project-access',
      status: 'fail',
      summary: `Project ${snapshot.projectName || resolved.projectName} could not be read after governance introspection.`,
    });
  } else {
    flags.push({
      key: 'project-access',
      status: 'pass',
      summary: `Project ${currentProject.name} is readable for bounded governance introspection.`,
    });
  }

  if (requiredProjectMetadata && Object.keys(requiredProjectMetadata).length > 0) {
    const missingMetadataKeys = Object.entries(requiredProjectMetadata)
      .filter(([key, value]) => !structuredValuesEqual(currentProject?.metadata?.[key], value))
      .map(([key]) => key);
    if (!currentProject) {
      flags.push({
        key: 'project-metadata-alignment',
        status: 'fail',
        summary: 'Project governance metadata could not be verified because the current project was unavailable.',
      });
    } else if (missingMetadataKeys.length > 0) {
      flags.push({
        key: 'project-metadata-alignment',
        status: 'warn',
        summary: `Project ${currentProject.name} is missing bounded governance metadata keys: ${missingMetadataKeys.join(', ')}.`,
      });
    } else {
      flags.push({
        key: 'project-metadata-alignment',
        status: 'pass',
        summary: `Project ${currentProject.name} carries the expected bounded governance metadata markers.`,
      });
    }
  }

  if (expectedDatasetNames.length > 0) {
    const availableDatasetNames = new Set(snapshot.datasets.map((dataset) => dataset.name));
    const missingDatasets = expectedDatasetNames.filter((name) => !availableDatasetNames.has(name));
    if (missingDatasets.length > 0) {
      flags.push({
        key: 'control-plane-datasets',
        status: 'warn',
        summary: `Expected control-plane datasets were not visible in the sampled workspace view: ${missingDatasets.join(', ')}.`,
      });
    } else {
      flags.push({
        key: 'control-plane-datasets',
        status: 'pass',
        summary: `Expected control-plane datasets are present: ${expectedDatasetNames.join(', ')}.`,
      });
    }
  }

  if (promptIdentifier) {
    const promptPresent = snapshot.prompts.some((prompt) => prompt.identifier === promptIdentifier || prompt.identifier.startsWith(`${promptIdentifier}:`));
    flags.push({
      key: 'control-plane-prompt',
      status: promptPresent ? 'pass' : 'warn',
      summary: promptPresent
        ? `Prompt identifier ${promptIdentifier} is visible to the control plane.`
        : `Prompt identifier ${promptIdentifier} was not visible in the sampled LangSmith prompt list.`,
    });
  }

  if (snapshot.recentRuns.length === 0) {
    flags.push({
      key: 'recent-run-health',
      status: 'warn',
      summary: 'No recent LangSmith runs were available for governance health inspection.',
    });
  } else if (runFailures > 0) {
    flags.push({
      key: 'recent-run-health',
      status: 'warn',
      summary: `${runFailures} sampled LangSmith run(s) were failed or errored.`,
    });
  } else {
    flags.push({
      key: 'recent-run-health',
      status: 'pass',
      summary: `Sampled LangSmith runs show no failures across ${snapshot.recentRuns.length} recent run(s).`,
    });
  }

  flags.push({
    key: 'annotation-review-backlog',
    status: annotationQueueBacklog > queueBacklogWarnThreshold ? 'warn' : 'pass',
    summary: annotationQueueBacklog > queueBacklogWarnThreshold
      ? `Sampled annotation queues report ${annotationQueueBacklog} queued review item(s), above the warning threshold of ${queueBacklogWarnThreshold}.`
      : `Sampled annotation queues report ${annotationQueueBacklog} queued review item(s), within the bounded warning threshold of ${queueBacklogWarnThreshold}.`,
  });

  flags.push({
    key: 'feedback-signal',
    status: snapshot.feedback.length > 0 ? 'pass' : 'warn',
    summary: snapshot.feedback.length > 0
      ? `Sampled feedback includes ${snapshot.feedback.length} item(s) across ${feedbackKeyCounts.length} feedback key(s).`
      : 'No sampled feedback items were available for governance signal inspection.',
  });

  if (mutations.some((mutation) => mutation.status === 'failed')) {
    flags.push({
      key: 'governance-mutations',
      status: 'fail',
      summary: `One or more bounded governance mutations failed: ${mutations.filter((mutation) => mutation.status === 'failed').map((mutation) => mutation.key).join(', ')}.`,
    });
  } else if (mutations.length > 0) {
    flags.push({
      key: 'governance-mutations',
      status: 'pass',
      summary: `Bounded governance mutation hooks completed with statuses: ${mutations.map((mutation) => `${mutation.key}=${mutation.status}`).join(', ')}.`,
    });
  }

  return {
    counts,
    feedbackKeyCounts,
    flags,
    mutations,
  };
}

export async function collectLangSmithClientSnapshot(config?: LangSmithRuntimeConfig | null): Promise<LangSmithClientSnapshot | null> {
  const resolved = config || resolveLangSmithRuntimeConfig();
  const client = createLangSmithClient(resolved);
  if (!client || !resolved) return null;

  const [workspaces, currentProject, recentProjects, recentRuns, datasets, prompts, annotationQueues] = await Promise.all([
    listLangSmithWorkspaces(resolved).catch(() => []),
    readLangSmithProject(resolved, resolved.projectName).catch(() => null),
    (async () => {
      const projects: LangSmithProjectSummary[] = [];
      for await (const project of client.listProjects({ limit: 10 } as any)) {
        const summary = summarizeProject(project);
        if (summary) projects.push(summary);
        if (projects.length >= 10) break;
      }
      return projects;
    })().catch(() => []),
    (async () => {
      const runs: LangSmithRunSummary[] = [];
      for await (const run of client.listRuns({ projectName: resolved.projectName, limit: 10 } as any)) {
        const summary = summarizeRun(run);
        if (summary) runs.push(summary);
        if (runs.length >= 10) break;
      }
      return runs;
    })().catch(() => []),
    (async () => {
      const items: LangSmithDatasetSummary[] = [];
      for await (const dataset of client.listDatasets({ limit: 10 } as any)) {
        const summary = summarizeDataset(dataset);
        if (summary) items.push(summary);
        if (items.length >= 10) break;
      }
      return items;
    })().catch(() => []),
    (async () => {
      const promptItems: LangSmithPromptSummary[] = [];
      for await (const prompt of client.listPrompts()) {
        const summary = summarizePrompt(prompt);
        if (summary) promptItems.push(summary);
        if (promptItems.length >= 10) break;
      }
      return promptItems;
    })().catch(() => []),
    listLangSmithAnnotationQueues(resolved, { limit: 5 }).catch(() => []),
  ]);

  const detailedQueues = await Promise.all(
    annotationQueues.slice(0, 3).map(async (queue) => readLangSmithAnnotationQueue(resolved, queue.id).catch(() => null)),
  );
  const detailedQueueMap = new Map(detailedQueues.filter(Boolean).map((queue) => [queue!.id, queue!]));
  const mergedAnnotationQueues = annotationQueues.map((queue) => detailedQueueMap.get(queue.id) || queue);

  const annotationQueueItems = (await Promise.all(
    mergedAnnotationQueues
      .slice(0, 3)
      .map(async (queue) => {
        const items = await listLangSmithAnnotationQueueItems(resolved, queue.id, { limit: 3 }).catch(() => []);
        return items.map((item) => ({
          ...item,
          queueId: item.queueId || queue.id,
          queueName: item.queueName || queue.name,
        }));
      }),
  )).flat();

  const feedbackRunIds = uniqueStrings([
    ...recentRuns.map((run) => run.id),
    ...annotationQueueItems.map((item) => item.runId),
  ]).slice(0, 10);
  const feedback = await listLangSmithFeedback(resolved, {
    runIds: feedbackRunIds,
    limit: 10,
  }).catch(() => []);

  const mergedRecentProjects = currentProject && !recentProjects.some((project) => project.id === currentProject.id)
    ? [currentProject, ...recentProjects].slice(0, 10)
    : recentProjects;

  return {
    workspace: resolved.workspaceId
      ? workspaces.find((workspace) => workspace.id === resolved.workspaceId)
      : workspaces[0],
    accessibleWorkspaces: workspaces,
    currentProject,
    projectName: currentProject?.name || resolved.projectName,
    recentProjects: mergedRecentProjects,
    recentRuns,
    datasets,
    prompts,
    annotationQueues: mergedAnnotationQueues,
    annotationQueueItems,
    feedback,
  };
}
