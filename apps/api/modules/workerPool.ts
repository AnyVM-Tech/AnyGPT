import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { computeProviderStatsWithEMA, computeProviderScore } from './compute.js';
import type { Provider as ProviderStateStructure } from '../providers/interfaces.js';

interface MetricsJob {
  id: number;
  type: 'provider-metrics';
  providerData: ProviderStateStructure;
  alpha: number;
  latencyWeight: number;
  errorWeight: number;
}

interface MetricsResult {
  id: number;
  type: 'provider-metrics';
  providerData: ProviderStateStructure;
}

const jobs = new Map<number, { resolve: (val: ProviderStateStructure) => void; reject: (err: unknown) => void }>();
let worker: Worker | null = null;
let jobId = 0;

function resolveWorkerPath(): { url: URL; execArgv: string[] } | null {
  const jsUrl = new URL('./workers/providerMetricsWorker.js', import.meta.url);
  const jsPath = fileURLToPath(jsUrl);
  if (fs.existsSync(jsPath)) {
    return { url: jsUrl, execArgv: [] };
  }
  // In dev/tsx runs, the JS worker artifact may not exist; fall back to inline compute.
  return null;
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    const resolved = resolveWorkerPath();
    if (!resolved) {
      return null;
    }
    const { url, execArgv } = resolved;
    worker = new Worker(url, { execArgv } as any);
    worker.on('message', (msg: any) => {
      if (!msg || msg.type !== 'provider-metrics') return;
      const pending = jobs.get(msg.id);
      if (!pending) return;
      jobs.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.providerData as ProviderStateStructure);
      }
    });
    worker.on('error', (err) => {
      console.warn('[WorkerPool] Worker error, falling back to inline compute.', err);
      for (const [, pending] of jobs) pending.reject(err);
      jobs.clear();
      worker = null;
    });
    worker.on('exit', (code) => {
      if (code !== 0) console.warn(`[WorkerPool] Worker exited with code ${code}. Falling back inline.`);
      for (const [, pending] of jobs) pending.reject(new Error('Worker exited'));
      jobs.clear();
      worker = null;
    });
    return worker;
  } catch (err) {
    console.warn('[WorkerPool] Failed to start worker, falling back inline.', err);
    worker = null;
    return null;
  }
}

export async function computeProviderMetricsInWorker(
  providerData: ProviderStateStructure,
  alpha: number,
  latencyWeight: number,
  errorWeight: number
): Promise<ProviderStateStructure> {
  const w = ensureWorker();
  if (!w) {
    // Fallback inline
    computeProviderStatsWithEMA(providerData, alpha);
    computeProviderScore(providerData, latencyWeight, errorWeight);
    return providerData;
  }

  const id = ++jobId;
  const payload: MetricsJob = { id, type: 'provider-metrics', providerData, alpha, latencyWeight, errorWeight };

  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    try {
      w.postMessage(payload);
    } catch (err) {
      jobs.delete(id);
      console.warn('[WorkerPool] postMessage failed, falling back inline.', err);
      try {
        computeProviderStatsWithEMA(providerData, alpha);
        computeProviderScore(providerData, latencyWeight, errorWeight);
        resolve(providerData);
      } catch (fallbackErr) {
        reject(fallbackErr);
      }
    }
  });
}
