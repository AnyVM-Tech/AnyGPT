import tiersData from '../tiers.json' with { type: 'json' };

export class QueueOverloadedError extends Error {
  readonly code = 'QUEUE_OVERLOADED';
  readonly statusCode = 503;

  constructor(message: string = 'Service temporarily unavailable: request queue is busy. Retry in a few seconds.') {
    super(message);
    this.name = 'QueueOverloadedError';
  }
}

type RequestQueueOptions = {
  maxPending?: number;
};

export class RequestQueue {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(concurrency: number, options: RequestQueueOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(concurrency || 1));
    const suggestedMaxPending = Math.max(16, this.concurrency * 8);
    const rawMaxPending = Number(options.maxPending ?? suggestedMaxPending);
    this.maxPending = Number.isFinite(rawMaxPending) && rawMaxPending >= 0
      ? Math.floor(rawMaxPending)
      : suggestedMaxPending;
  }

  get pending(): number {
    return this.queue.length;
  }

  get inFlight(): number {
    return this.running;
  }

  async acquire(): Promise<() => void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return () => this.release();
    }

    if (this.queue.length >= this.maxPending) {
      throw new QueueOverloadedError(
        `Service temporarily unavailable: request queue is busy (in_flight=${this.running}, pending=${this.queue.length}, max_pending=${this.maxPending}). Retry in a few seconds.`
      );
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running += 1;
        resolve(() => this.release());
      });
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
  const suggestedDefault = Math.max(8, Math.min(24, Math.ceil(baselineTierRps / 2)));
  const raw = Number(process.env.REQUEST_QUEUE_CONCURRENCY ?? String(suggestedDefault));
  if (!Number.isFinite(raw) || raw <= 0) return suggestedDefault;
  return Math.floor(raw);
})();

const REQUEST_QUEUE_MAX_PENDING = (() => {
  const baselineTierRps = getBaselineTierRps();
  const suggestedDefault = Math.min(
    4096,
    Math.max(256, REQUEST_QUEUE_CONCURRENCY * 64, baselineTierRps * 8)
  );
  const raw = Number(process.env.REQUEST_QUEUE_MAX_PENDING ?? String(suggestedDefault));
  if (!Number.isFinite(raw) || raw < 0) return suggestedDefault;
  return Math.floor(raw);
})();

export const requestQueue = new RequestQueue(REQUEST_QUEUE_CONCURRENCY, {
  maxPending: REQUEST_QUEUE_MAX_PENDING,
});
