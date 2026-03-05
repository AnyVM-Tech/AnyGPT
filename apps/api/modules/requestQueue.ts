export class RequestQueue {
  private readonly concurrency: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, Math.floor(concurrency || 1));
  }

  async acquire(): Promise<() => void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return () => this.release();
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

const REQUEST_QUEUE_CONCURRENCY = (() => {
  const raw = Number(process.env.REQUEST_QUEUE_CONCURRENCY ?? '1');
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.floor(raw);
})();

export const requestQueue = new RequestQueue(REQUEST_QUEUE_CONCURRENCY);
