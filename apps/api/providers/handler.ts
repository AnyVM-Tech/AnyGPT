import dotenv from 'dotenv';
// Import interfaces (excluding TokenSpeedEntry)
import { IAIProvider, IMessage, ResponseEntry, Provider, Model, DevModels, ModelDefinition } from './interfaces';
import { GeminiAI } from './gemini';
import { OpenAI } from './openai';
import { computeEMA, computeProviderStatsWithEMA, updateProviderData, computeProviderScore, applyTimeWindow } from '../modules/compute';
import redis from '../modules/db';
import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import { isDevModels } from '../modules/typeguards';

dotenv.config();

const ajv = new Ajv();

// --- Load Schemas ---
let providersSchema, modelsSchema;
try {
    providersSchema = JSON.parse(fs.readFileSync(path.resolve('../api/providers.schema.json'), 'utf8'));
    modelsSchema = JSON.parse(fs.readFileSync(path.resolve('../api/models.schema.json'), 'utf8'));
} catch (error) {
    console.error("Failed to load or parse JSON schemas:", error);
    throw new Error("Could not load necessary JSON schemas.");
}

// TODO: Update providers.schema.json to include observed_speed_tps in ResponseEntry and avg_token_speed in Model
const validateProviders = ajv.compile(providersSchema);
const validateModels = ajv.compile(modelsSchema);

// --- Data Loading and Validation Types/Interfaces ---
interface ModelsFileStructure {
  object: string;
  data: ModelDefinition[];
}

function isModelsFileStructure(data: any): data is ModelsFileStructure {
    return (
        typeof data === 'object' && data !== null && data.object === 'list' &&
        Array.isArray(data.data) &&
        data.data.every((item: any) => typeof item === 'object' && item !== null && typeof item.id === 'string')
    );
}

// --- Data Loading Function ---
async function loadInitialData(): Promise<{ initialProviderData: DevModels; modelData: ModelDefinition[] }> {
    let parsedProviderData: any;
    let parsedModels: any;

    // Try Redis
    if (redis) {
        try {
            const [providerDataStr, modelsDataStr] = await Promise.all([
                redis.get('providers'),
                redis.get('models'),
            ]);

            if (providerDataStr && modelsDataStr) {
                console.log("Loading data from Redis...");
                parsedProviderData = JSON.parse(providerDataStr);
                parsedModels = JSON.parse(modelsDataStr);

                // Validate (use updated schema for providers)
                if (!validateProviders(parsedProviderData)) { // Needs updated schema
                    console.error('Redis providers data validation failed:', validateProviders.errors);
                    throw new Error('Invalid providers data format in Redis');
                }
                if (!Array.isArray(parsedProviderData)) {
                    console.error('Loaded provider data from Redis is not an array.');
                    throw new Error('Provider data from Redis must be an array.');
                }
                if (!validateModels(parsedModels) || !isModelsFileStructure(parsedModels)) {
                    console.error('Redis models data validation failed:', validateModels.errors);
                    throw new Error('Invalid models data format in Redis');
                }
                console.log("Redis data loaded and validated successfully.");
                return { initialProviderData: parsedProviderData, modelData: parsedModels.data };
            }
            console.log("Data not found in Redis or incomplete.");
        } catch (err) {
            console.error('Error reading or parsing data from Redis:', err);
        }
    }

    // Fallback to Filesystem
    console.log("Falling back to loading data from filesystem...");
    const providersPath = path.resolve('../api/providers.json');
    const modelsPath = path.resolve('../api/models.json');

    try {
        const rawProviderData = fs.readFileSync(providersPath, 'utf8');
        const rawModels = fs.readFileSync(modelsPath, 'utf8');
        parsedProviderData = JSON.parse(rawProviderData);
        parsedModels = JSON.parse(rawModels);

        // Validate
        if (!validateProviders(parsedProviderData)) { // Needs updated schema
            console.error('Filesystem providers.json validation failed:', validateProviders.errors);
            throw new Error('Invalid providers.json format');
        }
        if (!Array.isArray(parsedProviderData)) {
            console.error('Loaded provider data from providers.json is not an array.');
            throw new Error('Provider data from providers.json must be an array.');
        }
        if (!validateModels(parsedModels) || !isModelsFileStructure(parsedModels)) {
            console.error('Filesystem models.json validation failed:', validateModels.errors);
            throw new Error('Invalid models.json format');
        }
        console.log("Filesystem data loaded and validated successfully.");
        return { initialProviderData: parsedProviderData, modelData: parsedModels.data };
    } catch (err: any) {
        // Handle providers.json not found
        if (err.code === 'ENOENT' && err.path === providersPath) {
             console.warn(`Warning: ${providersPath} not found. Starting with empty provider state.`);
             try {
                 const rawModels = fs.readFileSync(modelsPath, 'utf8');
                 parsedModels = JSON.parse(rawModels);
                 if (!validateModels(parsedModels) || !isModelsFileStructure(parsedModels)) {
                     throw new Error('Invalid models.json format');
                 }
                 return { initialProviderData: [], modelData: parsedModels.data };
             } catch (modelsErr) {
                  console.error('CRITICAL: Failed to load models.json:', modelsErr);
                  throw new Error('Failed to load required models data.');
             }
        } else {
            console.error('Error reading or parsing data from filesystem JSON files:', err);
            throw new Error('Failed to load required initial data.');
        }
    }
}

// --- Initialize Data on Startup ---
let initialProviderData: DevModels;
let modelData: ModelDefinition[];
try {
    const loadedData = await loadInitialData();
    initialProviderData = loadedData.initialProviderData;
    modelData = loadedData.modelData;
    console.log("Data initialization complete.");
} catch (error) {
    console.error("CRITICAL: Failed to initialize application data.", error);
    process.exit(1);
}

// --- Provider Configuration --- //
interface ProviderConfig {
    class: new (...args: any[]) => IAIProvider;
    args?: any[];
}

const providerConfigs: { [provider: string]: ProviderConfig } = {};
if (initialProviderData) {
    if (!Array.isArray(initialProviderData)) {
        console.error("CRITICAL: initialProviderData is not an array after loading!");
        process.exit(1);
    }

    for (const providerEntry of initialProviderData) {
        const providerId = providerEntry.id;
        const providerUrl = providerEntry.provider_url || '';
        const apiKey = providerEntry.apiKey;

        // Basic check for OpenAI-like providers (can be refined)
        if (providerId.includes('openai') || providerUrl.includes('openai')) {
             // Use OpenAI class for OpenAI and compatible endpoints
             providerConfigs[providerId] = {
                 class: OpenAI,
                 args: [apiKey, providerUrl], // Pass both key and URL
             };
             console.log(`Configured OpenAI/Compatible provider: ${providerId}`);
        } else if (providerId === 'google' || providerId.includes('gemini')) {
             // Use Gemini class for Google providers
             // Extract model ID from providerId if needed (e.g., 'gemini-1.5-pro')
             // For simplicity, assuming a default or that model is handled elsewhere for now
             const modelName = providerId.includes('gemini-') ? providerId : 'gemini-pro'; // Example extraction
             providerConfigs[providerId] = {
                 class: GeminiAI,
                 args: [apiKey || process.env.GEMINI_API_KEY || '', modelName],
             };
            console.log(`Configured Gemini provider: ${providerId} (Model: ${modelName})`);
        } else {
            console.warn(`No specific configuration mapping found for provider ID: ${providerId}. Attempting generic OpenAI config.`);
            // Fallback for unknown providers - attempt OpenAI config
            providerConfigs[providerId] = {
                class: OpenAI,
                args: [apiKey, providerUrl],
            };
        }
    }
}

// --- Main Message Handler Class --- //
export class MessageHandler {
    private providerDataMap: { [providerId: string]: Provider } = {};
    private alpha: number = 0.3; // EMA smoothing factor
    private initialModelThroughputMap: Map<string, number> = new Map(); // Store static throughput
    private readonly DEFAULT_GENERATION_SPEED = 50; // Default tokens/sec
    private readonly TIME_WINDOW_HOURS = 24; // Data retention window
    private saveInterval: NodeJS.Timeout | null = null;

    constructor(initialData: DevModels, modelDefs: ModelDefinition[]) {
        console.log("Initializing MessageHandler...");

        this.initializeInitialThroughputMap(modelDefs);
        console.log('Initial throughput map populated.');

        if (!Array.isArray(initialData)) {
            console.error("MessageHandler received non-array initialData. Setting to empty.");
            initialData = [];
        }

        for (const providerEntry of initialData) {
            const providerId = providerEntry.id;
            this.providerDataMap[providerId] = {
                ...providerEntry, // Spread existing provider data
                models: this.initializeModelsRuntimeState(providerEntry.models), // Initialize models
            };
        }
        console.log("Provider data map initialized from state.");
        this.cleanupOldData();
    }

    private initializeInitialThroughputMap(modelDefs: ModelDefinition[]): void {
        if (!modelDefs) return;
        console.log(`Initializing static throughput map with ${modelDefs.length} model definitions.`);
        modelDefs.forEach((model: ModelDefinition) => {
            const throughput = model.throughput !== undefined ? Number(model.throughput) : NaN;
            if (model.id && !isNaN(throughput) && throughput > 0) {
                this.initialModelThroughputMap.set(model.id, throughput);
            }
        });
    }

    private initializeModelsRuntimeState(savedModelsState: { [modelId: string]: any } | undefined): { [modelId: string]: Model } {
        const runtimeModels: { [modelId: string]: Model } = {};
        if (!savedModelsState || typeof savedModelsState !== 'object') {
            return runtimeModels;
        }

        for (const modelId in savedModelsState) {
            const savedModelData = savedModelsState[modelId];
            const initialSpeed = this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED;

            runtimeModels[modelId] = {
                id: modelId,
                token_generation_speed: savedModelData?.avg_token_speed ?? initialSpeed,
                response_times: Array.isArray(savedModelData?.response_times) ? savedModelData.response_times : [],
                // Removed token_speeds initialization
                errors: typeof savedModelData?.errors === 'number' ? savedModelData.errors : 0,
                avg_response_time: savedModelData?.avg_response_time ?? null,
                avg_provider_latency: savedModelData?.avg_provider_latency ?? null,
                avg_token_speed: savedModelData?.avg_token_speed ?? null,
            };
        }
        return runtimeModels;
    }

    private getCurrentTokenGenerationSpeed(providerId: string, modelId: string): number {
        const modelData = this.providerDataMap[providerId]?.models?.[modelId];
        if (modelData?.avg_token_speed && modelData.avg_token_speed > 0) {
            return modelData.avg_token_speed;
        }
        if (this.initialModelThroughputMap.has(modelId)) {
            return this.initialModelThroughputMap.get(modelId)!;
        }
        return this.DEFAULT_GENERATION_SPEED;
    }

    private updateAndRecalculate(providerId: string, modelId: string, responseEntry: ResponseEntry | null, isError: boolean): void {
        const providerData = this.providerDataMap[providerId];
        if (!providerData) {
            console.error(`Cannot update data: Provider ${providerId} not found.`);
            return;
        }

        if (!providerData.models[modelId]) {
            const initialSpeed = this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED;
            console.log(`Initializing model ${modelId} in provider ${providerData.id} runtime state.`);
            providerData.models[modelId] = {
                id: modelId,
                token_generation_speed: initialSpeed,
                response_times: [],
                // No token_speeds here
                errors: 0,
                avg_response_time: null,
                avg_provider_latency: null,
                avg_token_speed: null,
            };
        }

        // Pass only responseEntry (no speedEntry)
        updateProviderData(providerData, modelId, responseEntry, isError);

        // Recalculate stats (will use observed_speed_tps from responseEntry)
        computeProviderStatsWithEMA(providerData, this.alpha);

        const modelRuntime = providerData.models[modelId];
        if (modelRuntime && modelRuntime.avg_token_speed && modelRuntime.avg_token_speed > 0) {
            modelRuntime.token_generation_speed = modelRuntime.avg_token_speed;
        }

        computeProviderScore(providerData, 0.7, 0.3);

        console.log(`Provider ${providerId} model ${modelId} stats updated. New Score: ${providerData.provider_score}, Avg Speed: ${modelRuntime?.avg_token_speed?.toFixed(2)} Tps`);
    }

    private cleanupOldData(): void {
        console.log(`Applying time window of ${this.TIME_WINDOW_HOURS} hours to response data...`);
        const providers = Object.values(this.providerDataMap);
        applyTimeWindow(providers, this.TIME_WINDOW_HOURS); // applyTimeWindow will only handle response_times
        console.log("Time window cleanup complete.");
    }

    private async saveRuntimeState(): Promise<void> {
        if (Object.keys(this.providerDataMap).length === 0) {
            console.warn("Attempted to save empty providerDataMap. Skipping save.");
            return;
        }

        const stateToSave: DevModels = Object.values(this.providerDataMap);
        console.log("Preparing to save runtime state...");
        // if (!validateProviders(stateToSave)) { // Schema needs update
        //     console.error("Runtime state validation failed before saving:", validateProviders.errors);
        // }
        const stateString = JSON.stringify(stateToSave, null, 2);
        if (redis) {
            try {
                await redis.set('providers', stateString);
                console.log("Runtime provider state saved to Redis.");
            } catch (err) {
                console.error('Error writing runtime state to Redis:', err);
            }
        } else {
            try {
                const providersPath = path.resolve('../api/providers.json');
                fs.writeFileSync(providersPath, stateString, 'utf8');
                console.log("Runtime provider state saved to providers.json.");
            } catch (err) {
                console.error('Error writing runtime state to providers.json:', err);
            }
        }
    }

    private selectBestProviderSync(modelId: string): { providerId: string; providerConfig: ProviderConfig } {
        let bestProviderId: string | null = null;
        let highestScore = -Infinity;
        const eligibleProviders: { id: string; score: number | null }[] = [];
        console.log(`Selecting best provider synchronously for model: ${modelId}`);

        for (const providerId in this.providerDataMap) {
            const providerData = this.providerDataMap[providerId];
            if (providerData.models && modelId in providerData.models) {
                const model = providerData.models[modelId];
                if (!model) continue;

                const currentScore = providerData.provider_score;
                eligibleProviders.push({ id: providerId, score: currentScore });
                console.log(`Provider ${providerId} eligible. Current score: ${currentScore ?? 'N/A'}`);
                if (currentScore !== null && !isNaN(currentScore) && currentScore > highestScore) {
                    highestScore = currentScore;
                    bestProviderId = providerId;
                }
            }
        }
        console.log(`Eligible Providers: ${eligibleProviders.map(p => `${p.id}(${p.score ?? 'N/A'})`).join(', ')}`);

        if (!bestProviderId) {
            if (eligibleProviders.length === 0) {
                throw new Error(`No provider found supporting model ${modelId}`);
            }
            const randomIndex = Math.floor(Math.random() * eligibleProviders.length);
            bestProviderId = eligibleProviders[randomIndex].id;
            console.log(`No best provider by score, randomly selected: ${bestProviderId}`);
        }
        console.log(`Best Provider Selected: ${bestProviderId} (Score: ${highestScore > -Infinity ? highestScore : 'N/A'})`);

        const providerConfig = providerConfigs[bestProviderId];
        if (!providerConfig) {
            console.error('CRITICAL: Provider config missing for selected provider ID:', bestProviderId);
            console.error('Available configs:', providerConfigs);
            throw new Error(`Internal configuration error for provider: ${bestProviderId}`);
        }
        return { providerId: bestProviderId, providerConfig };
    }

    // Updated signature to accept apiKey
    async handleMessages(messages: IMessage[], modelId: string, apiKey: string): Promise<any> {
        if (!messages || messages.length === 0 || !messages[messages.length - 1]?.content) {
            throw new Error("Invalid messages array or empty content.");
        }
        if (!modelId) {
            throw new Error("Model ID must be provided.");
        }
        console.log(`Handling message for model: ${modelId} (API Key: ${apiKey ? 'Provided' : 'Missing'})`); // Log API Key presence

        const { providerId, providerConfig } = this.selectBestProviderSync(modelId);
        console.log(`Using provider: ${providerId} for model ${modelId}`);

        const providerInstance = new providerConfig.class(...(providerConfig.args || []));
        const currentTokenGenerationSpeed = this.getCurrentTokenGenerationSpeed(providerId, modelId);
        console.log(`Using current estimated token generation speed: ${currentTokenGenerationSpeed.toFixed(2)} Tps for ${modelId}`);

        let result: { response: string; latency: number } | null = null;
        let errorOccurred: any = null;

        try {
            result = await providerInstance.sendMessage({
                content: messages[messages.length - 1].content,
                model: { id: modelId },
            });
            console.log(`Received response from ${providerId}. Latency: ${result.latency}ms`);
        } catch (error: any) {
            console.error(`Error during sendMessage with ${providerId}:`, error);
            errorOccurred = error;
        }

        let responseEntry: ResponseEntry | null = null;

        if (result) {
            const inputContent = messages[messages.length - 1].content;
            const inputTokens = Math.ceil(inputContent.length / 4);
            const outputTokens = Math.ceil(result.response.length / 4);
            const totalTokens = inputTokens + outputTokens;
            let providerLatency: number | null = null;
            let observedSpeedTps: number | null = null;

            const expectedGenerationTimeMs = outputTokens > 0 ? (outputTokens / currentTokenGenerationSpeed) * 1000 : 0;
            if (!isNaN(expectedGenerationTimeMs) && isFinite(expectedGenerationTimeMs)) {
                providerLatency = Math.max(0, Math.round(result.latency - expectedGenerationTimeMs));
            }

            if (providerLatency !== null && outputTokens > 0) {
                const actualGenerationTimeMs = Math.max(1, result.latency - providerLatency);
                const calculatedSpeed = outputTokens / (actualGenerationTimeMs / 1000);
                if (!isNaN(calculatedSpeed) && isFinite(calculatedSpeed)) {
                    observedSpeedTps = calculatedSpeed;
                    console.log(`Observed speed for ${modelId}: ${observedSpeedTps.toFixed(2)} Tps`);
                }
            }

            responseEntry = {
                timestamp: Date.now(),
                response_time: result.latency,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                tokens_generated: totalTokens,
                provider_latency: providerLatency,
                observed_speed_tps: observedSpeedTps,
                apiKey: apiKey // Include the user's API key
            };
        }

        // Pass only responseEntry to update/recalculate
        this.updateAndRecalculate(providerId, modelId, responseEntry, !!errorOccurred);

        try {
            await this.saveRuntimeState();
        } catch (saveError) {
            console.error("Error saving runtime state after request:", saveError);
        }

        if (errorOccurred) {
            throw new Error(`Provider ${providerId} failed: ${errorOccurred.message}`);
        } else if (result && responseEntry) {
            return {
                response: result.response,
                latency: result.latency,
                tokenUsage: responseEntry.tokens_generated,
                providerId: providerId,
            };
        } else {
            throw new Error(`Provider ${providerId} returned no result or error.`);
        }
    }
}

export const messageHandler = new MessageHandler(initialProviderData, modelData);
