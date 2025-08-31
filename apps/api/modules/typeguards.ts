import { Model } from '../providers/interfaces.js';

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