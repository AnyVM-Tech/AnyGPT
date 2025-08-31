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
  alpha: number
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
        let modelValidRequests = 0;
        let modelValidProviderResponses = 0;

        for (const response of model.response_times) {
            if (!response || typeof response.response_time !== 'number' || isNaN(response.response_time)) {
                continue;
            }
            // --- Calculate Response Time EMA --- 
            model.avg_response_time = computeEMA(model.avg_response_time, response.response_time, alpha);
            modelTotalResponseTime += response.response_time;
            modelValidRequests++;

            // --- Calculate Provider Latency EMA --- 
            if (typeof response.provider_latency === 'number' && !isNaN(response.provider_latency)) {
                model.avg_provider_latency = computeEMA(model.avg_provider_latency, response.provider_latency, alpha);
                modelTotalProviderLatency += response.provider_latency;
                modelValidProviderResponses++;
            } else {
                model.avg_provider_latency = computeEMA(model.avg_provider_latency, 0, alpha);
            }

            // --- Calculate Token Speed EMA (using observed_speed_tps) --- 
            if (response.observed_speed_tps !== undefined && response.observed_speed_tps !== null &&
                typeof response.observed_speed_tps === 'number' && !isNaN(response.observed_speed_tps) && response.observed_speed_tps > 0) {
                model.avg_token_speed = computeEMA(model.avg_token_speed, response.observed_speed_tps, alpha);
            }
        } // End loop through response_times

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
    providerData.avg_response_time = computeEMA(null, totalResponseTime / validModelRequests, alpha);
  }
  if (validProviderResponses > 0) {
    providerData.avg_provider_latency = computeEMA(null, totalProviderLatency / validProviderResponses, alpha);
  }
}

export function computeProviderScore(
  providerData: Provider,
  latencyWeight: number,
  errorWeight: number
): void {
  if (!providerData) return;

  let latencyScore = 50;
  const avgLatency = providerData.avg_provider_latency;
  if (avgLatency !== null && !isNaN(avgLatency)) {
    if (avgLatency <= 50) latencyScore = 100;
    else if (avgLatency > 5000) latencyScore = 0;
    else latencyScore = Math.min(100, Math.max(0, 100 * (1 - (avgLatency - 50) / (5000 - 50))));
  }

  let errorScore = 100;
  let totalRequests = 0;
  if (providerData.models) {
    totalRequests = Object.values(providerData.models).reduce((sum, model) => sum + (model?.response_times?.length || 0), 0);
  }
  const totalErrors = providerData.errors ?? 0;

  if (totalRequests > 0) {
    const errorRate = Math.min(1, totalErrors / totalRequests);
    errorScore = Math.max(0, 100 * (1 - errorRate));
  } else if (totalErrors > 0) {
    errorScore = 0;
  }

  // Normalize weights if they don't sum to 1
  const weightSum = latencyWeight + errorWeight;
  const normLatencyWeight = (weightSum > 0) ? latencyWeight / weightSum : 0.5;
  const normErrorWeight = (weightSum > 0) ? errorWeight / weightSum : 0.5;

  const combinedScore = (normLatencyWeight * latencyScore) + (normErrorWeight * errorScore);
  providerData.provider_score = Math.max(0, Math.min(100, Math.round(combinedScore)));
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
