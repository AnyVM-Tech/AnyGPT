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

type RequestQueueOptions = {
  maxPending?: number;
  maxWaitMs?: number;
  label?: string;
};

export class RequestQueue {
  private readonly concurrency: number;
  private readonly maxPendingLimit: number;
  private readonly maxWaitMs: number;
  private readonly label: string;
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

export const requestQueue = new RequestQueue(REQUEST_QUEUE_CONCURRENCY, {
  label: 'request-queue',
  maxPending: REQUEST_QUEUE_MAX_PENDING,
  maxWaitMs: REQUEST_QUEUE_MAX_WAIT_MS,
});
