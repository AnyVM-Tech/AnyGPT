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
    private readonly CONSECUTIVE_ERROR_THRESHOLD = 5; // Threshold for disabling

    constructor(throughputMap: Map<string, number>) { 
        this.initialModelThroughputMap = throughputMap;
    }
    
    private updateStatsInProviderList(providers: LoadedProviderData[], providerId: string, modelId: string, responseEntry: ResponseEntry | null, isError: boolean): LoadedProviderData[] { 
        const providerIndex = providers.findIndex(p => p.id === providerId);
        if (providerIndex === -1) return providers; 
        let providerData = providers[providerIndex]; 
        if (!providerData.models[modelId]) {
            // Initialize model data including consecutive_errors
            providerData.models[modelId] = { 
                id: modelId, 
                response_times: [], 
                errors: 0, 
                avg_token_speed: this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED, 
                consecutive_errors: 0 // Initialize consecutive errors
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
         console.log(`Handling message for model: ${modelId}, Key: ${apiKey.substring(0, 6)}...`);

         const validationResult = await validateApiKeyAndUsage(apiKey); 
         if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
             const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
             throw new Error(`${statusCode === 429 ? 'Limit reached' : 'Unauthorized'}: ${validationResult.error}`);
         }
         const userData: UserData = validationResult.userData; 
         const tierLimits: TierData = validationResult.tierLimits; 
         const userTierName = userData.tier; 

         const allProvidersOriginal = await dataManager.load<LoadedProviders>('providers');
         if (!allProvidersOriginal || allProvidersOriginal.length === 0) throw new Error("No provider data available.");
         
         // Filter out disabled providers first
         let activeProviders = allProvidersOriginal.filter((p: LoadedProviderData) => !p.disabled);
         if (activeProviders.length === 0) {
             // Check if *any* provider exists, even if disabled
             if (allProvidersOriginal.length > 0) throw new Error("All potentially compatible providers are currently disabled due to errors.");
             else throw new Error("No provider data available (list is empty)."); // Should not happen if load checks work, but safety first
         }

         try {
             // Apply time window only to active providers to avoid modifying disabled ones unnecessarily
             applyTimeWindow(activeProviders as ProviderStateStructure[], this.TIME_WINDOW_HOURS); 
         } catch(e) { console.error("Error applying time window:", e); }

         // Find compatible providers among the active ones
         let compatibleProviders = activeProviders.filter((p: LoadedProviderData) => p.models && modelId in p.models);
         if (compatibleProviders.length === 0) {
             // Check if the model exists at all, even in disabled providers
             const anyProviderHasModel = allProvidersOriginal.some((p: LoadedProviderData) => p.models && modelId in p.models);
             if (!anyProviderHasModel) throw new Error(`No provider (active or disabled) supports model ${modelId}`);
             else throw new Error(`No currently active provider supports model ${modelId}. All supporting providers may be temporarily disabled.`);
         }
         
         // Filter based on tier score limits
         let eligibleProviders = compatibleProviders.filter((p: LoadedProviderData) => { 
             const score = p.provider_score; 
             const minOk = (tierLimits.min_provider_score === null) || (score !== null && score >= tierLimits.min_provider_score);
             const maxOk = (tierLimits.max_provider_score === null) || (score !== null && score <= tierLimits.max_provider_score);
             return minOk && maxOk;
         });

         // --- Create Ordered Candidate List ---
         let candidateProviders: LoadedProviderData[] = [];
         const randomChoice = Math.random(); // For probabilistic selection

         if (eligibleProviders.length > 0) {
             // Sort eligible providers based on tier
             if (userTierName === 'enterprise') {
                 eligibleProviders.sort((a, b) => (b.provider_score ?? -Infinity) - (a.provider_score ?? -Infinity)); // Best first
             } else if (userTierName === 'pro') {
                 eligibleProviders.sort((a, b) => (b.provider_score ?? -Infinity) - (a.provider_score ?? -Infinity)); // Best first initially
                 const pickBestProbability = 0.80;
                 if (randomChoice >= pickBestProbability && eligibleProviders.length > 1) {
                    // Swap first with a random other element
                    const randomIndex = Math.floor(Math.random() * (eligibleProviders.length - 1)) + 1;
                    [eligibleProviders[0], eligibleProviders[randomIndex]] = [eligibleProviders[randomIndex], eligibleProviders[0]];
                 }
             } else { // Free tier
                 eligibleProviders.sort((a, b) => (a.provider_score ?? Infinity) - (b.provider_score ?? Infinity)); // Worst first initially
                 const pickWorstProbability = 0.70;
                  if (randomChoice >= pickWorstProbability && eligibleProviders.length > 1) {
                    // Swap first (worst) with a random other element
                    const randomIndex = Math.floor(Math.random() * (eligibleProviders.length - 1)) + 1;
                    [eligibleProviders[0], eligibleProviders[randomIndex]] = [eligibleProviders[randomIndex], eligibleProviders[0]];
                 }
             }
             candidateProviders = [...eligibleProviders];
         }

         // Add remaining compatible (fallback) providers, sorted best first, ensuring no duplicates
         const fallbackProviders = compatibleProviders
            .filter(cp => !candidateProviders.some(cand => cand.id === cp.id)) // Exclude already added eligible ones
            .sort((a, b) => (b.provider_score ?? -Infinity) - (a.provider_score ?? -Infinity)); // Best score first for fallback
         
         candidateProviders = [...candidateProviders, ...fallbackProviders];

         if (candidateProviders.length === 0) {
            // This case should technically be covered by earlier checks, but adding safety net
            throw new Error(`Could not determine any candidate providers for model ${modelId}.`);
         }
         console.log(`Attempting request for model ${modelId}. Candidate providers (ordered): ${candidateProviders.map(p => `${p.id} (Score: ${p.provider_score?.toFixed(2)})`).join(', ')}`);

         // --- Attempt Loop ---
         let lastError: any = null;
         for (const selectedProvider of candidateProviders) {
             const providerId = selectedProvider.id;
             console.log(`Attempting provider: ${providerId} (Score: ${selectedProvider.provider_score?.toFixed(2)})`);

             const providerConfig = providerConfigs[providerId]; 
             if (!providerConfig) {
                 console.error(`Internal config error for provider: ${providerId}. Skipping.`);
                 lastError = new Error(`Internal config error for provider: ${providerId}`);
                 continue; // Try next provider
             }

             const providerInstance = new providerConfig.class(...(providerConfig.args || []));
             const modelStats = selectedProvider.models[modelId];
             const currentTokenGenerationSpeed = modelStats?.avg_token_speed ?? this.initialModelThroughputMap.get(modelId) ?? this.DEFAULT_GENERATION_SPEED;
             let result: { response: string; latency: number } | null = null;
             let responseEntry: ResponseEntry | null = null; 
             let attemptError: any = null;

             try { 
                 result = await providerInstance.sendMessage({ content: messages[messages.length - 1].content, model: { id: modelId } });
                 if (result) { 
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
                 } else { 
                    attemptError = new Error(`Provider ${providerId} returned null result.`); 
                 }
             } catch (error: any) { 
                console.error(`Error during sendMessage with ${providerId}/${modelId}:`, error); 
                attemptError = error; 
             }

             // --- Update Stats & Save (Always, regardless of attempt outcome) ---
             // Need to load the *latest* provider data before updating and saving
             let currentProvidersData = await dataManager.load<LoadedProviders>('providers');
             const updatedProviderDataList = this.updateStatsInProviderList(
                 currentProvidersData, // Use fresh data
                 providerId, 
                 modelId, 
                 responseEntry, // Null if error occurred during generation
                 !!attemptError // isError flag
             );
             await dataManager.save<LoadedProviders>('providers', updatedProviderDataList); 

             // --- Handle Attempt Outcome ---
             if (!attemptError && result && responseEntry) {
                console.log(`Successfully processed request with provider: ${providerId}`);
                // TODO: Add updateUserTokenUsage call if needed
                // await updateUserTokenUsage(apiKey, responseEntry.tokens_generated); // Uncomment if needed
                 return { 
                    response: result.response, 
                    latency: result.latency, 
                    tokenUsage: responseEntry.tokens_generated,
                    providerId: providerId // Optionally return which provider succeeded
                };
             } else {
                 // Attempt failed, store the error and loop to try next provider
                 lastError = attemptError || new Error(`Provider ${providerId} finished in invalid state.`);
                 console.warn(`Provider ${providerId} failed for model ${modelId}. Error: ${lastError.message}. Trying next provider if available...`);
             }
         } // End of loop through candidateProviders

         // If loop completes without success
         console.error(`All attempts failed for model ${modelId}. Last error: ${lastError?.message || 'Unknown error'}`);
         throw new Error("Failed to process request: All available providers failed or were unsuitable."); // Generic error
    }
}

export { messageHandler };
