import { Worker as NodeWorker } from 'node:worker_threads';
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
type RuntimeWorker = NodeWorker | any;

let worker: RuntimeWorker | null = null;
let jobId = 0;

function resolveWorkerPath(): { nodeUrl?: URL; bunUrl?: string; execArgv: string[] } | null {
  const jsUrl = new URL('./workers/providerMetricsWorker.js', import.meta.url);
  const tsUrl = new URL('./workers/providerMetricsWorker.ts', import.meta.url);
  const jsPath = fileURLToPath(jsUrl);
  if (typeof (globalThis as any).Bun !== 'undefined') {
    return {
      nodeUrl: fs.existsSync(jsPath) ? jsUrl : undefined,
      bunUrl: fs.existsSync(jsPath) ? jsUrl.href : tsUrl.href,
      execArgv: [],
    };
  }
  if (fs.existsSync(jsPath)) {
    return { nodeUrl: jsUrl, execArgv: [] };
  }
  // In dev/tsx runs, the JS worker artifact may not exist; fall back to inline compute.
  return null;
}

function handleWorkerMessage(msg: any): void {
  if (!msg || msg.type !== 'provider-metrics') return;
  const pending = jobs.get(msg.id);
  if (!pending) return;
  jobs.delete(msg.id);
  if (msg.error) {
    pending.reject(new Error(msg.error));
  } else {
    pending.resolve(msg.providerData as ProviderStateStructure);
  }
}

function handleWorkerFailure(err: unknown): void {
  console.warn('[WorkerPool] Worker error, falling back to inline compute.', err);
  for (const [, pending] of jobs) pending.reject(err);
  jobs.clear();
  worker = null;
}

function attachNodeWorker(workerRef: NodeWorker): void {
  workerRef.on('message', (msg: any) => handleWorkerMessage(msg));
  workerRef.on('error', (err) => handleWorkerFailure(err));
  workerRef.on('exit', (code) => {
    if (code !== 0) console.warn(`[WorkerPool] Worker exited with code ${code}. Falling back inline.`);
    for (const [, pending] of jobs) pending.reject(new Error('Worker exited'));
    jobs.clear();
    worker = null;
  });
}

function attachBunWorker(workerRef: any): void {
  workerRef.onmessage = (event: any) => handleWorkerMessage(event?.data);
  workerRef.onerror = (event: any) => {
    const err = event?.error || event?.message || event;
    handleWorkerFailure(err);
  };
  if (typeof workerRef.addEventListener === 'function') {
    workerRef.addEventListener('messageerror', (event: any) => {
      const err = event?.error || event?.message || event;
      handleWorkerFailure(err);
    });
  }
}

function ensureWorker(): RuntimeWorker | null {
  if (worker) return worker;
  try {
    const resolved = resolveWorkerPath();
    if (!resolved) {
      return null;
    }
    const BunWorkerCtor = (globalThis as any).Worker;
    if (typeof BunWorkerCtor === 'function' && resolved.bunUrl) {
      worker = new BunWorkerCtor(resolved.bunUrl, { type: 'module' });
      attachBunWorker(worker);
      return worker;
    }

    const { nodeUrl, execArgv } = resolved;
    if (!nodeUrl) {
      return null;
    }

    worker = new NodeWorker(nodeUrl, { execArgv } as any);
    attachNodeWorker(worker as NodeWorker);
    return worker;
  } catch (err) {
    console.warn('[WorkerPool] Failed to start worker, falling back inline.', err);
    worker = null;
    return null;
  }
}

const WORKER_JOB_TIMEOUT_MS = Math.max(1000, Number(process.env.WORKER_JOB_TIMEOUT_MS || 5000));

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
    // Add a timeout to prevent hanging if the worker stalls
    const timer = setTimeout(() => {
      jobs.delete(id);
      console.warn(`[WorkerPool] Job ${id} timed out after ${WORKER_JOB_TIMEOUT_MS}ms, falling back inline.`);
      try {
        computeProviderStatsWithEMA(providerData, alpha);
        computeProviderScore(providerData, latencyWeight, errorWeight);
        resolve(providerData);
      } catch (fallbackErr) {
        reject(fallbackErr);
      }
    }, WORKER_JOB_TIMEOUT_MS);

    jobs.set(id, {
      resolve: (val) => { clearTimeout(timer); resolve(val); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    try {
      w.postMessage(payload);
    } catch (err) {
      clearTimeout(timer);
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
