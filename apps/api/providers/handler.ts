import dotenv from 'dotenv';
import {
    IAIProvider, // Keep IAIProvider if needed for ProviderConfig
    IMessage,
    ResponseEntry,
    Provider as ProviderStateStructure,
    Model,
    ModelCapability,
    ProviderResponse,
    ProviderUsage,
} from './interfaces.js'; // Removed ModelDefinition from here
import { GeminiAI } from './gemini.js';
import { ImagenAI } from './imagen.js';
import { OpenAI } from './openai.js';
import { OpenRouterAI } from './openrouter.js';
import { DeepseekAI } from './deepseek.js';
import { updateProviderData, applyTimeWindow } from '../modules/compute.js';
import { computeProviderMetricsInWorker } from '../modules/workerPool.js';
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
import { isExcludedError } from '../modules/errorExclusion.js';


dotenv.config();
const ajv = new Ajv();

const AUTO_DISABLE_PROVIDERS = process.env.DISABLE_PROVIDER_AUTO_DISABLE !== 'true';
const TTFT_INPUT_TOKENS_WEIGHT = (() => {
    const raw = process.env.TTFT_INPUT_TOKENS_WEIGHT;
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
})();
const TTFT_OUTPUT_TOKENS_WEIGHT = (() => {
    const raw = process.env.TTFT_OUTPUT_TOKENS_WEIGHT;
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
})();
const NON_STREAM_MIN_GENERATION_WINDOW_MS = (() => {
    const raw = process.env.NON_STREAM_MIN_GENERATION_WINDOW_MS;
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
})();
const NON_STREAM_MIN_TTFT_MS = (() => {
    const raw = process.env.NON_STREAM_MIN_TTFT_MS;
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 25;
})();
const STREAM_MIN_GENERATION_WINDOW_MS = (() => {
    const raw = process.env.STREAM_MIN_GENERATION_WINDOW_MS;
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
})();

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
        const caps = Array.isArray(model.capabilities) ? model.capabilities as ModelCapability[] : [];
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
    private readonly DISABLE_PROVIDER_AFTER_MODELS = (() => {
        const raw = process.env.DISABLE_PROVIDER_AFTER_MODELS;
        const parsed = raw !== undefined ? Number(raw) : NaN;
        if (!Number.isFinite(parsed) || parsed < 1) return 2;
        return Math.floor(parsed);
    })();
    private modelCapabilitiesLastUpdated = 0;
    private readonly MODEL_CAPS_REFRESH_MS = Math.max(1000, Number(process.env.MODEL_CAPS_REFRESH_MS ?? 5000));

    private normalizeModelId(modelId: string): string {
        return String(modelId || '').toLowerCase().replace(/^google\//, '');
    }

    private shouldUseImagenProvider(providerId: string, modelId: string): boolean {
        const normalizedModelId = this.normalizeModelId(modelId);
        const isGoogleFamilyProvider = providerId.includes('gemini') || providerId === 'google' || providerId.includes('imagen');
        const isImagenFamilyModel = normalizedModelId.startsWith('imagen-') || normalizedModelId.startsWith('nano-banana');
        return isGoogleFamilyProvider && isImagenFamilyModel;
    }

    private isInvalidProviderCredentialError(error: any): boolean {
        const message = String(error?.message || error || '').toLowerCase();
        if (!message) return false;

        return (
            message.includes('api_key_invalid') ||
            message.includes('api key not found') ||
            message.includes('invalid api key') ||
            message.includes('invalid authentication') ||
            message.includes('incorrect api key') ||
            message.includes('unauthorized')
        );
    }

    private isModelAccessError(error: any): boolean {
        const message = String(error?.message || error || '').toLowerCase();
        return (
            message.includes('does not have access to model') ||
            message.includes('model_not_found') ||
            message.includes('no gemini model available') ||
            message.includes('not found for api version')
        );
    }

    private isInsufficientCreditsError(error: any): boolean {
        const message = String(error?.message || error || '').toLowerCase();
        if (!message) return false;
        return (
            message.includes('requires more credits') ||
            message.includes('insufficient credits') ||
            message.includes('can only afford') ||
            message.includes('payment required') ||
            message.includes('status 402')
        );
    }

    private getProviderFamilyId(providerId: string): string {
        const normalized = String(providerId || '').toLowerCase();
        const dashIndex = normalized.indexOf('-');
        return dashIndex > 0 ? normalized.slice(0, dashIndex) : normalized;
    }

    private providerSkipsRequiredCaps(
        provider: LoadedProviderData,
        modelId: string,
        required: Set<ModelCapability>
    ): boolean {
        if (!required || required.size === 0) return false;
        const modelData = provider.models?.[modelId];
        const skips = (modelData as any)?.capability_skips as Partial<Record<ModelCapability, string>> | undefined;
        if (!skips) return false;
        for (const cap of required) {
            if (skips[cap]) return true;
        }
        return false;
    }

    private appendCreditFallbackProviders(
        allProviders: LoadedProviders,
        candidateProviders: LoadedProviderData[],
        selectedProvider: LoadedProviderData,
        modelId: string,
        required: Set<ModelCapability>,
        triedProviderIds: Set<string>
    ): number {
        const targetUrl = selectedProvider.provider_url;
        const targetFamily = this.getProviderFamilyId(selectedProvider.id);
        let added = 0;

        for (const provider of allProviders) {
            if (!provider?.models?.[modelId]) continue;
            if (triedProviderIds.has(provider.id)) continue;
            if (candidateProviders.some((cand) => cand.id === provider.id)) continue;
            const modelData = provider.models?.[modelId] as any;
            const isDisabled = Boolean(provider.disabled || modelData?.disabled);
            if (!isDisabled) continue;
            if (this.providerSkipsRequiredCaps(provider, modelId, required)) continue;

            const sameUrl = targetUrl && provider.provider_url === targetUrl;
            const sameFamily = this.getProviderFamilyId(provider.id) === targetFamily;
            if (!sameUrl && !sameFamily) continue;

            candidateProviders.push(provider);
            added += 1;
        }

        return added;
    }

    private normalizeUsage(usage: ProviderUsage | undefined, fallbackInput: number, fallbackOutput: number) {
        let inputTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : fallbackInput;
        let outputTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : fallbackOutput;
        const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : undefined;

        if (totalTokens !== undefined && !Number.isNaN(totalTokens)) {
            if (typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens !== 'number') {
                outputTokens = Math.max(0, totalTokens - inputTokens);
            } else if (typeof usage?.completion_tokens === 'number' && typeof usage?.prompt_tokens !== 'number') {
                inputTokens = Math.max(0, totalTokens - outputTokens);
            } else if (typeof usage?.prompt_tokens !== 'number' && typeof usage?.completion_tokens !== 'number') {
                outputTokens = Math.max(0, totalTokens - inputTokens);
            }
        }

        return {
            inputTokens: Math.max(0, Math.round(inputTokens)),
            outputTokens: Math.max(0, Math.round(outputTokens)),
        };
    }

    constructor(throughputMap: Map<string, number>, capabilitiesMap: Map<string, ModelCapability[]>) { 
        this.initialModelThroughputMap = throughputMap;
        this.modelCapabilitiesMap = capabilitiesMap;
    }

    private async refreshModelCapabilities(): Promise<void> {
        const now = Date.now();
        if (this.modelCapabilitiesMap.size > 0 && (now - this.modelCapabilitiesLastUpdated) < this.MODEL_CAPS_REFRESH_MS) {
            return;
        }
        const modelsFileData = await dataManager.load<ModelsFileStructure>('models');
        const modelData = modelsFileData.data || [];
        const nextMap = new Map<string, ModelCapability[]>();
        modelData.forEach((model: ModelDefinition) => {
            const caps = Array.isArray(model.capabilities) ? model.capabilities as ModelCapability[] : [];
            if (model.id) nextMap.set(model.id, caps);
        });
        this.modelCapabilitiesMap = nextMap;
        this.modelCapabilitiesLastUpdated = now;
    }

    private ensureProviderConfig(providerId: string, providerData: LoadedProviderData): ProviderConfig | null {
        const existing = providerConfigs[providerId];
        if (existing) return existing;

        const key = providerData.apiKey ?? '';
        const url = providerData.provider_url || '';
        let config: ProviderConfig;

        if (providerId.includes('openai')) config = { class: OpenAI, args: [key, url] };
        else if (providerId.includes('openrouter')) config = { class: OpenRouterAI, args: [key, url] };
        else if (providerId.includes('deepseek')) config = { class: DeepseekAI, args: [key, url] };
        else if (providerId.includes('imagen')) config = { class: ImagenAI, args: [key] };
        else if (providerId.includes('gemini') || providerId === 'google') config = { class: GeminiAI, args: [key] };
        else config = { class: OpenAI, args: [key, url] };

        providerConfigs[providerId] = config;
        console.warn(`Provider config missing for ${providerId}; created on demand.`);
        return config;
    }

    private detectRequiredCapabilities(messages: IMessage[], modelId: string): Set<ModelCapability> {
        const required = new Set<ModelCapability>();
        messages.forEach((message) => {
            const content = message?.content as any;
            if (Array.isArray(content)) {
                content.forEach((part: any) => {
                    if (!part || typeof part !== 'object') return;
                    if (part.type === 'image_url' || part.type === 'input_image') required.add('image_input');
                    if (part.type === 'input_audio') required.add('audio_input');
                    // If the user explicitly asks for image_output, treat as required modality
                    if (part.type === 'text' && typeof part.text === 'string' && part.text.toLowerCase().includes('[image_output]')) {
                        required.add('image_output');
                    }
                });
            }
            const modalities = Array.isArray(message?.modalities) ? message.modalities.map((m) => String(m).toLowerCase()) : [];
            if (modalities.includes('image')) required.add('image_output');
            if (modalities.includes('audio')) required.add('audio_output');
            if (message?.audio) required.add('audio_output');
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

        let compatibleProviders = activeProviders.filter((p: LoadedProviderData) => {
            const modelData = p.models?.[modelId];
            return Boolean(modelData && !(modelData as any).disabled);
        });
        if (compatibleProviders.length === 0) {
            const disabledSupporting = allProvidersOriginal.filter((p: LoadedProviderData) => p.disabled && p.models && modelId in p.models);
            if (disabledSupporting.length > 0) {
                console.warn(`Re-enabling ${disabledSupporting.length} disabled provider(s) for model ${modelId}.`);
                compatibleProviders = disabledSupporting
                    .map(p => ({ ...p, disabled: false }))
                    .filter((p: LoadedProviderData) => {
                        const modelData = p.models?.[modelId];
                        return Boolean(modelData && !(modelData as any).disabled);
                    });
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
        const caps = modelCapabilitiesMap.get(modelId) || [];
        if (caps.length === 0) return;
        const required = this.detectRequiredCapabilities(messages, modelId);
        const missing = Array.from(required).filter((cap) => !caps.includes(cap));
        if (missing.length > 0) {
            throw new Error(`Model ${modelId} missing required capabilities: ${missing.join(', ')}`);
        }
    }

    private filterProvidersByCapabilitySkips(
        providers: LoadedProviderData[],
        modelId: string,
        required: Set<ModelCapability>
    ): LoadedProviderData[] {
        if (!required || required.size === 0) return providers;
        return providers.filter((provider) => {
            const modelData = provider.models?.[modelId];
            if ((modelData as any)?.disabled) return false;
            const skips = (modelData as any)?.capability_skips as Partial<Record<ModelCapability, string>> | undefined;
            if (!skips) return true;
            for (const cap of required) {
                if (skips[cap]) return false;
            }
            return true;
        });
    }
    
    private async updateStatsInProviderList(
        providers: LoadedProviderData[],
        providerId: string,
        modelId: string,
        responseEntry: ResponseEntry | null,
        isError: boolean,
        attemptError?: any
    ): Promise<LoadedProviderData[]> {
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
                avg_token_speed: this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED,
                disabled: false
            };
        }
        
        // Ensure model data object exists and initialize consecutive_errors if missing for older data
        const modelData = providerData.models[modelId];
        if (modelData.consecutive_errors === undefined) {
            modelData.consecutive_errors = 0;
        }
        if (modelData.disabled === undefined) {
            modelData.disabled = false;
        }
        
        // Ensure provider data object exists and initialize disabled if missing for older data
        if (providerData.disabled === undefined) {
            providerData.disabled = false;
        }

        // Update consecutive errors and disabled status
        if (isError) {
            // Remove model from provider if error indicates permanent access denial
            if (this.isModelAccessError(attemptError)) {
                console.warn(`Removing model ${modelId} from provider ${providerId} due to permanent access restriction (Error: ${attemptError?.message || 'unknown'}).`);
                delete providerData.models[modelId];
                // Return immediately without incrementing errors or disabling provider
                return providers;
            }

            // Skip error counting entirely for excluded error patterns
            if (isExcludedError(attemptError)) {
                // Don't increment errors or disable — treat as a non-event
            } else if (AUTO_DISABLE_PROVIDERS && this.isInvalidProviderCredentialError(attemptError)) {
                if (!providerData.disabled) {
                    console.warn(`Disabling provider ${providerId} due to invalid provider credentials.`);
                }
                providerData.disabled = true;
                modelData.consecutive_errors = this.CONSECUTIVE_ERROR_THRESHOLD;
            } else {
                modelData.consecutive_errors = (modelData.consecutive_errors || 0) + 1;
                if (modelData.consecutive_errors >= this.CONSECUTIVE_ERROR_THRESHOLD) {
                    if (!modelData.disabled) {
                        console.warn(`Disabling model ${modelId} in provider ${providerId} after ${modelData.consecutive_errors} consecutive errors.`);
                    }
                    modelData.disabled = true;

                    if (AUTO_DISABLE_PROVIDERS) {
                        const disabledModels = Object.values(providerData.models || {}).filter((m: any) => m?.disabled).length;
                        if (disabledModels >= this.DISABLE_PROVIDER_AFTER_MODELS && !providerData.disabled) {
                            console.warn(`Disabling provider ${providerId} after ${disabledModels} models were disabled due to consecutive errors.`);
                            providerData.disabled = true;
                        }
                    }
                }
            }
        } else {
            // Reset consecutive errors on success for this model
            modelData.consecutive_errors = 0;
            if (modelData.disabled) {
                modelData.disabled = false;
            }
            // Re-enable provider on any model success if it was disabled
            if (providerData.disabled) {
                 console.log(`Re-enabling provider ${providerId} after successful request for model ${modelId}.`);
                 providerData.disabled = false;
            }
        }

        updateProviderData(providerData as ProviderStateStructure, modelId, responseEntry, isError); 
        providerData = await computeProviderMetricsInWorker(providerData as ProviderStateStructure, this.alpha, 0.7, 0.3);
        providers[providerIndex] = providerData;
        return providers; 
    }

    async handleMessages(messages: IMessage[], modelId: string, apiKey: string): Promise<any> {
         if (!messages?.length || !modelId || !apiKey) throw new Error("Invalid arguments");
         if (!messageHandler) throw new Error("Service temporarily unavailable.");

            await this.refreshModelCapabilities();
            this.validateModelCapabilities(modelId, messages);
            const requiredCaps = this.detectRequiredCapabilities(messages, modelId);

         const validationResult = await validateApiKeyAndUsage(apiKey); 
         if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
             const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
             throw new Error(`${statusCode === 429 ? 'Limit reached' : 'Unauthorized'}: ${validationResult.error}`);
         }
         const userData: UserData = validationResult.userData; 
         const tierLimits: TierData = validationResult.tierLimits; 
         const userTierName = userData.tier; 
         const allProvidersOriginal = await dataManager.load<LoadedProviders>('providers');
         let candidateProviders = this.prepareCandidateProviders(allProvidersOriginal, modelId, tierLimits, userTierName);
         candidateProviders = this.filterProvidersByCapabilitySkips(candidateProviders, modelId, requiredCaps);
         if (candidateProviders.length === 0) {
             throw new Error(`No providers available for model ${modelId} after capability filtering.`);
         }

         // --- Attempt Loop ---
         let lastError: any = null;
         const triedProviderIds = new Set<string>();
         for (let idx = 0; idx < candidateProviders.length; idx++) {
             const selectedProvider = candidateProviders[idx];
             const providerId = selectedProvider.id;
             if (triedProviderIds.has(providerId)) continue;
             triedProviderIds.add(providerId);

            const providerConfig = this.ensureProviderConfig(providerId, selectedProvider);
             if (!providerConfig) {
                 console.error(`Internal config error for provider: ${providerId}. Skipping.`);
                 lastError = new Error(`Internal config error for provider: ${providerId}`);
                 continue; // Try next provider
             }

            // Inject modelId for Gemini so the SDK calls the correct model instead of a fixed default
            const args = providerConfig.args ? [...providerConfig.args] : [];
            let ProviderClass = providerConfig.class;

            if (this.shouldUseImagenProvider(providerId, modelId)) {
                ProviderClass = ImagenAI;
            }

            const perModelUrl = selectedProvider?.provider_urls && selectedProvider.provider_urls[modelId]
                ? selectedProvider.provider_urls[modelId]
                : undefined;

            if (ProviderClass === GeminiAI) {
                // Ensure API key stays first arg; if missing, fall back to provider's stored key
                args[0] = args[0] ?? selectedProvider.apiKey ?? '';
                args[1] = modelId;
                if (perModelUrl) args[2] = perModelUrl;
            }
            if (ProviderClass === ImagenAI) {
                args[0] = args[0] ?? selectedProvider.apiKey ?? '';
                args[1] = modelId;
                if (perModelUrl) args[2] = perModelUrl;
            }
            if (ProviderClass === OpenAI || ProviderClass === OpenRouterAI || ProviderClass === DeepseekAI) {
                if (perModelUrl) {
                    args[1] = perModelUrl;
                }
            }

            const providerInstance = new ProviderClass(...args);
             let result: ProviderResponse | null = null;
             let responseEntry: ResponseEntry | null = null; 
             let sendMessageError: any = null; // Renamed from attemptError for clarity

             try { 
                 const attemptStart = Date.now();
                 const modelStats = selectedProvider?.models?.[modelId];
                 const speedEstimateTps =
                     (typeof (modelStats as any)?.avg_token_speed === 'number' && (modelStats as any).avg_token_speed > 0)
                         ? (modelStats as any).avg_token_speed
                         : ((typeof (modelStats as any)?.token_generation_speed === 'number' && (modelStats as any).token_generation_speed > 0)
                             ? (modelStats as any).token_generation_speed
                             : this.DEFAULT_GENERATION_SPEED);
                 const lastMessage = messages[messages.length - 1];
                 const hasRole = messages.some((msg) => typeof msg.role === 'string' && msg.role.trim().length > 0);
                 const includeMessages = messages.length > 1 || hasRole;
                 const messageForProvider: IMessage = { ...lastMessage, model: { id: modelId } };
                 if (includeMessages) {
                     messageForProvider.messages = messages.map((msg) => ({
                         role: typeof msg.role === 'string' && msg.role.trim() ? msg.role : 'user',
                         content: msg.content,
                     }));
                 }
                 result = await providerInstance.sendMessage(messageForProvider);
                 const attemptDuration = Date.now() - attemptStart;
                 if (result) { 
                    const estimatedInputTokens = messages.reduce((sum, msg) => {
                        return sum + estimateTokensFromContent(msg.content);
                    }, 0);
                    const estimatedOutputTokens = estimateTokensFromText(result.response || '');
                    const { inputTokens, outputTokens } = this.normalizeUsage(result.usage, estimatedInputTokens, estimatedOutputTokens);
                    const tokensGenerated = inputTokens + outputTokens;

                    const generationTokens = (inputTokens * TTFT_INPUT_TOKENS_WEIGHT)
                        + (outputTokens * TTFT_OUTPUT_TOKENS_WEIGHT);
                    const avgTps = outputTokens > 0 ? (outputTokens / Math.max(0.001, attemptDuration / 1000)) : 0;
                    const effectiveTps = speedEstimateTps > 0
                        ? Math.min(speedEstimateTps, Math.max(avgTps, 1))
                        : Math.max(avgTps, 1);
                    const estimatedGenerationMs = effectiveTps > 0
                        ? (generationTokens / effectiveTps) * 1000
                        : 0;
                    let estimatedTtftMs = Math.max(0, attemptDuration - estimatedGenerationMs);
                    const maxProviderLatency = Math.max(0, attemptDuration - NON_STREAM_MIN_GENERATION_WINDOW_MS);
                    if (estimatedTtftMs > maxProviderLatency) {
                        estimatedTtftMs = maxProviderLatency;
                    }
                    let providerLatency = Math.max(0, Math.min(Math.round(estimatedTtftMs), attemptDuration));
                    if (providerLatency === 0 && attemptDuration > 0 && outputTokens > 0) {
                        providerLatency = Math.min(Math.max(NON_STREAM_MIN_TTFT_MS, 1), attemptDuration);
                    }
                    let observedSpeedTps: number | null = null;
                    const speedWindowMs = Math.max(1, attemptDuration - (providerLatency || 0));
                    if (outputTokens > 0 && speedWindowMs > 0) {
                        let calculatedSpeed = outputTokens / Math.max(0.001, speedWindowMs / 1000);
                        if (speedWindowMs < NON_STREAM_MIN_GENERATION_WINDOW_MS && avgTps > 0) {
                            calculatedSpeed = avgTps;
                        }
                        if (!isNaN(calculatedSpeed) && isFinite(calculatedSpeed) && calculatedSpeed > 0) {
                            observedSpeedTps = calculatedSpeed;
                        }
                    }
                    responseEntry = {
                        timestamp: Date.now(),
                        response_time: attemptDuration,
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        tokens_generated: tokensGenerated,
                        provider_latency: providerLatency,
                        observed_speed_tps: observedSpeedTps,
                        apiKey: apiKey
                    };
                 } else { 
                    sendMessageError = new Error(`Provider ${providerId} returned null result for model ${modelId}.`); 
                 }
             } catch (error: any) { 
                console.error(`Error during sendMessage with ${providerId}/${modelId}:`, error); 
                sendMessageError = error; 
             }

             // --- Update Stats & Save (Always, regardless of attempt outcome) ---
            try {
                await dataManager.updateWithLock<LoadedProviders>('providers', async (currentProvidersData) => {
                    return this.updateStatsInProviderList(
                        currentProvidersData,
                        providerId,
                        modelId,
                        responseEntry,
                        !!sendMessageError,
                        sendMessageError
                    );
                });
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
                    promptTokens: responseEntry.input_tokens,
                    completionTokens: responseEntry.output_tokens,
                    providerId: providerId 
                };
             } else {
                 lastError = sendMessageError || new Error(`Provider ${providerId} for model ${modelId} finished in invalid state or stats update failed after success.`);
                 // Reinstate this important operational warning
                 console.warn(`Provider ${providerId} failed for model ${modelId}. Error: ${lastError.message}. Trying next provider if available...`);
             }

             if (sendMessageError && this.isInsufficientCreditsError(sendMessageError)) {
                 const added = this.appendCreditFallbackProviders(
                     allProvidersOriginal,
                     candidateProviders,
                     selectedProvider,
                     modelId,
                     requiredCaps,
                     triedProviderIds
                 );
                 if (added > 0) {
                     console.warn(`Insufficient credits on ${providerId}; added ${added} fallback provider(s) for model ${modelId}.`);
                 }
             }
         } // End of loop through candidateProviders

         // If loop completes without success
         console.error(`All attempts failed for model ${modelId}. Last error: ${lastError?.message || 'Unknown error'}`);
         const detail = lastError?.message || 'All available providers failed or were unsuitable.';
         throw new Error(`Failed to process request: ${detail}`); // Surface the last provider error for debugging
    }

    async *handleStreamingMessages(
        messages: IMessage[],
        modelId: string,
        apiKey: string,
        options?: { disablePassthrough?: boolean }
    ): AsyncGenerator<any, void, unknown> {
        if (!messages?.length || !modelId || !apiKey) throw new Error("Invalid arguments for streaming");
        if (!messageHandler) throw new Error("Service temporarily unavailable.");

        await this.refreshModelCapabilities();
        this.validateModelCapabilities(modelId, messages);
        const requiredCaps = this.detectRequiredCapabilities(messages, modelId);

        const validationResult = await validateApiKeyAndUsage(apiKey);
        if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
            throw new Error(`Unauthorized: ${validationResult.error || 'Invalid key/config.'}`);
        }

        const userData: UserData = validationResult.userData;
        const tierLimits: TierData = validationResult.tierLimits;
        const userTierName = userData.tier;

        const allProvidersOriginal = await dataManager.load<LoadedProviders>('providers');
        let candidateProviders = this.prepareCandidateProviders(allProvidersOriginal, modelId, tierLimits, userTierName);
        candidateProviders = this.filterProvidersByCapabilitySkips(candidateProviders, modelId, requiredCaps);
        if (candidateProviders.length === 0) {
            throw new Error(`No providers available for model ${modelId} after capability filtering.`);
        }

        let lastError: any = null;
        const triedProviderIds = new Set<string>();
        for (let idx = 0; idx < candidateProviders.length; idx++) {
            const selectedProviderData = candidateProviders[idx];
            const providerId = selectedProviderData.id;
            if (triedProviderIds.has(providerId)) continue;
            triedProviderIds.add(providerId);
            const providerConfig = this.ensureProviderConfig(providerId, selectedProviderData);

            if (!providerConfig) {
                console.error(`Internal config error for provider: ${providerId}. Skipping.`);
                lastError = new Error(`Internal config error for provider: ${providerId}`);
                continue;
            }

            const streamArgs = providerConfig.args ? [...providerConfig.args] : [];
            let StreamProviderClass = providerConfig.class;

            if (this.shouldUseImagenProvider(providerId, modelId)) {
                StreamProviderClass = ImagenAI;
            }

            if (StreamProviderClass === GeminiAI) {
                streamArgs[0] = streamArgs[0] ?? selectedProviderData.apiKey ?? '';
                streamArgs[1] = modelId;
            }
            if (StreamProviderClass === ImagenAI) {
                streamArgs[0] = streamArgs[0] ?? selectedProviderData.apiKey ?? '';
                streamArgs[1] = modelId;
            }

            const providerInstance = new StreamProviderClass(...streamArgs);

            try {
                const lastMessage = messages[messages.length - 1];
                const hasRole = messages.some((msg) => typeof msg.role === 'string' && msg.role.trim().length > 0);
                const includeMessages = messages.length > 1 || hasRole;
                const messageForProvider: IMessage = { ...lastMessage, model: { id: modelId } };
                if (includeMessages) {
                    messageForProvider.messages = messages.map((msg) => ({
                        role: typeof msg.role === 'string' && msg.role.trim() ? msg.role : 'user',
                        content: msg.content,
                    }));
                }

                if (
                    !options?.disablePassthrough &&
                    selectedProviderData.streamingCompatible &&
                    typeof providerInstance.createPassthroughStream === 'function'
                ) {
                    try {
                        const passthrough = await providerInstance.createPassthroughStream(messageForProvider);
                        if (passthrough?.upstream) {
                            const promptTokens = messages.reduce((sum, msg) => {
                                return sum + estimateTokensFromContent(msg.content);
                            }, 0);

                            console.log(`[StreamPassthrough] Activated for provider ${providerId} (${passthrough.mode}).`);
                            yield {
                                type: 'passthrough',
                                providerId,
                                passthrough,
                                promptTokens,
                                startedAt: Date.now(),
                            };
                            return;
                        }
                    } catch (passthroughError: any) {
                        console.warn(`[StreamPassthrough] Fallback to normalized streaming for provider ${providerId}: ${passthroughError?.message || 'unknown passthrough setup error'}`);
                    }
                }

                if (selectedProviderData.streamingCompatible && typeof providerInstance.sendMessageStream === 'function') {
                    const streamStart = Date.now();
                    const stream = providerInstance.sendMessageStream(messageForProvider);
                    let fullResponse = '';
                    let totalLatency = 0;
                    let chunkCount = 0;
                    let firstChunkLatency: number | null = null;

                    for await (const { chunk, latency, response } of stream) {
                        fullResponse = response;
                        totalLatency += latency || 0;
                        chunkCount++;
                        if (firstChunkLatency === null && chunk && chunk.length > 0) {
                            firstChunkLatency = latency || 0;
                        }
                        yield { type: 'chunk', chunk, latency };
                    }

                    const totalResponseTime = Date.now() - streamStart;
                    const inputTokens = messages.reduce((sum, msg) => {
                        return sum + estimateTokensFromContent(msg.content);
                    }, 0);
                    const outputTokens = estimateTokensFromText(fullResponse);

                    let providerLatency: number | null = null;
                    if (firstChunkLatency !== null && firstChunkLatency > 0) {
                        providerLatency = Math.min(Math.round(firstChunkLatency), totalResponseTime);
                    } else {
                        providerLatency = Math.max(0, Math.round(totalResponseTime));
                    }
                    let observedSpeedTps: number | null = null;

                    if (outputTokens > 0) {
                        const speedWindowMs = Math.max(1, totalResponseTime - (providerLatency || 0));
                        const generationWindow = Math.max(speedWindowMs, STREAM_MIN_GENERATION_WINDOW_MS);
                        const generationTimeSeconds = Math.max(0.001, generationWindow / 1000);
                        const calculatedSpeed = outputTokens / generationTimeSeconds;
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
                        promptTokens: inputTokens,
                        completionTokens: outputTokens,
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
                this.updateStatsInBackground(providerId, modelId, null, true, error);
                console.warn(`Stream failed for provider ${providerId}. Error: ${error.message}. Trying next provider if available...`);
                lastError = error;

                if (this.isInsufficientCreditsError(error)) {
                    const added = this.appendCreditFallbackProviders(
                        allProvidersOriginal,
                        candidateProviders,
                        selectedProviderData,
                        modelId,
                        requiredCaps,
                        triedProviderIds
                    );
                    if (added > 0) {
                        console.warn(`Insufficient credits on ${providerId}; added ${added} fallback provider(s) for model ${modelId}.`);
                    }
                }
                continue;
            }
        }

        console.error(`All streaming attempts failed for model ${modelId}. Last error: ${lastError?.message || 'Unknown error'}`);
        const detail = lastError?.message || 'All available providers failed or were unsuitable.';
        throw new Error(`Failed to process streaming request: ${detail}`);
    }

    private async updateStatsInBackground(
        providerId: string,
        modelId: string,
        responseEntry: ResponseEntry | null,
        isError: boolean,
        attemptError?: any
    ) {
        try {
            await dataManager.updateWithLock<LoadedProviders>('providers', async (currentProvidersData) => {
                return this.updateStatsInProviderList(
                    currentProvidersData,
                    providerId,
                    modelId,
                    responseEntry,
                    isError,
                    attemptError
                );
            });
        } catch (statsError: any) {
            console.error(`Error updating/saving stats in background for provider ${providerId}/${modelId}. Error:`, statsError);
        }
    }
}

const BASE64_DATA_URL_GLOBAL = /data:([^;\s]+);base64,([A-Za-z0-9+/=_-]+)/gi;

const IMAGE_INPUT_TOKENS_PER_KB = readEnvNumber('IMAGE_INPUT_TOKENS_PER_KB', 4);
const IMAGE_OUTPUT_TOKENS_PER_KB = readEnvNumber('IMAGE_OUTPUT_TOKENS_PER_KB', 8);
const AUDIO_INPUT_TOKENS_PER_KB = readEnvNumber('AUDIO_INPUT_TOKENS_PER_KB', 2);
const AUDIO_OUTPUT_TOKENS_PER_KB = readEnvNumber('AUDIO_OUTPUT_TOKENS_PER_KB', 4);
const IMAGE_URL_FALLBACK_TOKENS = readEnvNumber('IMAGE_URL_FALLBACK_TOKENS', 512);
const AUDIO_DATA_FALLBACK_TOKENS = readEnvNumber('AUDIO_DATA_FALLBACK_TOKENS', 256);
const IMAGE_MIN_TOKENS = readEnvNumber('IMAGE_MIN_TOKENS', 0);
const AUDIO_MIN_TOKENS = readEnvNumber('AUDIO_MIN_TOKENS', 0);

function readEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function estimateTokensFromBase64Payload(payload: string, tokensPerKb: number, minTokens: number): number {
    if (!payload) return minTokens;
    const cleaned = payload.replace(/\s+/g, '');
    if (!cleaned) return minTokens;
    const bytes = Math.max(0, Math.floor((cleaned.length * 3) / 4));
    const tokens = Math.ceil((bytes / 1024) * tokensPerKb);
    return Math.max(tokens, minTokens);
}

function estimateTokensFromDataUrl(dataUrl: string, direction: 'input' | 'output'): number {
    const match = dataUrl.match(/^data:([^;\s]+);base64,([A-Za-z0-9+/=_-]+)$/i);
    if (!match) return 0;
    const mimeType = (match[1] || '').toLowerCase();
    const payload = match[2] || '';

    if (mimeType.startsWith('image/')) {
        const perKb = direction === 'input' ? IMAGE_INPUT_TOKENS_PER_KB : IMAGE_OUTPUT_TOKENS_PER_KB;
        return estimateTokensFromBase64Payload(payload, perKb, IMAGE_MIN_TOKENS);
    }
    if (mimeType.startsWith('audio/')) {
        const perKb = direction === 'input' ? AUDIO_INPUT_TOKENS_PER_KB : AUDIO_OUTPUT_TOKENS_PER_KB;
        return estimateTokensFromBase64Payload(payload, perKb, AUDIO_MIN_TOKENS);
    }
    return 0;
}

function estimateTokensFromText(text: string, direction: 'input' | 'output' = 'output'): number {
    const value = String(text || '');
    if (!value) return 0;

    let mediaTokens = 0;
    if (value.includes('data:')) {
        const regex = new RegExp(BASE64_DATA_URL_GLOBAL);
        for (const match of value.matchAll(regex)) {
            const mimeType = (match[1] || '').toLowerCase();
            const payload = match[2] || '';
            if (mimeType.startsWith('image/')) {
                const perKb = direction === 'input' ? IMAGE_INPUT_TOKENS_PER_KB : IMAGE_OUTPUT_TOKENS_PER_KB;
                mediaTokens += estimateTokensFromBase64Payload(payload, perKb, IMAGE_MIN_TOKENS);
            } else if (mimeType.startsWith('audio/')) {
                const perKb = direction === 'input' ? AUDIO_INPUT_TOKENS_PER_KB : AUDIO_OUTPUT_TOKENS_PER_KB;
                mediaTokens += estimateTokensFromBase64Payload(payload, perKb, AUDIO_MIN_TOKENS);
            }
        }
    }

    const stripped = value.replace(BASE64_DATA_URL_GLOBAL, '[binary-data]');
    if (!stripped) return mediaTokens;
    return mediaTokens + Math.ceil(stripped.length / 4);
}

function estimateTokensFromContent(content: IMessage['content']): number {
    if (typeof content === 'string') {
        return estimateTokensFromText(content, 'input');
    }
    if (!Array.isArray(content)) {
        return estimateTokensFromText(JSON.stringify(content), 'input');
    }

    let total = 0;
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const type = String((part as any).type || '').toLowerCase();
        if (type === 'text' || type === 'input_text') {
            total += estimateTokensFromText((part as any).text || '', 'input');
            continue;
        }
        if (type === 'image_url') {
            const url = (part as any)?.image_url?.url;
            if (typeof url === 'string' && url.startsWith('data:')) {
                total += estimateTokensFromDataUrl(url, 'input');
            } else if (typeof url === 'string' && url.length > 0) {
                total += IMAGE_URL_FALLBACK_TOKENS;
            }
            continue;
        }
        if (type === 'input_audio') {
            const data = (part as any)?.input_audio?.data;
            if (typeof data === 'string' && data.length > 0) {
                total += estimateTokensFromBase64Payload(data, AUDIO_INPUT_TOKENS_PER_KB, AUDIO_MIN_TOKENS);
            } else {
                total += AUDIO_DATA_FALLBACK_TOKENS;
            }
            continue;
        }
        total += estimateTokensFromText(JSON.stringify(part), 'input');
    }

    return total;
}

export { messageHandler };
