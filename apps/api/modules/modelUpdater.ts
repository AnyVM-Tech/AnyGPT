import { dataManager, LoadedProviders, ModelsFileStructure } from './dataManager.js';

/**
 * Guess the owner/company of a model based on its ID
 */
function guessOwnedBy(modelId: string): string {
    if (modelId.startsWith('gpt')) {
        return 'openai';
    } else if (modelId.includes('claude')) {
        return 'anthropic';
    } else if (modelId.includes('gemini') || modelId.includes('gemma')) {
        return 'google';
    } else if (modelId.includes('llama')) {
        return 'meta';
    } else if (modelId.includes('mistral') || modelId.includes('ministral') || modelId.includes('mixtral')) {
        return 'mistral.ai';
    } else if (modelId.includes('qwen')) {
        return 'alibaba';
    } else if (modelId.includes('o1')) {
        return 'openai';
    } else if (modelId.includes('command')) {
        return 'cohere';
    } else if (modelId.includes('chatgpt')) {
        return 'openai';
    } else {
        return 'unknown';
    }
}

/**
 * Enhanced model synchronization that:
 * 1. Removes models with 0 providers
 * 2. Adds new models that have at least 1 active provider
 * 3. Updates provider counts for existing models
 * 4. Removes models where their only provider is disabled or doesn't exist
 */
export async function refreshProviderCountsInModelsFile(): Promise<void> {
    console.log('Attempting to synchronize models.json with active providers...');
    try {
        // Load the current providers data
        const providersData = await dataManager.load<LoadedProviders>('providers');
        if (!providersData) {
            console.error('Failed to load providers.json for model synchronization.');
            return;
        }

        // Load the current models data
        const modelsFile = await dataManager.load<ModelsFileStructure>('models');
        if (!modelsFile || !modelsFile.data) {
            console.error('Failed to load models.json or it has invalid structure for synchronization.');
            return;
        }

        // Calculate active provider counts for each model ID
        const activeProviderCounts: { [modelId: string]: number } = {};
        const availableModelIds = new Set<string>();

        for (const provider of providersData) {
            if (!provider.disabled) { // Consider a provider active if 'disabled' is false or undefined
                if (provider.models) {
                    for (const modelId in provider.models) {
                        activeProviderCounts[modelId] = (activeProviderCounts[modelId] || 0) + 1;
                        availableModelIds.add(modelId);
                    }
                }
            }
        }

        let changesMade = false;
        const updatedModels: ModelsFileStructure['data'] = [];

        // Process existing models
        for (const model of modelsFile.data) {
            const newProviderCount = activeProviderCounts[model.id] || 0;
            
            if (newProviderCount > 0) {
                // Keep models that have at least one active provider
                if (model.providers !== newProviderCount) {
                    model.providers = newProviderCount;
                    changesMade = true;
                    console.log(`Updated provider count for ${model.id}: ${model.providers} -> ${newProviderCount}`);
                }
                updatedModels.push(model);
            } else {
                // Remove models with no active providers
                console.log(`Removing model ${model.id}: no active providers found`);
                changesMade = true;
            }
        }

        // Add new models that have active providers but aren't in models.json
        const existingModelIds = new Set(modelsFile.data.map(model => model.id));
        for (const modelId of availableModelIds) {
            if (!existingModelIds.has(modelId)) {
                const newModel = {
                    id: modelId,
                    object: "model" as const,
                    created: Date.now(),
                    owned_by: guessOwnedBy(modelId),
                    providers: activeProviderCounts[modelId]
                };
                updatedModels.push(newModel);
                console.log(`Added new model ${modelId} with ${activeProviderCounts[modelId]} provider(s), owned by: ${newModel.owned_by}`);
                changesMade = true;
            }
        }

        // Update the models file if changes were made
        if (changesMade) {
            modelsFile.data = updatedModels;
            await dataManager.save<ModelsFileStructure>('models', modelsFile);
            console.log(`Successfully synchronized models.json. Total models: ${updatedModels.length}`);
        } else {
            console.log('Models in models.json are already synchronized with active providers. No changes made.');
        }

    } catch (error) {
        console.error('Error synchronizing models.json with providers:', error);
    }
}