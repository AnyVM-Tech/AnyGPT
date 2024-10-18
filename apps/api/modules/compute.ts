import { Provider, ResponseEntry, Model } from './interfaces'; 

export function updateProviderData(
  providerData: Provider,
  modelId: string,
  responseEntry: ResponseEntry | null,
  isError: boolean,
  tokenGenerationSpeed: number
): void {
  if (!providerData.models[modelId]) {
    providerData.models[modelId] = {
      model_id: modelId,
      token_generation_speed: tokenGenerationSpeed, 
      response_times: [],
      errors: 0,
      avg_response_time: undefined,
      avg_provider_latency: undefined,
    };
  }

  const modelData = providerData.models[modelId];

  if (isError) {
    modelData.errors += 1;
    providerData.errors = (providerData.errors || 0) + 1;
  } else if (responseEntry) {

    modelData.response_times.push(responseEntry);
  }
}


export function computeEMA(
  previousEMA: number | null | undefined,
  newValue: number,
  alpha: number
): number {
  if (previousEMA === null || previousEMA === undefined || isNaN(previousEMA)) {
    return newValue;
  }
  return alpha * newValue + (1 - alpha) * previousEMA;
}


export function computeProviderStatsWithEMA(
  providerData: Provider,
  alpha: number
): void {
  let totalResponseTime = 0;
  let totalProviderLatency = 0;
  let totalRequests = 0;
  let totalProviderResponses = 0;

  for (const modelId in providerData.models) {
    const model = providerData.models[modelId];

    const modelRequests = model.response_times.length;

    for (const response of model.response_times) {
      if (response.provider_latency === undefined) {
        const expectedTokenTime = (response.tokens_generated / model.token_generation_speed) * 1000;
        response.provider_latency = Math.max(
          response.response_time - expectedTokenTime,
          0
        );
      }

      model.avg_response_time = computeEMA(
        model.avg_response_time,
        response.response_time,
        alpha
      );

      totalResponseTime += response.response_time;

      model.avg_provider_latency = computeEMA(
        model.avg_provider_latency,
        response.provider_latency,
        alpha
      );

      totalProviderLatency += response.provider_latency;
      totalProviderResponses += 1;
    }

    totalRequests += modelRequests;
  }

  if (totalRequests > 0) {
    providerData.avg_response_time = computeEMA(
      providerData.avg_response_time,
      totalResponseTime / totalRequests,
      alpha
    );
  }

  if (totalProviderResponses > 0) {
    providerData.avg_provider_latency = computeEMA(
      providerData.avg_provider_latency,
      totalProviderLatency / totalProviderResponses,
      alpha
    );
  }
}

export function computeProviderScore(
  providerData: Provider,
  latencyWeight: number,
  errorWeight: number
): void {
  let latencyScore = 0;
  if (providerData.avg_provider_latency != null && providerData.avg_provider_latency > 0) {
    latencyScore = 1 / providerData.avg_provider_latency;
  } else {
    latencyScore = 0;
  }

  let errorScore = 1; 
  if (providerData.errors !== undefined && providerData.errors !== null && providerData.errors > 0) {
    errorScore = 1 / providerData.errors;
  } else {
    errorScore = 1;
  }

  const totalScore = latencyWeight * latencyScore + errorWeight * errorScore;

  providerData.provider_score = totalScore;
}

export function applyTimeWindow(providersData: Provider[], windowInHours: number): void {
  const now = new Date();
  providersData.forEach(provider => {
    for (const modelId in provider.models) {
      const model = provider.models[modelId];
      model.response_times = model.response_times.filter(response => {
        const hoursDifference = (now.getTime() - response.timestamp.getTime()) / (1000 * 60 * 60);
        return hoursDifference <= windowInHours;
      });
    }
  });
}

