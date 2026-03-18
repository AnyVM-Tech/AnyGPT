import fs from 'node:fs';
import os from 'node:os';
import tiersData from '../tiers.json' with { type: 'json' };

export type RequestQueueSnapshot = {
  label: string;
  concurrency: number;
  maxPending: number;
  maxWaitMs: number;
  inFlight: number;
  pending: number;
  overloadCount: number;
  lastOverloadedAt?: string;
};

export type MemoryPressureSnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  systemTotalBytes: number;
  systemFreeBytes: number;
  systemAvailableBytes: number;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
  swapUsedBytes: number | null;
};

export class QueueOverloadedError extends Error {
  readonly code = 'QUEUE_OVERLOADED';
  readonly statusCode = 503;
  readonly queueLabel?: string;
  readonly concurrency?: number;
  readonly maxPending?: number;
  readonly maxWaitMs?: number;
  readonly inFlight?: number;
  readonly pending?: number;
  readonly overloadCount?: number;
  readonly lastOverloadedAt?: string;

  constructor(
    message: string = 'Service temporarily unavailable: request queue is busy. Retry in a few seconds.',
    snapshot?: RequestQueueSnapshot,
  ) {
    super(message);
    this.name = 'QueueOverloadedError';
    if (snapshot) {
      this.queueLabel = snapshot.label;
      this.concurrency = snapshot.concurrency;
      this.maxPending = snapshot.maxPending;
      this.maxWaitMs = snapshot.maxWaitMs;
      this.inFlight = snapshot.inFlight;
      this.pending = snapshot.pending;
      this.overloadCount = snapshot.overloadCount;
      this.lastOverloadedAt = snapshot.lastOverloadedAt;
    }
  }
}

export class QueueWaitTimeoutError extends Error {
  readonly code = 'QUEUE_WAIT_TIMEOUT';
  readonly statusCode = 503;
  readonly queueLabel?: string;
  readonly concurrency?: number;
  readonly maxPending?: number;
  readonly maxWaitMs?: number;
  readonly inFlight?: number;
  readonly pending?: number;
  readonly overloadCount?: number;
  readonly lastOverloadedAt?: string;

  constructor(
    message: string = 'Service temporarily unavailable: request queue wait timed out. Retry in a few seconds.',
    snapshot?: RequestQueueSnapshot,
  ) {
    super(message);
    this.name = 'QueueWaitTimeoutError';
    if (snapshot) {
      this.queueLabel = snapshot.label;
      this.concurrency = snapshot.concurrency;
      this.maxPending = snapshot.maxPending;
      this.maxWaitMs = snapshot.maxWaitMs;
      this.inFlight = snapshot.inFlight;
      this.pending = snapshot.pending;
      this.overloadCount = snapshot.overloadCount;
      this.lastOverloadedAt = snapshot.lastOverloadedAt;
    }
  }
}

export class MemoryPressureError extends Error {
  readonly code = 'MEMORY_PRESSURE';
  readonly statusCode = 503;
  readonly label: string;
  readonly reasons: string[];
  readonly snapshot: MemoryPressureSnapshot;
  readonly contentLengthBytes?: number | null;

  constructor(
    label: string,
    reasons: string[],
    snapshot: MemoryPressureSnapshot,
    contentLengthBytes?: number | null,
  ) {
    const contentLengthMb = Number.isFinite(contentLengthBytes as number) && (contentLengthBytes as number) > 0
      ? ` content_length_mb=${bytesToMegabytes(contentLengthBytes as number).toFixed(1)}`
      : '';
    super(`Service temporarily unavailable: ${label} rejected under memory pressure (${reasons.join('; ')}).${contentLengthMb}`);
    this.name = 'MemoryPressureError';
    this.label = label;
    this.reasons = reasons;
    this.snapshot = snapshot;
    this.contentLengthBytes = contentLengthBytes;
  }
}

type RequestQueueOptions = {
  maxPending?: number;
  maxWaitMs?: number;
  label?: string;
  memoryPressureGuard?: boolean;
};

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_SYSTEM_TOTAL_MB = Math.max(1, Math.floor(os.totalmem() / BYTES_PER_MEGABYTE));
const MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB = (() => {
  const fallback = Math.max(768, Math.min(3072, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.08)));
  const raw = Number(process.env.REQUEST_MEMORY_MIN_AVAILABLE_SYSTEM_MB ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MAX_SWAP_USED_MB = (() => {
  const fallback = Math.max(4096, Math.min(16384, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.5)));
  const raw = Number(process.env.REQUEST_MEMORY_MAX_SWAP_USED_MB ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MAX_RSS_MB = (() => {
  const fallback = Math.max(768, Math.min(2048, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.2)));
  const raw = Number(process.env.REQUEST_MEMORY_MAX_RSS_MB ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MAX_EXTERNAL_MB = (() => {
  const fallback = Math.max(256, Math.min(1024, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.08)));
  const raw = Number(process.env.REQUEST_MEMORY_MAX_EXTERNAL_MB ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_MAX_ARRAY_BUFFERS_MB = (() => {
  const fallback = Math.max(128, Math.min(768, Math.floor(DEFAULT_SYSTEM_TOTAL_MB * 0.05)));
  const raw = Number(process.env.REQUEST_MEMORY_MAX_ARRAY_BUFFERS_MB ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
})();
const MEMORY_PRESSURE_LOG_COOLDOWN_MS = (() => {
  const raw = Number(process.env.REQUEST_MEMORY_PRESSURE_LOG_COOLDOWN_MS ?? 10_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10_000;
})();

let lastMemoryPressureLogAt = 0;
let cachedProcMeminfoReadAt = 0;
let cachedProcMeminfo: { memAvailableBytes?: number; swapTotalBytes?: number; swapFreeBytes?: number } | null = null;

function bytesToMegabytes(bytes: number): number {
  return bytes / BYTES_PER_MEGABYTE;
}

function readProcMeminfo(): { memAvailableBytes?: number; swapTotalBytes?: number; swapFreeBytes?: number } {
  const now = Date.now();
  if (cachedProcMeminfo && now - cachedProcMeminfoReadAt < 500) {
    return cachedProcMeminfo;
  }

  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const values: Record<string, number> = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
      if (!match) continue;
      values[match[1]] = Number(match[2]) * 1024;
    }
    cachedProcMeminfoReadAt = now;
    cachedProcMeminfo = {
      memAvailableBytes: values.MemAvailable,
      swapTotalBytes: values.SwapTotal,
      swapFreeBytes: values.SwapFree,
    };
    return cachedProcMeminfo;
  } catch {
    cachedProcMeminfoReadAt = now;
    cachedProcMeminfo = {};
    return cachedProcMeminfo;
  }
}

export function getMemoryPressureSnapshot(): MemoryPressureSnapshot {
  const usage = process.memoryUsage();
  const procMeminfo = readProcMeminfo();
  const systemTotalBytes = os.totalmem();
  const systemFreeBytes = os.freemem();
  const systemAvailableBytes = procMeminfo.memAvailableBytes ?? systemFreeBytes;
  const swapTotalBytes = typeof procMeminfo.swapTotalBytes === 'number' ? procMeminfo.swapTotalBytes : null;
  const swapFreeBytes = typeof procMeminfo.swapFreeBytes === 'number' ? procMeminfo.swapFreeBytes : null;
  const swapUsedBytes = swapTotalBytes !== null && swapFreeBytes !== null
    ? Math.max(0, swapTotalBytes - swapFreeBytes)
    : null;
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    systemTotalBytes,
    systemFreeBytes,
    systemAvailableBytes,
    swapTotalBytes,
    swapFreeBytes,
    swapUsedBytes,
  };
}

function buildMemoryPressureReasons(snapshot: MemoryPressureSnapshot): string[] {
  const reasons: string[] = [];
  const availableSystemMb = bytesToMegabytes(snapshot.systemAvailableBytes);
  const swapUsedMb = snapshot.swapUsedBytes !== null ? bytesToMegabytes(snapshot.swapUsedBytes) : null;
  const rssMb = bytesToMegabytes(snapshot.rssBytes);
  const externalMb = bytesToMegabytes(snapshot.externalBytes);
  const arrayBuffersMb = bytesToMegabytes(snapshot.arrayBuffersBytes);

  if (availableSystemMb <= MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB) {
    reasons.push(`available_system_mb=${availableSystemMb.toFixed(0)}<=${MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB}`);
  }
  if (swapUsedMb !== null && swapUsedMb >= MEMORY_PRESSURE_MAX_SWAP_USED_MB) {
    reasons.push(`swap_used_mb=${swapUsedMb.toFixed(0)}>=${MEMORY_PRESSURE_MAX_SWAP_USED_MB}`);
  }

  const lowHeadroom = availableSystemMb <= (MEMORY_PRESSURE_MIN_AVAILABLE_SYSTEM_MB * 2)
    || (swapUsedMb !== null && swapUsedMb >= Math.floor(MEMORY_PRESSURE_MAX_SWAP_USED_MB * 0.5));
  if (lowHeadroom && rssMb >= MEMORY_PRESSURE_MAX_RSS_MB) {
    reasons.push(`rss_mb=${rssMb.toFixed(0)}>=${MEMORY_PRESSURE_MAX_RSS_MB}`);
  }
  if (lowHeadroom && externalMb >= MEMORY_PRESSURE_MAX_EXTERNAL_MB) {
    reasons.push(`external_mb=${externalMb.toFixed(0)}>=${MEMORY_PRESSURE_MAX_EXTERNAL_MB}`);
  }
  if (lowHeadroom && arrayBuffersMb >= MEMORY_PRESSURE_MAX_ARRAY_BUFFERS_MB) {
    reasons.push(`array_buffers_mb=${arrayBuffersMb.toFixed(0)}>=${MEMORY_PRESSURE_MAX_ARRAY_BUFFERS_MB}`);
  }

  return reasons;
}

function logMemoryPressure(label: string, reasons: string[], snapshot: MemoryPressureSnapshot, contentLengthBytes?: number | null): void {
  const now = Date.now();
  if (now - lastMemoryPressureLogAt < MEMORY_PRESSURE_LOG_COOLDOWN_MS) return;
  lastMemoryPressureLogAt = now;

  const details = {
    label,
    reasons,
    contentLengthBytes: Number.isFinite(contentLengthBytes as number) ? Math.max(0, Number(contentLengthBytes)) : undefined,
    rssMb: Number(bytesToMegabytes(snapshot.rssBytes).toFixed(1)),
    heapUsedMb: Number(bytesToMegabytes(snapshot.heapUsedBytes).toFixed(1)),
    externalMb: Number(bytesToMegabytes(snapshot.externalBytes).toFixed(1)),
    arrayBuffersMb: Number(bytesToMegabytes(snapshot.arrayBuffersBytes).toFixed(1)),
    availableSystemMb: Number(bytesToMegabytes(snapshot.systemAvailableBytes).toFixed(1)),
    swapUsedMb: snapshot.swapUsedBytes !== null ? Number(bytesToMegabytes(snapshot.swapUsedBytes).toFixed(1)) : null,
  };
  console.warn(`[MemoryPressure] ${JSON.stringify(details)}`);
}

export function isMemoryPressureError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as any).code === 'MEMORY_PRESSURE');
}

export function parseContentLengthHeader(value: unknown): number | null {
  const raw = typeof value === 'string'
    ? value
    : (Array.isArray(value) && value.length > 0 ? String(value[0]) : '');
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function rejectOnMemoryPressure(label: string, contentLengthBytes?: number | null): void {
  const snapshot = getMemoryPressureSnapshot();
  const reasons = buildMemoryPressureReasons(snapshot);
  if (reasons.length === 0) return;
  logMemoryPressure(label, reasons, snapshot, contentLengthBytes);
  throw new MemoryPressureError(label, reasons, snapshot, contentLengthBytes);
}

export class RequestQueue {
  private readonly concurrency: number;
  private readonly maxPendingLimit: number;
  private readonly maxWaitMs: number;
  private readonly label: string;
  private readonly memoryPressureGuard: boolean;
  private running = 0;
  private readonly queue: Array<() => void> = [];
  private overloadCount = 0;
  private lastOverloadedAt = 0;

  constructor(concurrency: number, options: RequestQueueOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(concurrency || 1));
    this.label = String(options.label || 'request-queue').trim() || 'request-queue';
    const suggestedMaxPending = Math.max(16, this.concurrency * 8);
    const rawMaxPending = Number(options.maxPending ?? suggestedMaxPending);
    this.maxPendingLimit = Number.isFinite(rawMaxPending) && rawMaxPending >= 0
      ? Math.floor(rawMaxPending)
      : suggestedMaxPending;
    const rawMaxWaitMs = Number(options.maxWaitMs ?? 0);
    this.maxWaitMs = Number.isFinite(rawMaxWaitMs) && rawMaxWaitMs > 0
      ? Math.floor(rawMaxWaitMs)
      : 0;
    this.memoryPressureGuard = options.memoryPressureGuard === true;
  }

  get pending(): number {
    return this.queue.length;
  }

  get inFlight(): number {
    return this.running;
  }

  snapshot(): RequestQueueSnapshot {
    return {
      label: this.label,
      concurrency: this.concurrency,
      maxPending: this.maxPendingLimit,
      maxWaitMs: this.maxWaitMs,
      inFlight: this.running,
      pending: this.queue.length,
      overloadCount: this.overloadCount,
      lastOverloadedAt: this.lastOverloadedAt > 0 ? new Date(this.lastOverloadedAt).toISOString() : undefined,
    };
  }

  async acquire(): Promise<() => void> {
    if (this.memoryPressureGuard) {
      rejectOnMemoryPressure(this.label);
    }

    if (this.running < this.concurrency) {
      this.running += 1;
      return () => this.release();
    }

    if (this.queue.length >= this.maxPendingLimit) {
      this.overloadCount += 1;
      this.lastOverloadedAt = Date.now();
      const snapshot = this.snapshot();
      throw new QueueOverloadedError(
        `Service temporarily unavailable: request queue ${snapshot.label} is busy (concurrency=${snapshot.concurrency}, in_flight=${snapshot.inFlight}, pending=${snapshot.pending}, max_pending=${snapshot.maxPending}, overload_count=${snapshot.overloadCount}). Retry in a few seconds.`,
        snapshot,
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId: NodeJS.Timeout | null = null;
      const queueEntry = () => {
        if (settled) return;
        if (this.memoryPressureGuard) {
          try {
            rejectOnMemoryPressure(this.label);
          } catch (error) {
            settled = true;
            if (timeoutId) clearTimeout(timeoutId);
            reject(error);
            const nextQueued = this.queue.shift();
            if (nextQueued) nextQueued();
            return;
          }
        }
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        this.running += 1;
        resolve(() => this.release());
      };

      this.queue.push(queueEntry);

      if (this.maxWaitMs > 0) {
        timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          const queueIndex = this.queue.indexOf(queueEntry);
          if (queueIndex !== -1) {
            this.queue.splice(queueIndex, 1);
          }
          const snapshot = this.snapshot();
          reject(new QueueWaitTimeoutError(
            `Service temporarily unavailable: request queue ${snapshot.label} waited too long (wait_ms=${snapshot.maxWaitMs}, concurrency=${snapshot.concurrency}, in_flight=${snapshot.inFlight}, pending=${snapshot.pending}, max_pending=${snapshot.maxPending}, overload_count=${snapshot.overloadCount}). Retry in a few seconds.`,
            snapshot,
          ));
        }, this.maxWaitMs);
      }
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

function getBaselineTierRps(): number {
  const values = Object.values(tiersData as Record<string, any>)
    .map((tier) => Number(tier?.rps))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return 20;
  return Math.floor(Math.min(...values));
}

const REQUEST_QUEUE_CONCURRENCY = (() => {
  const baselineTierRps = getBaselineTierRps();
  const suggestedDefault = Math.max(12, Math.min(32, Math.ceil(baselineTierRps * 0.75)));
  const raw = Number(process.env.REQUEST_QUEUE_CONCURRENCY ?? String(suggestedDefault));
  if (!Number.isFinite(raw) || raw <= 0) return suggestedDefault;
  return Math.floor(raw);
})();

const REQUEST_QUEUE_MAX_PENDING = (() => {
  const baselineTierRps = getBaselineTierRps();
  const suggestedDefault = Math.min(
    8192,
    Math.max(1024, REQUEST_QUEUE_CONCURRENCY * 192, baselineTierRps * 24)
  );
  const raw = Number(process.env.REQUEST_QUEUE_MAX_PENDING ?? String(suggestedDefault));
  if (!Number.isFinite(raw) || raw < 0) return suggestedDefault;
  return Math.floor(raw);
})();

const REQUEST_QUEUE_MAX_WAIT_MS = (() => {
  const raw = Number(process.env.REQUEST_QUEUE_MAX_WAIT_MS ?? 15_000);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
})();

const REQUEST_BODY_READ_QUEUE_CONCURRENCY = (() => {
  const fallback = Math.max(4, Math.min(REQUEST_QUEUE_CONCURRENCY, 8));
  const raw = Number(process.env.REQUEST_BODY_READ_QUEUE_CONCURRENCY ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
})();

const REQUEST_BODY_READ_QUEUE_MAX_PENDING = (() => {
  const fallback = Math.max(256, REQUEST_BODY_READ_QUEUE_CONCURRENCY * 64);
  const raw = Number(process.env.REQUEST_BODY_READ_QUEUE_MAX_PENDING ?? fallback);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.floor(raw);
})();

export const requestBodyReadQueue = new RequestQueue(REQUEST_BODY_READ_QUEUE_CONCURRENCY, {
  label: 'request-body-read',
  maxPending: REQUEST_BODY_READ_QUEUE_MAX_PENDING,
  memoryPressureGuard: true,
});

export async function acquireRequestBodyReadPermit(label: string, contentLengthBytes?: number | null): Promise<() => void> {
  rejectOnMemoryPressure(label, contentLengthBytes);
  const release = await requestBodyReadQueue.acquire();
  try {
    rejectOnMemoryPressure(label, contentLengthBytes);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export const requestQueue = new RequestQueue(REQUEST_QUEUE_CONCURRENCY, {
  label: 'request-queue',
  maxPending: REQUEST_QUEUE_MAX_PENDING,
  maxWaitMs: REQUEST_QUEUE_MAX_WAIT_MS,
  memoryPressureGuard: true,
});
