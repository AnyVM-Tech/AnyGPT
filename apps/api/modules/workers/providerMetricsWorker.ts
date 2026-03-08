import { computeProviderStatsWithEMA, computeProviderScore } from '../compute.js';
import type { Provider as ProviderStateStructure } from '../../providers/interfaces.js';

type MetricsMessage = {
  id: number;
  providerData: ProviderStateStructure;
  alpha: number;
  latencyWeight: number;
  errorWeight: number;
};

function handleMetricsMessage(msg: any, send: (payload: any) => void) {
  if (!msg || msg.type !== 'provider-metrics') return;
  const { id, providerData, alpha, latencyWeight, errorWeight } = msg as MetricsMessage;
  try {
    computeProviderStatsWithEMA(providerData, alpha);
    computeProviderScore(providerData, latencyWeight, errorWeight);
    send({ id, type: 'provider-metrics', providerData });
  } catch (err) {
    send({ id, type: 'provider-metrics', error: (err as Error).message });
  }
}

const workerGlobal = globalThis as any;

if (typeof workerGlobal.addEventListener === 'function' && typeof workerGlobal.postMessage === 'function') {
  workerGlobal.addEventListener('message', (event: any) => {
    handleMetricsMessage(event?.data, (payload) => workerGlobal.postMessage(payload));
  });
} else {
  void (async () => {
    const { parentPort } = await import('node:worker_threads');
    if (!parentPort) {
      throw new Error('providerMetricsWorker must be run as a worker thread');
    }
    parentPort.on('message', (msg: any) => {
      handleMetricsMessage(msg, (payload) => parentPort.postMessage(payload));
    });
  })();
}
