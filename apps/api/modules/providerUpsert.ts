import type { Provider } from '../providers/interfaces.js';

interface UpsertProviderOptions {
  onUpdate?: (existing: Provider, incoming: Provider) => Provider;
}

export function upsertProviderById(
  providers: Provider[],
  provider: Provider,
  options: UpsertProviderOptions = {}
): { providers: Provider[]; action: 'added' | 'updated' } {
  const existingIdx = providers.findIndex((entry) => entry.id === provider.id);

  if (existingIdx >= 0) {
    const existing = providers[existingIdx];
    providers[existingIdx] = options.onUpdate ? options.onUpdate(existing, provider) : provider;
    return { providers, action: 'updated' };
  }

  providers.push(provider);
  return { providers, action: 'added' };
}