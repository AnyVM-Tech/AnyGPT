import dotenv from 'dotenv';
import {
    IAIProvider, // Keep IAIProvider if needed for ProviderConfig
    IMessage,
    ResponseEntry,
    Provider as ProviderStateStructure,
    Model,
    ModelCapability,
} from './interfaces.js'; // Removed ModelDefinition from here
import { GeminiAI } from './gemini.js';
import { ImagenAI } from './imagen.js';
import { OpenAI } from './openai.js';
import { OpenRouterAI } from './openrouter.js';
import { DeepseekAI } from './deepseek.js';
import { computeProviderStatsWithEMA, updateProviderData, computeProviderScore, applyTimeWindow } from '../modules/compute.js';
// Import DataManager and necessary EXPORTED types
import { 
    dataManager, 
    LoadedProviders, // Import exported type
    LoadedProviderData, // Import exported type
    ModelsFileStructure, // Import exported type
    ModelDefinition // Import ModelDefinition from dataManager
} from '../modules/dataManager.js'; 
import { refreshProviderCountsInModelsFile } from '../modules/modelUpdater.js'; // Added import
// FIX: Import fs for schema loading
import * as fs from 'fs'; 
import * as path from 'path';
import Ajv from 'ajv';
import {
  validateApiKeyAndUsage, // Now async
  UserData, // Assuming this is exported from userData
  TierData, // Assuming this is exported from userData
} from '../modules/userData.js';
// Assuming updateUserTokenUsage is still needed and exported from userData
import { updateUserTokenUsage } from '../modules/userData.js'; 


dotenv.config();
const ajv = new Ajv();

// --- Paths & Schemas ---
const providersSchemaPath = path.resolve('providers.schema.json');
const modelsSchemaPath = path.resolve('models.schema.json');

let providersSchema, modelsSchema;
try {
    // Use fs directly for schema loading at startup
    providersSchema = JSON.parse(fs.readFileSync(providersSchemaPath, 'utf8'));
    modelsSchema = JSON.parse(fs.readFileSync(modelsSchemaPath, 'utf8'));
} catch (error) {
    console.error("Failed to load/parse schemas:", error); throw error;
}
const validateProviders = ajv.compile(providersSchema);
const validateModels = ajv.compile(modelsSchema);

// --- Interfaces ---
interface ProviderConfig { class: new (...args: any[]) => IAIProvider; args?: any[]; }

let providerConfigs: { [providerId: string]: ProviderConfig } = {};
let initialModelThroughputMap: Map<string, number> = new Map(); 
let modelCapabilitiesMap: Map<string, ModelCapability[]> = new Map();
let messageHandler: MessageHandler; 
let handlerDataInitialized = false; // Flag to track initialization

// --- Initialization using DataManager ---
export async function initializeHandlerData() {
    if (handlerDataInitialized) {
        console.log("Handler data already initialized. Skipping.");
        return;
    }
    console.log("Initializing handler data (first run)...");
    const modelsFileData = await dataManager.load<ModelsFileStructure>('models');
    const modelData = modelsFileData.data; 

    initialModelThroughputMap = new Map<string, number>();
    modelCapabilitiesMap = new Map<string, ModelCapability[]>();
    modelData.forEach((model: ModelDefinition) => { 
        const throughputValue = model.throughput;
        const throughput = (throughputValue != null && !isNaN(Number(throughputValue))) ? Number(throughputValue) : NaN;
        if (model.id && !isNaN(throughput)) initialModelThroughputMap.set(model.id, throughput);
        const caps = Array.isArray(model.capabilities) && model.capabilities.length > 0 ? model.capabilities as ModelCapability[] : ['text' as ModelCapability];
        modelCapabilitiesMap.set(model.id, caps);
    });

    const initialProviders = await dataManager.load<LoadedProviders>('providers');
    console.log("Initializing provider class configurations...");
    providerConfigs = {}; 
    initialProviders.forEach((p: LoadedProviderData) => { 
        const key = p.apiKey;
        const url = p.provider_url || '';
        if (!key) console.warn(`API key missing for provider config: ${p.id}. This provider may not function correctly if an API key is required and not defined in providers.json.`);

        // For Gemini we pass only the API key here; the model is injected per-request so the right modelId is used.
        if (p.id.includes('openai')) providerConfigs[p.id] = { class: OpenAI, args: [key, url] };
        else if (p.id.includes('openrouter')) providerConfigs[p.id] = { class: OpenRouterAI, args: [key, url] };
        else if (p.id.includes('deepseek')) providerConfigs[p.id] = { class: DeepseekAI, args: [key, url] };
        else if (p.id.includes('imagen')) providerConfigs[p.id] = { class: ImagenAI, args: [key] };
        else if (p.id.includes('gemini') || p.id === 'google') providerConfigs[p.id] = { class: GeminiAI, args: [key] }; 
        else providerConfigs[p.id] = { class: OpenAI, args: [key, url] }; 
    });
    console.log("Core handler components initialized.");

    messageHandler = new MessageHandler(initialModelThroughputMap, modelCapabilitiesMap);

    await refreshProviderCountsInModelsFile();
    handlerDataInitialized = true; // Set flag after successful initialization
    console.log("Handler data initialization complete.");
}

// --- Message Handler Class ---
export class MessageHandler {
    private alpha: number = 0.3; 
    private initialModelThroughputMap: Map<string, number>; 
    private modelCapabilitiesMap: Map<string, ModelCapability[]>;
    private readonly DEFAULT_GENERATION_SPEED = 50; 
    private readonly TIME_WINDOW_HOURS = 24; 
    private readonly CONSECUTIVE_ERROR_THRESHOLD = 5; // Threshold for disabling

    constructor(throughputMap: Map<string, number>, capabilitiesMap: Map<string, ModelCapability[]>) { 
        this.initialModelThroughputMap = throughputMap;
        this.modelCapabilitiesMap = capabilitiesMap;
    }

    private detectRequiredCapabilities(messages: IMessage[], modelId: string): Set<ModelCapability> {
        const required = new Set<ModelCapability>();
        messages.forEach((message) => {
            const content = message?.content as any;
            if (Array.isArray(content)) {
                content.forEach((part: any) => {
                    if (!part || typeof part !== 'object') return;
                    if (part.type === 'image_url') required.add('image_input');
                    if (part.type === 'input_audio') required.add('audio_input');
                    // If the user explicitly asks for image_output, treat as required modality
                    if (part.type === 'text' && typeof part.text === 'string' && part.text.toLowerCase().includes('[image_output]')) {
                        required.add('image_output');
                    }
                });
            }
        });

        // Heuristic: if the requested model name implies image generation, demand image_output
        const lowerModel = (modelId || '').toLowerCase();
        if (lowerModel.includes('imagen') || lowerModel.includes('image') || lowerModel.includes('vision')) {
            required.add('image_output');
        }
        return required;
    }

    private prepareCandidateProviders(
        allProvidersOriginal: LoadedProviders,
        modelId: string,
        tierLimits: TierData,
        userTierName: string
    ): LoadedProviderData[] {
        if (!allProvidersOriginal || allProvidersOriginal.length === 0) {
            throw new Error("No provider data available.");
        }

        let activeProviders = allProvidersOriginal.filter((p: LoadedProviderData) => !p.disabled);

        // If all providers are disabled, attempt a soft re-enable for providers that support the requested model.
        if (activeProviders.length === 0) {
            const disabledSupporting = allProvidersOriginal.filter((p: LoadedProviderData) => p.disabled && p.models && modelId in p.models);
            if (disabledSupporting.length > 0) {
                console.warn(`All providers disabled; temporarily re-enabling ${disabledSupporting.length} provider(s) for model ${modelId}.`);
                activeProviders = disabledSupporting.map(p => ({ ...p, disabled: false }));
            } else {
                throw new Error("All potentially compatible providers are currently disabled due to errors.");
            }
        }

        try {
            applyTimeWindow(activeProviders as ProviderStateStructure[], this.TIME_WINDOW_HOURS);
        } catch (e) {
            console.error("Error applying time window:", e);
        }

        let compatibleProviders = activeProviders.filter((p: LoadedProviderData) => p.models && modelId in p.models);
        if (compatibleProviders.length === 0) {
            const disabledSupporting = allProvidersOriginal.filter((p: LoadedProviderData) => p.disabled && p.models && modelId in p.models);
            if (disabledSupporting.length > 0) {
                console.warn(`Re-enabling ${disabledSupporting.length} disabled provider(s) for model ${modelId}.`);
                compatibleProviders = disabledSupporting.map(p => ({ ...p, disabled: false }));
            } else {
                const anyProviderHasModel = allProvidersOriginal.some((p: LoadedProviderData) => p.models && modelId in p.models);
                if (!anyProviderHasModel) {
                    throw new Error(`No provider (active or disabled) supports model ${modelId}`);
                } else {
                    throw new Error(`No currently active provider supports model ${modelId}. All supporting providers may be temporarily disabled.`);
                }
            }
        }

        const eligibleProviders = compatibleProviders.filter((p: LoadedProviderData) => {
            const score = p.provider_score;
            const minOk = tierLimits.min_provider_score === null || (score !== null && score >= tierLimits.min_provider_score);
            const maxOk = tierLimits.max_provider_score === null || (score !== null && score <= tierLimits.max_provider_score);
            return minOk && maxOk;
        });

        let candidateProviders: LoadedProviderData[] = [];
        const randomChoice = Math.random();

        if (eligibleProviders.length > 0) {
            if (userTierName === 'enterprise') {
                eligibleProviders.sort((a, b) => (b.provider_score ?? -Infinity) - (a.provider_score ?? -Infinity));
            } else if (userTierName === 'pro') {
                eligibleProviders.sort((a, b) => (b.provider_score ?? -Infinity) - (a.provider_score ?? -Infinity));
                const pickBestProbability = 0.80;
                if (randomChoice >= pickBestProbability && eligibleProviders.length > 1) {
                    const randomIndex = Math.floor(Math.random() * (eligibleProviders.length - 1)) + 1;
                    [eligibleProviders[0], eligibleProviders[randomIndex]] = [eligibleProviders[randomIndex], eligibleProviders[0]];
                }
            } else {
                eligibleProviders.sort((a, b) => (a.provider_score ?? Infinity) - (b.provider_score ?? Infinity));
                const pickWorstProbability = 0.70;
                if (randomChoice >= pickWorstProbability && eligibleProviders.length > 1) {
                    const randomIndex = Math.floor(Math.random() * (eligibleProviders.length - 1)) + 1;
                    [eligibleProviders[0], eligibleProviders[randomIndex]] = [eligibleProviders[randomIndex], eligibleProviders[0]];
                }
            }
            candidateProviders = [...eligibleProviders];
        }

        const fallbackProviders = compatibleProviders
            .filter(cp => !candidateProviders.some(cand => cand.id === cp.id))
            .sort((a, b) => (b.provider_score ?? -Infinity) - (a.provider_score ?? -Infinity));

        candidateProviders = [...candidateProviders, ...fallbackProviders];

        if (candidateProviders.length === 0) {
            throw new Error(`Could not determine any candidate providers for model ${modelId}.`);
        }

        return candidateProviders;
    }

    private validateModelCapabilities(modelId: string, messages: IMessage[]) {
        // Temporarily disable capability gating to allow all models through regardless of declared modalities.
        // This bypasses checks like audio/image support while we debug provider/model metadata.
        return;
    }
    
    private updateStatsInProviderList(providers: LoadedProviderData[], providerId: string, modelId: string, responseEntry: ResponseEntry | null, isError: boolean): LoadedProviderData[] { 
        const providerIndex = providers.findIndex(p => p.id === providerId);
        if (providerIndex === -1) return providers; 
        let providerData = providers[providerIndex]; 
        if (!providerData.models[modelId]) {
            // Initialize model data including consecutive_errors
            providerData.models[modelId] = { 
                id: modelId, 
                token_generation_speed: this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED,
                response_times: [], 
                errors: 0, 
                consecutive_errors: 0, // Initialize consecutive errors
                avg_response_time: null,
                avg_provider_latency: null,
                avg_token_speed: this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED
            };
        }
        
        // Ensure model data object exists and initialize consecutive_errors if missing for older data
        const modelData = providerData.models[modelId];
        if (modelData.consecutive_errors === undefined) {
            modelData.consecutive_errors = 0;
        }
        
        // Ensure provider data object exists and initialize disabled if missing for older data
        if (providerData.disabled === undefined) {
            providerData.disabled = false;
        }

        // Update consecutive errors and disabled status
        if (isError) {
            modelData.consecutive_errors = (modelData.consecutive_errors || 0) + 1;
            if (modelData.consecutive_errors >= this.CONSECUTIVE_ERROR_THRESHOLD) {
                if (!providerData.disabled) {
                    console.warn(`Disabling provider ${providerId} due to ${modelData.consecutive_errors} consecutive errors on model ${modelId}.`);
                    providerData.disabled = true;
                }
            }
        } else {
            // Reset consecutive errors on success for this model
            modelData.consecutive_errors = 0;
            // Re-enable provider on any model success if it was disabled
            if (providerData.disabled) {
                 console.log(`Re-enabling provider ${providerId} after successful request for model ${modelId}.`);
                 providerData.disabled = false;
            }
        }

        updateProviderData(providerData as ProviderStateStructure, modelId, responseEntry, isError); 
        computeProviderStatsWithEMA(providerData as ProviderStateStructure, this.alpha); 
        computeProviderScore(providerData as ProviderStateStructure, 0.7, 0.3); 
        return providers; 
    }

    async handleMessages(messages: IMessage[], modelId: string, apiKey: string): Promise<any> {
         if (!messages?.length || !modelId || !apiKey) throw new Error("Invalid arguments");
         if (!messageHandler) throw new Error("Service temporarily unavailable.");

            // Capability gating disabled for now (see validateModelCapabilities)

         const validationResult = await validateApiKeyAndUsage(apiKey); 
         if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
             const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
             throw new Error(`${statusCode === 429 ? 'Limit reached' : 'Unauthorized'}: ${validationResult.error}`);
         }
         const userData: UserData = validationResult.userData; 
         const tierLimits: TierData = validationResult.tierLimits; 
         const userTierName = userData.tier; 
         const allProvidersOriginal = await dataManager.load<LoadedProviders>('providers');
         const candidateProviders = this.prepareCandidateProviders(allProvidersOriginal, modelId, tierLimits, userTierName);

         // --- Attempt Loop ---
         let lastError: any = null;
         for (const selectedProvider of candidateProviders) {
             const providerId = selectedProvider.id;

            const providerConfig = providerConfigs[providerId]; 
             if (!providerConfig) {
                 console.error(`Internal config error for provider: ${providerId}. Skipping.`);
                 lastError = new Error(`Internal config error for provider: ${providerId}`);
                 continue; // Try next provider
             }

            // Inject modelId for Gemini so the SDK calls the correct model instead of a fixed default
            const args = providerConfig.args ? [...providerConfig.args] : [];
            if (providerConfig.class === GeminiAI) {
                // Ensure API key stays first arg; if missing, fall back to provider's stored key
                args[0] = args[0] ?? selectedProvider.apiKey ?? '';
                args[1] = modelId;
            }
            if (providerConfig.class === ImagenAI) {
                args[0] = args[0] ?? selectedProvider.apiKey ?? '';
                args[1] = modelId;
            }

            const providerInstance = new providerConfig.class(...args);
             const modelStats = selectedProvider.models[modelId];
             const currentTokenGenerationSpeed = modelStats?.avg_token_speed ?? this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED;
             let result: { response: string; latency: number } | null = null;
             let responseEntry: ResponseEntry | null = null; 
             let sendMessageError: any = null; // Renamed from attemptError for clarity

             try { 
                 result = await providerInstance.sendMessage({ content: messages[messages.length - 1].content, model: { id: modelId } });
                 if (result) { 
                    const inputTokens = Math.ceil(messages[messages.length - 1].content.length / 4); 
                    const outputTokens = Math.ceil(result.response.length / 4);
                    let providerLatency: number | null = null;
                    let observedSpeedTps: number | null = null;
                    const expectedGenerationTimeMs = outputTokens > 0 && currentTokenGenerationSpeed > 0 ? (outputTokens / currentTokenGenerationSpeed) * 1000 : 0;
                    if (!isNaN(expectedGenerationTimeMs) && isFinite(expectedGenerationTimeMs)) providerLatency = Math.max(0, Math.round(result.latency - expectedGenerationTimeMs));
                    if (providerLatency !== null && outputTokens > 0) {
                         const actualGenerationTimeMs = Math.max(1, result.latency - providerLatency); 
                         const calculatedSpeed = outputTokens / (actualGenerationTimeMs / 1000);
                         if (!isNaN(calculatedSpeed) && isFinite(calculatedSpeed)) observedSpeedTps = calculatedSpeed;
                    }
                    responseEntry = { timestamp: Date.now(), response_time: result.latency, input_tokens: inputTokens, output_tokens: outputTokens, tokens_generated: inputTokens + outputTokens, provider_latency: providerLatency, observed_speed_tps: observedSpeedTps, apiKey: apiKey };
                 } else { 
                    sendMessageError = new Error(`Provider ${providerId} returned null result for model ${modelId}.`); 
                 }
             } catch (error: any) { 
                console.error(`Error during sendMessage with ${providerId}/${modelId}:`, error); 
                sendMessageError = error; 
             }

             // --- Update Stats & Save (Always, regardless of attempt outcome) ---
             try {
                 let currentProvidersData = await dataManager.load<LoadedProviders>('providers');
                 const updatedProviderDataList = this.updateStatsInProviderList(
                     currentProvidersData, 
                     providerId, 
                     modelId, 
                     responseEntry, // Null if error occurred during generation or result was null
                     !!sendMessageError // isError flag based on sendMessageError
                 );
                 await dataManager.save<LoadedProviders>('providers', updatedProviderDataList); 
             } catch (statsError: any) {
                 console.error(`Error updating/saving stats for provider ${providerId}/${modelId}. Attempt outcome (sendMessageError): ${sendMessageError || 'Success'}. Stats error:`, statsError);
                 // Do not let stats error stop the loop or overwrite sendMessageError if API call failed.
                 // If API call succeeded (sendMessageError is null), but stats failed, the request is still considered successful.
             }

             // --- Handle Attempt Outcome ---
             if (!sendMessageError && result && responseEntry) {
                return { 
                    response: result.response, 
                    latency: result.latency, 
                    tokenUsage: responseEntry.tokens_generated,
                    providerId: providerId 
                };
             } else {
                 lastError = sendMessageError || new Error(`Provider ${providerId} for model ${modelId} finished in invalid state or stats update failed after success.`);
                 // Reinstate this important operational warning
                 console.warn(`Provider ${providerId} failed for model ${modelId}. Error: ${lastError.message}. Trying next provider if available...`);
             }
         } // End of loop through candidateProviders

         // If loop completes without success
         console.error(`All attempts failed for model ${modelId}. Last error: ${lastError?.message || 'Unknown error'}`);
         const detail = lastError?.message || 'All available providers failed or were unsuitable.';
         throw new Error(`Failed to process request: ${detail}`); // Surface the last provider error for debugging
    }

    async *handleStreamingMessages(messages: IMessage[], modelId: string, apiKey: string): AsyncGenerator<any, void, unknown> {
        if (!messages?.length || !modelId || !apiKey) throw new Error("Invalid arguments for streaming");
        if (!messageHandler) throw new Error("Service temporarily unavailable.");

        // Capability gating disabled for now (see validateModelCapabilities)

        const validationResult = await validateApiKeyAndUsage(apiKey);
        if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
            throw new Error(`Unauthorized: ${validationResult.error || 'Invalid key/config.'}`);
        }

        const userData: UserData = validationResult.userData;
        const tierLimits: TierData = validationResult.tierLimits;
        const userTierName = userData.tier;

        const allProvidersOriginal = await dataManager.load<LoadedProviders>('providers');
        const candidateProviders = this.prepareCandidateProviders(allProvidersOriginal, modelId, tierLimits, userTierName);

        let lastError: any = null;
        for (const selectedProviderData of candidateProviders) {
            const providerId = selectedProviderData.id;
            const providerConfig = providerConfigs[providerId];

            if (!providerConfig) {
                console.error(`Internal config error for provider: ${providerId}. Skipping.`);
                lastError = new Error(`Internal config error for provider: ${providerId}`);
                continue;
            }

            const streamArgs = providerConfig.args ? [...providerConfig.args] : [];
            if (providerConfig.class === GeminiAI) {
                streamArgs[0] = streamArgs[0] ?? selectedProviderData.apiKey ?? '';
                streamArgs[1] = modelId;
            }
            if (providerConfig.class === ImagenAI) {
                streamArgs[0] = streamArgs[0] ?? selectedProviderData.apiKey ?? '';
                streamArgs[1] = modelId;
            }

            const providerInstance = new providerConfig.class(...streamArgs);

            try {
                if (selectedProviderData.streamingCompatible && typeof providerInstance.sendMessageStream === 'function') {
                    const streamStart = Date.now();
                    const stream = providerInstance.sendMessageStream(messages[messages.length - 1]);
                    let fullResponse = '';
                    let totalLatency = 0;
                    let chunkCount = 0;

                    for await (const { chunk, latency, response } of stream) {
                        fullResponse = response;
                        totalLatency += latency || 0;
                        chunkCount++;
                        yield { type: 'chunk', chunk, latency };
                    }

                    const totalResponseTime = Date.now() - streamStart;
                    const messageContent = messages[messages.length - 1].content;
                    const contentString = typeof messageContent === 'string' ? messageContent : JSON.stringify(messageContent);
                    const inputTokens = estimateTokens(contentString);
                    const outputTokens = estimateTokens(fullResponse);

                    const modelStats = selectedProviderData.models[modelId];
                    const currentTokenGenerationSpeed = modelStats?.avg_token_speed ?? this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED;

                    let providerLatency: number | null = null;
                    let observedSpeedTps: number | null = null;

                    const expectedGenerationTimeMs = outputTokens > 0 && currentTokenGenerationSpeed > 0 ?
                        (outputTokens / currentTokenGenerationSpeed) * 1000 : 0;

                    if (!isNaN(expectedGenerationTimeMs) && isFinite(expectedGenerationTimeMs)) {
                        providerLatency = Math.max(0, Math.round(totalResponseTime - expectedGenerationTimeMs));
                    }

                    if (providerLatency !== null && outputTokens > 0) {
                        const actualGenerationTimeMs = Math.max(1, totalResponseTime - providerLatency);
                        const calculatedSpeed = outputTokens / (actualGenerationTimeMs / 1000);
                        if (!isNaN(calculatedSpeed) && isFinite(calculatedSpeed)) {
                            observedSpeedTps = calculatedSpeed;
                        }
                    }

                    const responseEntry: ResponseEntry = {
                        timestamp: Date.now(),
                        response_time: totalResponseTime,
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        tokens_generated: inputTokens + outputTokens,
                        provider_latency: providerLatency,
                        observed_speed_tps: observedSpeedTps,
                        apiKey: apiKey
                    };

                    this.updateStatsInBackground(providerId, modelId, responseEntry, false);

                    yield {
                        type: 'final',
                        tokenUsage: inputTokens + outputTokens,
                        providerId: providerId,
                        latency: totalResponseTime,
                        providerLatency: providerLatency,
                        observedSpeedTps: observedSpeedTps
                    };
                    return;
                }

                console.log(`Provider ${providerId} is not streaming compatible. Simulating stream.`);
                const result = await this.handleMessages(messages, modelId, apiKey);
                const responseText = result.response;
                const chunkSize = 5;
                for (let i = 0; i < responseText.length; i += chunkSize) {
                    const chunk = responseText.substring(i, i + chunkSize);
                    yield { type: 'chunk', chunk, latency: result.latency };
                    await new Promise(resolve => setTimeout(resolve, 2));
                }

                yield {
                    type: 'final',
                    tokenUsage: result.tokenUsage || 0,
                    providerId: result.providerId,
                    latency: result.latency
                };
                return;
            } catch (error: any) {
                this.updateStatsInBackground(providerId, modelId, null, true);
                console.warn(`Stream failed for provider ${providerId}. Error: ${error.message}. Trying next provider if available...`);
                lastError = error;
                continue;
            }
        }

        console.error(`All streaming attempts failed for model ${modelId}. Last error: ${lastError?.message || 'Unknown error'}`);
        const detail = lastError?.message || 'All available providers failed or were unsuitable.';
        throw new Error(`Failed to process streaming request: ${detail}`);
    }

    private async updateStatsInBackground(providerId: string, modelId: string, responseEntry: ResponseEntry | null, isError: boolean) {
        try {
            let currentProvidersData = await dataManager.load<LoadedProviders>('providers');
            const updatedProviderDataList = this.updateStatsInProviderList(
                currentProvidersData,
                providerId,
                modelId,
                responseEntry,
                isError
            );
            await dataManager.save<LoadedProviders>('providers', updatedProviderDataList);
        } catch (statsError: any) {
            console.error(`Error updating/saving stats in background for provider ${providerId}/${modelId}. Error:`, statsError);
        }
    }
}

function estimateTokens(text: string): number {
    return Math.ceil((text || '').length / 4);
}

export { messageHandler };
