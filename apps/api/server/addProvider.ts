import axios from 'axios';
import { dataManager, LoadedProviders } from '../modules/dataManager.js';
import { upsertProviderById } from '../modules/providerUpsert.js';
// Ensure this path is correct based on your project structure for these shared interfaces
import type { Provider, Model } from '../providers/interfaces.js';

interface AddProviderPayload {
    providerBaseUrl: string;
    apiKey?: string | null; // Payload can accept null or undefined for apiKey
    providerId: string;
}

// Define a return type that includes the potential model fetching error message
interface AddProviderResult extends Provider {
    _modelFetchError?: string | null;
}

const DEFAULT_TOKEN_SPEED = 50;

/**
 * Adds or updates a provider in providers.json by fetching its models.
 * @param payload - The provider details.
 * @returns The added or updated provider entry.
 * @throws Error if required fields are missing or if saving fails.
 */
export async function addOrUpdateProvider(payload: AddProviderPayload): Promise<AddProviderResult> {
    const { providerBaseUrl, apiKey, providerId } = payload;

    if (!providerBaseUrl || !providerBaseUrl.trim()) {
        throw new Error('providerBaseUrl is required and cannot be empty.');
    }
    if (!providerId || !providerId.trim()) {
        throw new Error('providerId is required and cannot be empty.');
    }

    let providers = await dataManager.load<LoadedProviders>('providers');
    // Ensure providers is an array, even if providers.json was empty or malformed
    if (!Array.isArray(providers)) {
        console.warn('providers.json content was not an array. Initializing with an empty array.');
        providers = [];
    }

    // 1. Fetch Models from Provider
    const modelsUrl = providerBaseUrl.replace(/\/$/, '') + '/models';
    let fetchedModels: { id: string }[] = [];
    let modelFetchError: string | null = null;

    console.log(`Attempting to fetch models from: ${modelsUrl}`);
    try {
        const response = await axios.get(modelsUrl, {
            headers: {
                ...(apiKey && { Authorization: `Bearer ${apiKey}` }), // If apiKey is null/undefined, header is not added
                'Content-Type': 'application/json',
            },
            timeout: 10000, // 10 seconds timeout
        });

        if (response.data && Array.isArray(response.data.data)) {
            fetchedModels = response.data.data
                .filter((m: any) => m && typeof m.id === 'string' && m.id.trim() !== '')
                .map((m: any) => ({ id: m.id.trim() }));
            console.log(`Successfully fetched ${fetchedModels.length} models from ${providerId}.`);
        } else {
            modelFetchError = `Could not parse models from response data. Expected { data: [{ id: 'model1' }, ...] }.`;
            console.warn(`${modelFetchError} Provider: ${providerId}, URL: ${modelsUrl}`);
        }
    } catch (error: any) {
        modelFetchError = `Error fetching models from ${modelsUrl}. Status: ${error.response?.status}. Message: ${error.message}`;
        console.error(modelFetchError);
        if (error.response?.data) {
            console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        }
        // For an API, we might not prompt but log and potentially return a partial success or error
        // Depending on desired behavior, you might throw here or allow adding provider without models.
        // For now, we'll proceed and add the provider with an empty model list if fetching fails.
    }

    // 2. Construct New Provider Entry
    const newModelsObject: { [modelId: string]: Model } = {};
    for (const model of fetchedModels) {
        if (model.id) {
            newModelsObject[model.id] = {
                id: model.id,
                token_generation_speed: DEFAULT_TOKEN_SPEED,
                response_times: [],
                errors: 0,
                consecutive_errors: 0,
                avg_response_time: null,
                avg_provider_latency: null,
                avg_token_speed: null,
            };
        }
    }

    const finalProviderUrl = providerBaseUrl.replace(/\/$/, '') + '/chat/completions';
    
    // Ensure apiKey is string | null for the Provider type
    const providerApiKey: string | null = (apiKey && apiKey.trim() !== '') ? apiKey.trim() : null;

    const newProviderEntry: Provider = {
        id: providerId,
        apiKey: providerApiKey, // Correctly assigns string or null
        provider_url: finalProviderUrl,
        models: newModelsObject,
        disabled: false,
        avg_response_time: null,
        avg_provider_latency: null,
        errors: 0,
        provider_score: null,
    };

    // 3. Add or Update Provider in the list
    // Now that interfaces are aligned, we can use the provider entry directly
    const { action } = upsertProviderById(providers as Provider[], newProviderEntry);
    console.log(`${action === 'updated' ? 'Updated' : 'Added'} provider entry with ID: ${providerId}`);

    // 4. Write Updated Data Back using dataManager
    try {
        await dataManager.save<LoadedProviders>('providers', providers);
        console.log(`Successfully saved updated provider list via dataManager.`);
    } catch (error: any) {
        console.error(`Error saving updated provider list via dataManager: ${error.message}`);
        throw new Error('Failed to save providers data.'); // Propagate error for API response
    }
    
    // Optionally, include modelFetchError in the return if you want to inform the admin
    // For now, just returning the provider entry
    return { ...newProviderEntry, _modelFetchError: modelFetchError }; // Spread to include potential error message
}

// Removed direct execution: addProvider();
// Removed readline interface and promptUser function
