import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js';

async function main(): Promise<void> {
  process.env.DISABLE_MODEL_SYNC = 'false';
  await refreshProviderCountsInModelsFile({ notifyProbes: false });
}

main().catch((err) => {
  console.error('Failed to refresh models.json:', err);
  process.exit(1);
});
