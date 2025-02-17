import { DevModels, Model } from '../providers/interfaces';

export function isDevModels(data: any): data is DevModels {
  if (typeof data !== 'object' || data === null) return false;

  for (const [providerId, providerInfo] of Object.entries(data)) {
    if (
      !providerInfo ||
      typeof providerInfo !== 'object' ||
      (typeof (providerInfo as any).apiKey !== 'string' &&
      (providerInfo as any).apiKey !== null)
    ) {
      return false;
    }

    if (typeof (providerInfo as any).provider_url !== 'string') {
      return false;
    }

    if (typeof (providerInfo as any).models !== 'object' || (providerInfo as any).models === null) {
      return false;
    }

    for (const [modelId, modelInfo] of Object.entries((providerInfo as any).models)) {
      if (
        (modelInfo as any).provider_score !== undefined &&
        typeof (modelInfo as any).provider_score !== 'number' &&
        (modelInfo as any).provider_score !== null
      ) {
        return false;
      }
    }
  }

  return true;
}

export function isModel(data: any): data is Model {
  return (
    typeof data.id === 'string' &&
    typeof data.object === 'string' &&
    typeof data.created === 'number' &&
    typeof data.owned_by === 'string' &&
    typeof data.providers === 'number' &&
    typeof data.throughput === 'number'
  );
}

export function isModelsData(data: any): data is { object: string; data: Model[] } {
  if (
    typeof data !== 'object' ||
    data === null ||
    data.object !== 'list' ||
    !Array.isArray(data.data)
  ) {
    return false;
  }

  return data.data.every(isModel);
}