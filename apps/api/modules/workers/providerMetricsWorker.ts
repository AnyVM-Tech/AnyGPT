import { parentPort } from 'node:worker_threads';
import { computeProviderStatsWithEMA, computeProviderScore } from '../compute.js';
import type { Provider as ProviderStateStructure } from '../../providers/interfaces.js';

if (!parentPort) {
  throw new Error('providerMetricsWorker must be run as a worker thread');
}

parentPort.on('message', (msg: any) => {
  if (!msg || msg.type !== 'provider-metrics') return;
  const { id, providerData, alpha, latencyWeight, errorWeight } = msg as {
    id: number;
    providerData: ProviderStateStructure;
    alpha: number;
    latencyWeight: number;
    errorWeight: number;
  };
  try {
    computeProviderStatsWithEMA(providerData, alpha);
    computeProviderScore(providerData, latencyWeight, errorWeight);
    parentPort!.postMessage({ id, type: 'provider-metrics', providerData });
  } catch (err) {
    parentPort!.postMessage({ id, type: 'provider-metrics', error: (err as Error).message });
  }
});
