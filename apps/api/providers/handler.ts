import dotenv from 'dotenv';
import {
  IAIProvider, // Keep IAIProvider if needed for ProviderConfig
  IMessage,
  ResponseEntry,
  Provider as ProviderStateStructure,
  Model,
} from './interfaces'; // Removed ModelDefinition from here
import { GeminiAI } from './gemini';
import { OpenAI } from './openai';
import { computeProviderStatsWithEMA, updateProviderData, computeProviderScore, applyTimeWindow } from '../modules/compute';
// Import DataManager and necessary EXPORTED types
import { 
    dataManager, 
    LoadedProviders, // Import exported type
    LoadedProviderData, // Import exported type
    ModelsFileStructure, // Import exported type
    ModelDefinition // Import ModelDefinition from dataManager
} from '../modules/dataManager'; 
// FIX: Import fs for schema loading
import * as fs from 'fs'; 
import * as path from 'path';
import Ajv from 'ajv';
import {
  validateApiKeyAndUsage, // Now async
  UserData, // Assuming this is exported from userData
  TierData, // Assuming this is exported from userData
} from '../modules/userData';
// Assuming updateUserTokenUsage is still needed and exported from userData
import { updateUserTokenUsage } from '../modules/userData'; 


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
let messageHandler: MessageHandler; 

// --- Initialization using DataManager ---
async function initializeHandlerData() {
    console.log("Initializing handler data...");
    // Load models data using DataManager
    const modelsFileData = await dataManager.load<ModelsFileStructure>('models');
    const modelData = modelsFileData.data; 

    initialModelThroughputMap = new Map<string, number>();
    // Use the imported ModelDefinition type here
    modelData.forEach((model: ModelDefinition) => { 
        // Ensure throughput type compatibility (handle potential null from dataManager's ModelDefinition)
        const throughputValue = model.throughput;
        const throughput = (throughputValue != null && !isNaN(Number(throughputValue))) ? Number(throughputValue) : NaN;
        if (model.id && !isNaN(throughput)) initialModelThroughputMap.set(model.id, throughput);
    });
    console.log(`Initialized throughput map with ${initialModelThroughputMap.size} entries.`);

    // Load initial providers using DataManager for config setup
    const initialProviders = await dataManager.load<LoadedProviders>('providers');
    console.log("Initializing provider class configurations...");
    providerConfigs = {}; 
    // FIX: Add type annotation for p
    initialProviders.forEach((p: LoadedProviderData) => { 
        const key = process.env[`PROVIDER_API_KEY_${p.id.toUpperCase().replace(/-/g, '_')}`] || p.apiKey;
        const url = p.provider_url || '';
        if (!key) console.warn(`API key missing for provider config: ${p.id}.`);
        if (p.id.includes('openai')) providerConfigs[p.id] = { class: OpenAI, args: [key, url] };
        else if (p.id.includes('gemini') || p.id === 'google') providerConfigs[p.id] = { class: GeminiAI, args: [key, 'gemini-pro'] }; 
        else providerConfigs[p.id] = { class: OpenAI, args: [key, url] }; 
    });
    console.log("Provider class configurations initialized.");

    messageHandler = new MessageHandler(initialModelThroughputMap);
    console.log("MessageHandler initialized and ready.");
}

initializeHandlerData().catch(error => {
    console.error("CRITICAL: Failed to initialize application data.", error);
    process.exit(1); 
});

// --- Message Handler Class ---
export class MessageHandler {
    private alpha: number = 0.3; 
    private initialModelThroughputMap: Map<string, number>; 
    private readonly DEFAULT_GENERATION_SPEED = 50; 
    private readonly TIME_WINDOW_HOURS = 24; 

    constructor(throughputMap: Map<string, number>) { 
        this.initialModelThroughputMap = throughputMap;
    }
    
    private updateStatsInProviderList(providers: LoadedProviderData[], providerId: string, modelId: string, responseEntry: ResponseEntry | null, isError: boolean): LoadedProviderData[] { 
        const providerIndex = providers.findIndex(p => p.id === providerId);
        if (providerIndex === -1) return providers; 
        let providerData = providers[providerIndex]; 
        if (!providerData.models[modelId]) {
            providerData.models[modelId] = { id: modelId, response_times: [], errors: 0, avg_token_speed: this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED };
        }
        updateProviderData(providerData as ProviderStateStructure, modelId, responseEntry, isError); 
        computeProviderStatsWithEMA(providerData as ProviderStateStructure, this.alpha); 
        computeProviderScore(providerData as ProviderStateStructure, 0.7, 0.3); 
        return providers; 
    }

    async handleMessages(messages: IMessage[], modelId: string, apiKey: string): Promise<any> {
         if (!messages?.length || !modelId || !apiKey) throw new Error("Invalid arguments");
         if (!messageHandler) throw new Error("Service temporarily unavailable.");
         console.log(`Handling message for model: ${modelId}, Key: ${apiKey.substring(0, 6)}...`);

         const validationResult = await validateApiKeyAndUsage(apiKey); 
         if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
             const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
             throw new Error(`${statusCode === 429 ? 'Limit reached' : 'Unauthorized'}: ${validationResult.error}`);
         }
         const userData: UserData = validationResult.userData; 
         const tierLimits: TierData = validationResult.tierLimits; 
         const userTierName = userData.tier; 

         let allProviders = await dataManager.load<LoadedProviders>('providers');
         if (allProviders.length === 0) throw new Error("No provider data available.");
         try {
             applyTimeWindow(allProviders as ProviderStateStructure[], this.TIME_WINDOW_HOURS);
         } catch(e) { console.error("Error applying time window:", e); }

         const compatibleProviders = allProviders.filter((p: LoadedProviderData) => p.models && modelId in p.models);
         if (compatibleProviders.length === 0) throw new Error(`No provider supports model ${modelId}`);
         let eligibleProviders = compatibleProviders.filter((p: LoadedProviderData) => { 
             const score = p.provider_score; 
             const minOk = (tierLimits.min_provider_score === null) || (score !== null && score >= tierLimits.min_provider_score);
             const maxOk = (tierLimits.max_provider_score === null) || (score !== null && score <= tierLimits.max_provider_score);
             return minOk && maxOk;
         });
         
         let selectedProvider: LoadedProviderData;
         let usingFallback = false;
         const randomChoice = Math.random();
         if (eligibleProviders.length === 0) { 
             usingFallback = true;
             compatibleProviders.sort((a, b) => (b.provider_score ?? -Infinity) - (a.provider_score ?? -Infinity));
             selectedProvider = compatibleProviders[0]; 
             if (!selectedProvider) throw new Error(`Fallback failed: No compatible providers for ${modelId}.`);
             console.warn(`No providers in tier '${userTierName}' range for ${modelId}. Falling back to ${selectedProvider.id}.`);
         } else if (eligibleProviders.length === 1) {
              selectedProvider = eligibleProviders[0];
         } else {
            eligibleProviders.sort((a, b) => (b.provider_score ?? -Infinity) - (a.provider_score ?? -Infinity)); 
            if (userTierName === 'enterprise') {
                 selectedProvider = eligibleProviders[0];
            } else if (userTierName === 'pro') {
                 const pickBestProbability = 0.80; 
                 if (randomChoice < pickBestProbability) selectedProvider = eligibleProviders[0]; 
                 else selectedProvider = eligibleProviders[Math.floor(Math.random() * (eligibleProviders.length - 1)) + 1]; 
            } else { 
                 const pickWorstProbability = 0.70; 
                 eligibleProviders.sort((a, b) => (a.provider_score ?? Infinity) - (b.provider_score ?? Infinity)); 
                 if (randomChoice < pickWorstProbability) selectedProvider = eligibleProviders[0]; 
                 else selectedProvider = eligibleProviders[Math.floor(Math.random() * (eligibleProviders.length - 1)) + 1]; 
            }
         }
         const providerId = selectedProvider.id;
         const providerConfig = providerConfigs[providerId]; 
         if (!providerConfig) throw new Error(`Internal config error for provider: ${providerId}`);
         console.log(`Selected Provider (Tier: ${userTierName}, Fallback: ${usingFallback}): ${providerId} (Score: ${selectedProvider.provider_score?.toFixed(2)})`);

         const providerInstance = new providerConfig.class(...(providerConfig.args || []));
         const modelStats = selectedProvider.models[modelId];
         const currentTokenGenerationSpeed = modelStats?.avg_token_speed ?? this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED;
         let result: { response: string; latency: number } | null = null;
         let errorOccurred: any = null;
         let responseEntry: ResponseEntry | null = null; 

         try { 
             result = await providerInstance.sendMessage({ content: messages[messages.length - 1].content, model: { id: modelId } });
             if (result) { /* ... calculate responseEntry ... */ 
                const inputTokens = Math.ceil(messages[messages.length - 1].content.length / 4); 
                const outputTokens = Math.ceil(result.response.length / 4);
                let providerLatency: number | null = null; let observedSpeedTps: number | null = null;
                const expectedGenerationTimeMs = outputTokens > 0 && currentTokenGenerationSpeed > 0 ? (outputTokens / currentTokenGenerationSpeed) * 1000 : 0;
                if (!isNaN(expectedGenerationTimeMs) && isFinite(expectedGenerationTimeMs)) providerLatency = Math.max(0, Math.round(result.latency - expectedGenerationTimeMs));
                if (providerLatency !== null && outputTokens > 0) {
                     const actualGenerationTimeMs = Math.max(1, result.latency - providerLatency); 
                     const calculatedSpeed = outputTokens / (actualGenerationTimeMs / 1000);
                     if (!isNaN(calculatedSpeed) && isFinite(calculatedSpeed)) observedSpeedTps = calculatedSpeed;
                }
                responseEntry = { timestamp: Date.now(), response_time: result.latency, input_tokens: inputTokens, output_tokens: outputTokens, tokens_generated: inputTokens + outputTokens, provider_latency: providerLatency, observed_speed_tps: observedSpeedTps, apiKey: apiKey };
             } else { errorOccurred = new Error(`Provider ${providerId} returned null result.`); }
         } catch (error: any) { console.error(`Error sendMessage ${providerId}/${modelId}:`, error); errorOccurred = error; }

         const updatedProviderDataList = this.updateStatsInProviderList(
             allProviders, providerId, modelId, responseEntry, !!errorOccurred
         );
         await dataManager.save<LoadedProviders>('providers', updatedProviderDataList); 

         if (errorOccurred) throw new Error(`Provider ${providerId} failed: ${errorOccurred.message || 'Unknown'}`);
         else if (result && responseEntry) return { response: result.response, latency: result.latency, tokenUsage: responseEntry.tokens_generated, providerId: providerId };
         else throw new Error(`Provider ${providerId} finished in invalid state.`);
    }
}

export { messageHandler };
