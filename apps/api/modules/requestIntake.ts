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

function bytesToMegabytes(bytes?: number | null): number | null {
  if (!Number.isFinite(bytes as number) || (bytes as number) < 0) return null;
  return Number(((bytes as number) / BYTES_PER_MEGABYTE).toFixed(1));
}

function getMemoryProfileKey(label: string, extra: Record<string, unknown>): string {
  const requestId = typeof extra.requestId === 'string' ? extra.requestId : '';
  return requestId ? `${label}:${requestId}` : label;
}

function releaseRequestBodyCache(request: Request): void {
  const releasableRequest = request as Request & { releaseBodyCache?: () => void };
  if (typeof releasableRequest.releaseBodyCache !== 'function') return;
  releasableRequest.releaseBodyCache();
}

export function getRequestContentLength(request: Pick<Request, 'headers'>): number | null {
  return parseContentLengthHeader(request.headers['content-length'] ?? request.headers['Content-Length']);
}

export function getBackpressureRetryAfterSeconds(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const code = String((error as any).code || '').trim().toUpperCase();
  if (code === 'MEMORY_PRESSURE' || code === 'QUEUE_OVERLOADED' || code === 'QUEUE_WAIT_TIMEOUT') {
    return REQUEST_BACKPRESSURE_RETRY_AFTER_SECONDS;
  }
  return null;
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
  const logBase = {
    route: request.path,
    requestId: request.requestId,
    contentLengthBytes,
    ...(options.extra ?? {}),
  };
  logMemoryProfile(`${options.label}:before-read`, logBase);

  const releasePermit = await acquireRequestBodyReadPermit(options.label, contentLengthBytes);
  let rawBody: Buffer | null = null;
  let bodyBytes: number | null = null;
  let succeeded = false;
  try {
    rawBody = await request.buffer();
    bodyBytes = rawBody.length;
    logMemoryProfile(`${options.label}:after-read`, {
      ...logBase,
      bodyBytes,
    });
    const result = await reader(rawBody, contentLengthBytes);
    succeeded = true;
    logMemoryProfile(`${options.label}:after-parse`, {
      ...logBase,
      bodyBytes,
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
    });
  }
}

export async function readJsonRequestBody<T = any>(
  request: Request,
  options: RequestBodyOptions,
): Promise<T> {
  return withBufferedRequestBody(request, options, (rawBody) => JSON.parse(rawBody.toString('utf8')) as T);
}
