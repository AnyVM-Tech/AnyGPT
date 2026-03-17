import type { Provider, ResponseEntry, Model, ModelDefinition } from '../providers/interfaces.js'; // Removed TokenSpeedEntry
import modelsData from '../models.json' with { type: 'json' };

const typedModelsData = modelsData as { data: ModelDefinition[] };

const initialModelThroughputMap = new Map<string, number>();
typedModelsData.data.forEach((model: ModelDefinition) => {
  if (model.id && model.throughput && !isNaN(Number(model.throughput)) && Number(model.throughput) > 0) {
    initialModelThroughputMap.set(model.id, Number(model.throughput));
  }
});

// Updated signature: removed speedEntry
export function updateProviderData(
  providerData: Provider,
  modelId: string,
  responseEntry: ResponseEntry | null,
  isError: boolean
): void {
  const modelData = providerData.models[modelId];
  if (!modelData) {
      console.error(`CRITICAL: updateProviderData called for uninitialized model ${modelId} in provider ${providerData.id}.`);
      return;
  }

  if (isError) {
    modelData.errors = (modelData.errors ?? 0) + 1;
    providerData.errors = (providerData.errors ?? 0) + 1;
    console.log(`Error recorded for model ${modelId} in provider ${providerData.id}. Total provider errors: ${providerData.errors}`);
  } else if (responseEntry) {
      // Ensure response_times array exists
      if (!Array.isArray(modelData.response_times)) {
        modelData.response_times = [];
      }
      // Ensure timestamp is valid
      if (typeof responseEntry.timestamp !== 'number' || isNaN(responseEntry.timestamp)) {
         console.warn(`Invalid or missing timestamp for ${modelId}. Setting to current time.`);
         responseEntry.timestamp = Date.now();
      }
      // Ensure observed_speed_tps is valid (if present)
      if (responseEntry.observed_speed_tps !== undefined && responseEntry.observed_speed_tps !== null &&
          (typeof responseEntry.observed_speed_tps !== 'number' || isNaN(responseEntry.observed_speed_tps) || responseEntry.observed_speed_tps <= 0)) {
          console.warn(`Invalid observed_speed_tps for ${modelId}. Setting to null.`);
          responseEntry.observed_speed_tps = null;
      }
      modelData.response_times.push(responseEntry);
      // Removed logic for pushing to token_speeds
  }
}

export function computeEMA(
  previousEMA: number | null | undefined,
  newValue: number,
  alpha: number
): number {
  if (newValue === null || isNaN(newValue)) {
      return previousEMA ?? 0;
  }
  if (previousEMA === null || previousEMA === undefined || isNaN(previousEMA)) {
    // Round initial value to consistent precision
    return Math.round(newValue * 100) / 100;
  }
  const calculatedEMA = alpha * newValue + (1 - alpha) * previousEMA;
  return Math.round(calculatedEMA * 100) / 100; // Round result
}

export function computeProviderStatsWithEMA(
  providerData: Provider,
  _alpha?: number
): void {
  let totalResponseTime = 0;
  let totalProviderLatency = 0;
  let validModelRequests = 0;
  let validProviderResponses = 0;

  if (!providerData || !providerData.models) {
      console.error(`computeProviderStatsWithEMA called with invalid providerData for ID: ${providerData?.id}`);
      return;
  }

  for (const modelId in providerData.models) {
    const model = providerData.models[modelId];
    if (!model) continue;

    // Reset model averages before recalculating
    model.avg_response_time = null;
    model.avg_provider_latency = null;
    model.avg_token_speed = null;

    if (Array.isArray(model.response_times)) {
        let modelTotalResponseTime = 0;
        let modelTotalProviderLatency = 0;
        let modelTotalSpeed = 0;
        let modelValidRequests = 0;
        let modelValidProviderResponses = 0;
        let modelValidSpeedSamples = 0;

        for (const response of model.response_times) {
            if (!response || typeof response.response_time !== 'number' || isNaN(response.response_time)) {
                continue;
            }
            modelTotalResponseTime += response.response_time;
            modelValidRequests++;

            if (typeof response.provider_latency === 'number' && !isNaN(response.provider_latency)) {
                modelTotalProviderLatency += response.provider_latency;
                modelValidProviderResponses++;
            }

            if (response.observed_speed_tps !== undefined && response.observed_speed_tps !== null &&
                typeof response.observed_speed_tps === 'number' && !isNaN(response.observed_speed_tps) && response.observed_speed_tps > 0) {
                modelTotalSpeed += response.observed_speed_tps;
                modelValidSpeedSamples++;
            }
        } // End loop through response_times

        if (modelValidRequests > 0) {
            model.avg_response_time = Math.round((modelTotalResponseTime / modelValidRequests) * 100) / 100;
        }
        if (modelValidProviderResponses > 0) {
            model.avg_provider_latency = Math.round((modelTotalProviderLatency / modelValidProviderResponses) * 100) / 100;
        }
        if (modelValidSpeedSamples > 0) {
            model.avg_token_speed = Math.round((modelTotalSpeed / modelValidSpeedSamples) * 100) / 100;
            model.token_generation_speed = model.avg_token_speed;
        }

        // Accumulate provider totals
        totalResponseTime += modelTotalResponseTime;
        totalProviderLatency += modelTotalProviderLatency;
        validModelRequests += modelValidRequests;
        validProviderResponses += modelValidProviderResponses;
    }

    // Fallback for avg_token_speed if still null after loop
    if (model.avg_token_speed === null || model.avg_token_speed <= 0) {
        model.avg_token_speed = model.token_generation_speed; // Use initial/default
    }

  } // End loop over providerData.models

  // Update Aggregate Provider Stats
  providerData.avg_response_time = null;
  providerData.avg_provider_latency = null;

  if (validModelRequests > 0) {
    providerData.avg_response_time = Math.round((totalResponseTime / validModelRequests) * 100) / 100;
  }
  if (validProviderResponses > 0) {
    providerData.avg_provider_latency = Math.round((totalProviderLatency / validProviderResponses) * 100) / 100;
  }
}

function scoreLatencyMetric(
  avgLatencyMs: number | null | undefined,
  fastMs: number,
  slowMs: number,
  fallbackScore: number = 50
): number {
  if (typeof avgLatencyMs !== 'number' || !Number.isFinite(avgLatencyMs)) {
    return fallbackScore;
  }
  if (avgLatencyMs <= fastMs) return 100;
  if (avgLatencyMs >= slowMs) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - ((avgLatencyMs - fastMs) / (slowMs - fastMs)))));
}

function countSuccessfulProviderRequests(providerData: Provider): number {
  if (!providerData?.models) return 0;
  return Object.values(providerData.models).reduce((sum, model) => {
    return sum + (Array.isArray(model?.response_times) ? model.response_times.length : 0);
  }, 0);
}

export function calculateProviderScore(
  providerData: Provider,
  latencyWeight: number,
  errorWeight: number
): number {
  if (!providerData) return 0;

  const totalRequests = countSuccessfulProviderRequests(providerData);
  const totalErrors = Math.max(0, Number(providerData.errors ?? 0));
  const hasProviderLatency = typeof providerData.avg_provider_latency === 'number'
    && Number.isFinite(providerData.avg_provider_latency);
  const hasResponseTime = typeof providerData.avg_response_time === 'number'
    && Number.isFinite(providerData.avg_response_time);

  const providerLatencyScore = scoreLatencyMetric(providerData.avg_provider_latency, 50, 5000, 50);
  const responseTimeScore = scoreLatencyMetric(providerData.avg_response_time, 750, 12_000, 50);

  let latencyScore = 50;
  if (hasProviderLatency && hasResponseTime) {
    latencyScore = Math.round((providerLatencyScore * 0.2) + (responseTimeScore * 0.8));
  } else if (hasResponseTime) {
    latencyScore = responseTimeScore;
  } else if (hasProviderLatency) {
    latencyScore = providerLatencyScore;
  } else if (totalErrors > 0) {
    // Providers with only failures and no successful latency samples should sink quickly.
    latencyScore = 0;
  }

  let errorScore = 100;
  if (totalRequests > 0) {
    const errorRate = Math.min(1, totalErrors / totalRequests);
    errorScore = Math.max(0, 100 * (1 - errorRate));
  } else if (totalErrors > 0) {
    errorScore = 0;
  }

  const weightSum = latencyWeight + errorWeight;
  const normLatencyWeight = weightSum > 0 ? latencyWeight / weightSum : 0.5;
  const normErrorWeight = weightSum > 0 ? errorWeight / weightSum : 0.5;
  const combinedScore = (normLatencyWeight * latencyScore) + (normErrorWeight * errorScore);
  return Math.max(0, Math.min(100, Math.round(combinedScore)));
}

export function computeProviderScore(
  providerData: Provider,
  latencyWeight: number,
  errorWeight: number
): void {
  if (!providerData) return;
  providerData.provider_score = calculateProviderScore(providerData, latencyWeight, errorWeight);
}

export function applyTimeWindow(providersData: Provider[], windowInHours: number): void {
  const now = Date.now();
  const windowInMillis = windowInHours * 60 * 60 * 1000;
  const cutoffTimestamp = now - windowInMillis;

  providersData.forEach(provider => {
    if (!provider || !provider.models) return;

    for (const modelId in provider.models) {
      const model = provider.models[modelId];
      if (!model) continue;

      // Filter response_times (which now contains observed_speed_tps)
      if (Array.isArray(model.response_times)) {
        model.response_times = model.response_times.filter((response: ResponseEntry | null | undefined) => {
            return response && typeof response.timestamp === 'number' && !isNaN(response.timestamp) && response.timestamp >= cutoffTimestamp;
        });
      }
      // Removed filtering for token_speeds
    }
  });
}

// Updated exports
export { ResponseEntry, Provider };
