import type { Request } from '../lib/uws-compat.js';
import {
  acquireRequestBodyReadPermit,
  getMemoryPressureSnapshot,
  parseContentLengthHeader,
} from './requestQueue.js';

const BYTES_PER_MEGABYTE = 1024 * 1024;

const REQUEST_BACKPRESSURE_RETRY_AFTER_SECONDS = (() => {
  const raw = Number(process.env.REQUEST_BACKPRESSURE_RETRY_AFTER_SECONDS ?? 5);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
})();

const REQUEST_MEMORY_PROFILE_LOGS = (() => {
  const raw = String(process.env.REQUEST_MEMORY_PROFILE_LOGS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
})();

const REQUEST_MEMORY_PROFILE_LOG_COOLDOWN_MS = (() => {
  const raw = Number(process.env.REQUEST_MEMORY_PROFILE_LOG_COOLDOWN_MS ?? 0);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
})();

const memoryProfileCooldowns = new Map<string, number>();

type RequestBodyOptions = {
  label: string;
  extra?: Record<string, unknown>;
  releaseBodyCache?: boolean;
};

export type BackpressureHint = {
  reason: 'memory_pressure' | 'queue_overloaded' | 'queue_wait_timeout';
  retryAfterSeconds: number;
  retryable: true;
  contentLengthBytes?: number | null;
  contentLengthKnown?: boolean;
  emptyBody?: boolean;
  emptyBodySource?: 'declared_content_length' | 'observed_after_read';
  bodySizeClass?: 'empty' | 'known' | 'unknown';
  requestSizeHint?: 'empty_body' | 'small_or_unknown' | 'large_known_body';
  requestBodySizeBucket?: 'empty' | 'unknown' | 'small' | 'medium' | 'large';
  requestBodyReadStrategy?: 'skip-empty-body' | 'buffer-known-length' | 'buffer-unknown-length' | 'buffer-observed-empty';
  requestBodyReadPermitStrategy?: 'skip-empty-body' | 'bypass-small-known-body' | 'bypass-unknown-length-body' | 'queue-body-read';
  failureOrigin?: 'runtime_capacity' | 'runtime_capacity_idle' | 'runtime_capacity_active' | 'runtime_capacity_large_known_body' | 'runtime_capacity_unknown_length_body';
  requestBodyObservedEmpty?: boolean;
  requestBodyDeclaredEmpty?: boolean;
  requestBodyReadPermitAcquired?: boolean;
  queueLane?: 'request-body-read';
  queueState?: string;
  queuePressureOrigin?: 'idle_runtime_pressure' | 'active_runtime_pressure' | 'queue_backpressure';
  queuePressureScore?: number | null;
  queueUtilization?: number | null;
  queuePendingUtilization?: number | null;
  queueInFlight?: number | null;
  queuePending?: number | null;
  memoryRssBytes?: number | null;
  memoryHeapUsedBytes?: number | null;
  memoryExternalBytes?: number | null;
  memoryArrayBuffersBytes?: number | null;
  memorySwapBytes?: number | null;
};

function bytesToMegabytes(bytes?: number | null): number | null {
  if (!Number.isFinite(bytes as number) || (bytes as number) < 0) return null;
  return Number(((bytes as number) / BYTES_PER_MEGABYTE).toFixed(1));
}

function getMemoryProfileKey(label: string, extra: Record<string, unknown>): string {
  const requestId = typeof extra.requestId === 'string' ? extra.requestId : '';
  const route = typeof extra.route === 'string' ? extra.route : '';
  if (requestId && route) return `${label}:${route}:${requestId}`;
  if (requestId) return `${label}:${requestId}`;
  if (route) return `${label}:${route}`;
  return label;
}

function releaseRequestBodyCache(request: Request): void {
  const releasableRequest = request as Request & { releaseBodyCache?: () => void };
  if (typeof releasableRequest.releaseBodyCache !== 'function') return;
  releasableRequest.releaseBodyCache();
}

export function getRequestContentLength(request: Pick<Request, 'headers'>): number | null {
  return parseContentLengthHeader(request.headers['content-length'] ?? request.headers['Content-Length']);
}

export function getBackpressureReason(error: unknown): 'memory_pressure' | 'queue_overloaded' | 'queue_wait_timeout' | null {
  if (!error || typeof error !== 'object') return null;
  const code = String((error as any).code || '').trim().toUpperCase();
  if (code === 'MEMORY_PRESSURE') return 'memory_pressure';
  if (code === 'QUEUE_OVERLOADED') return 'queue_overloaded';
  if (code === 'QUEUE_WAIT_TIMEOUT') return 'queue_wait_timeout';
  return null;
}

export function getBackpressureRetryAfterSeconds(error: unknown): number | null {
  return getBackpressureReason(error) ? REQUEST_BACKPRESSURE_RETRY_AFTER_SECONDS : null;
}

export function getBackpressureHint(
  error: unknown,
  contentLengthBytes?: number | null,
): BackpressureHint | null {
  const reason = getBackpressureReason(error);
  if (!reason) return null;
  const normalizedContentLengthBytes =
    typeof contentLengthBytes === 'number' && Number.isFinite(contentLengthBytes)
      ? Math.max(0, Math.floor(contentLengthBytes))
      : null;
  const memorySnapshot = reason === 'memory_pressure' ? getMemoryPressureSnapshot() : null;
  return {
    reason,
    retryAfterSeconds: REQUEST_BACKPRESSURE_RETRY_AFTER_SECONDS,
    retryable: true,
    contentLengthBytes: normalizedContentLengthBytes,
    contentLengthKnown: normalizedContentLengthBytes !== null,
    emptyBody: normalizedContentLengthBytes === 0,
    ...(memorySnapshot
      ? {
          rssMb: bytesToMegabytes(memorySnapshot.rssBytes),
          heapUsedMb: bytesToMegabytes(memorySnapshot.heapUsedBytes),
          externalMb: bytesToMegabytes(memorySnapshot.externalBytes),
          availableSystemMb: bytesToMegabytes(memorySnapshot.systemAvailableBytes),
          swapUsedMb: bytesToMegabytes(memorySnapshot.swapUsedBytes),
        }
      : {}),
  };
}

export function logMemoryProfile(label: string, extra: Record<string, unknown> = {}): void {
  if (!REQUEST_MEMORY_PROFILE_LOGS) return;

  if (REQUEST_MEMORY_PROFILE_LOG_COOLDOWN_MS > 0) {
    const key = getMemoryProfileKey(label, extra);
    const now = Date.now();
    const lastLoggedAt = memoryProfileCooldowns.get(key) ?? 0;
    if (now - lastLoggedAt < REQUEST_MEMORY_PROFILE_LOG_COOLDOWN_MS) return;
    memoryProfileCooldowns.set(key, now);
  }

  const snapshot = getMemoryPressureSnapshot();
  const payload = {
    label,
    ...extra,
    rssMb: bytesToMegabytes(snapshot.rssBytes),
    heapUsedMb: bytesToMegabytes(snapshot.heapUsedBytes),
    heapTotalMb: bytesToMegabytes(snapshot.heapTotalBytes),
    externalMb: bytesToMegabytes(snapshot.externalBytes),
    arrayBuffersMb: bytesToMegabytes(snapshot.arrayBuffersBytes),
    availableSystemMb: bytesToMegabytes(snapshot.systemAvailableBytes),
    swapUsedMb: bytesToMegabytes(snapshot.swapUsedBytes),
  };
  console.info(`[MemoryProfile] ${JSON.stringify(payload)}`);
}

export async function withBufferedRequestBody<T>(
  request: Request,
  options: RequestBodyOptions,
  reader: (rawBody: Buffer, contentLengthBytes: number | null) => Promise<T> | T,
): Promise<T> {
  const contentLengthBytes = getRequestContentLength(request);
  const requestBodySizeBucket =
    contentLengthBytes === 0
      ? 'empty'
      : contentLengthBytes === null
        ? 'unknown'
        : contentLengthBytes < 64 * 1024
          ? 'small'
          : contentLengthBytes < 1024 * 1024
            ? 'medium'
            : 'large';
  const requestBodyReadStrategy =
    contentLengthBytes === 0
      ? 'skip-empty-body'
      : contentLengthBytes === null
        ? 'buffer-unknown-length'
        : 'buffer-known-length';
  const requestSizeHint =
    contentLengthBytes === 0
      ? 'empty_body'
      : contentLengthBytes === null || contentLengthBytes < 1024 * 1024
        ? 'small_or_unknown'
        : 'large_known_body';
  const requestBodyReadPermitStrategy =
    contentLengthBytes === 0
      ? 'skip-empty-body'
      : requestSizeHint === 'small_or_unknown' && contentLengthBytes !== null
        ? 'bypass-small-known-body'
        : 'queue-body-read';
  const logBase = {
    route: request.path,
    requestId: request.requestId,
    contentLengthBytes,
    contentLengthKnown: contentLengthBytes !== null,
    requestBodySizeBucket,
    requestBodyReadStrategy,
    requestBodyReadPermitStrategy,
    requestSizeHint,
    ...(options.extra ?? {}),
  };
  const skippedBodyBufferRead = contentLengthBytes === 0;
  const skippedBodyReadPermit = requestBodyReadPermitStrategy !== 'queue-body-read';
  logMemoryProfile(`${options.label}:before-read`, {
    ...logBase,
    skippedBodyReadPermit,
    skippedBodyBufferRead,
  });

  const shouldAcquireBodyReadPermit = requestBodyReadPermitStrategy === 'queue-body-read';
  const releasePermit = shouldAcquireBodyReadPermit
    ? await acquireRequestBodyReadPermit(options.label, contentLengthBytes)
    : () => {};
  let rawBody: Buffer | null = null;
  let bodyBytes: number | null = null;
  let succeeded = false;
  try {
    if (contentLengthBytes === 0) {
      rawBody = Buffer.alloc(0);
    } else {
      rawBody = await request.buffer();
    }
    bodyBytes = rawBody.length;
    const emptyBody = bodyBytes === 0;
    const emptyBodySource =
      contentLengthBytes === 0
        ? 'declared_content_length'
        : emptyBody
          ? 'observed_after_read'
          : undefined;
    logMemoryProfile(`${options.label}:after-read`, {
      ...logBase,
      bodyBytes,
      emptyBody,
      ...(emptyBodySource ? { emptyBodySource } : {}),
      skippedBodyReadPermit,
      skippedBodyBufferRead: contentLengthBytes === 0,
    });
    const result = await reader(rawBody, contentLengthBytes);
    succeeded = true;
    logMemoryProfile(`${options.label}:after-parse`, {
      ...logBase,
      bodyBytes,
      skippedBodyReadPermit,
      skippedBodyBufferRead: contentLengthBytes === 0,
    });
    return result;
  } finally {
    rawBody = null;
    if (options.releaseBodyCache !== false) {
      releaseRequestBodyCache(request);
    }
    releasePermit();
    logMemoryProfile(`${options.label}:after-release`, {
      ...logBase,
      bodyBytes,
      parsed: succeeded,
      skippedBodyReadPermit,
      skippedBodyBufferRead: contentLengthBytes === 0,
    });
  }
}

export async function readJsonRequestBody<T = any>(
  request: Request,
  options: RequestBodyOptions,
): Promise<T> {
  return withBufferedRequestBody(request, options, (rawBody) => {
    try {
      return JSON.parse(rawBody.toString('utf8')) as T;
    } catch (error) {
      const parseError = new Error('Invalid JSON request body.');
      (parseError as Error & { statusCode?: number; code?: string; cause?: unknown }).statusCode = 400;
      (parseError as Error & { statusCode?: number; code?: string; cause?: unknown }).code = 'INVALID_JSON_BODY';
      (parseError as Error & { statusCode?: number; code?: string; cause?: unknown }).cause = error;
      throw parseError;
    }
  });
}
