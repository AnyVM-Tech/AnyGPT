import { dataManager, LoadedProviders, ModelsFileStructure } from './dataManager';

/**
 * Recalculates the 'providers' count for each model in models.json based on active providers
 * in providers.json and saves the updated models.json.
 */
export async function refreshProviderCountsInModelsFile(): Promise<void> {
    console.log('Attempting to refresh provider counts in models.json...');
    try {
        // Load the current providers data
        const providersData = await dataManager.load<LoadedProviders>('providers');
        if (!providersData) {
            console.error('Failed to load providers.json for model count update.');
            return;
        }

        // Load the current models data
        const modelsFile = await dataManager.load<ModelsFileStructure>('models');
        if (!modelsFile || !modelsFile.data) {
            console.error('Failed to load models.json or it has invalid structure for count update.');
            return;
        }

        // Calculate active provider counts for each model ID
        const activeProviderCounts: { [modelId: string]: number } = {};
        for (const provider of providersData) {
            if (!provider.disabled) { // Consider a provider active if 'disabled' is false or undefined
                if (provider.models) {
                    for (const modelId in provider.models) {
                        activeProviderCounts[modelId] = (activeProviderCounts[modelId] || 0) + 1;
                    }
                }
            }
        }

        let changesMade = false;
        // Update the providers count in the models data
        for (const model of modelsFile.data) {
            const newProviderCount = activeProviderCounts[model.id] || 0;
            if (model.providers !== newProviderCount) {
                model.providers = newProviderCount;
                changesMade = true;
            }
        }

        if (changesMade) {
            await dataManager.save<ModelsFileStructure>('models', modelsFile);
            console.log('Successfully refreshed provider counts in models.json.');
        } else {
            console.log('Provider counts in models.json are already up-to-date. No changes made.');
        }

    } catch (error) {
        console.error('Error refreshing provider counts in models.json:', error);
    }
} 