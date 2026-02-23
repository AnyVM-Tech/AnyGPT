import { dataManager, LoadedProviders, LoadedProviderData } from '../modules/dataManager.js';
import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js';

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getArgValue(prefix: string, args: string[]): string | undefined {
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const modelId = getArgValue('--model=', args) ?? 'chatgpt-image-latest';
  const filterRaw = getArgValue('--provider-filter=', args) ?? getArgValue('--providers=', args);
  const dryRun = args.includes('--dry-run') || args.includes('--dry');

  const providerFilters = parseList(filterRaw);
  const defaultFilter = providerFilters.length === 0 ? ['openai'] : providerFilters;
  const loweredFilters = defaultFilter.map((f) => f.toLowerCase());

  await dataManager.waitForRedisReadyAndBackfill();
  const providers = await dataManager.load<LoadedProviders>('providers');
  if (!Array.isArray(providers)) {
    throw new Error('Invalid providers data format. Expected an array.');
  }

  let removedCount = 0;
  const touchedProviders: string[] = [];

  const shouldIncludeProvider = (providerId: string) => {
    const id = String(providerId || '').toLowerCase();
    return loweredFilters.some((f) => id.includes(f));
  };

  for (const provider of providers as LoadedProviderData[]) {
    if (!provider?.models || !provider.id) continue;
    if (!shouldIncludeProvider(provider.id)) continue;
    if (!(modelId in provider.models)) continue;
    delete provider.models[modelId];
    removedCount += 1;
    touchedProviders.push(provider.id);
  }

  if (dryRun) {
    console.log(`[dry-run] Would remove "${modelId}" from ${removedCount} provider(s).`);
    if (touchedProviders.length > 0) {
      console.log(`[dry-run] Providers: ${touchedProviders.join(', ')}`);
    }
    return;
  }

  await dataManager.save('providers', providers);
  console.log(`Removed "${modelId}" from ${removedCount} provider(s).`);
  if (touchedProviders.length > 0) {
    console.log(`Providers updated: ${touchedProviders.join(', ')}`);
  }

  await refreshProviderCountsInModelsFile();
}

main().catch((err) => {
  console.error('Failed to remove model from providers:', err);
  process.exit(1);
});
