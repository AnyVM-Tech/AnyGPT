import { dataManager, LoadedProviders, ModelsFileStructure } from './dataManager.js';
import { notifyNewModelsDiscovered } from './adminKeySync.js';
import * as fs from 'fs';
import * as path from 'path';

// --- Dynamic Pricing ---
// Loads base pricing from pricing.json and adjusts based on provider count
// Low providers = higher price (scarcity), many providers = lower price (abundance)
const COMP_BASE_RATE = 0.0233; // Competitor ULTRA effective rate per M tokens
const UNDERCUT_FACTOR = 0.80;  // 20% cheaper than competitor

interface BasePricing {
    input: number;
    output: number;
    audio_input?: number;
    audio_output?: number;
    per_image?: number;
    per_request?: number;
    image_input?: number;
}

let basePricingCache: Record<string, BasePricing> | null = null;
let competitorMultsCache: Record<string, number> | null = null;

function loadBasePricing(): Record<string, BasePricing> {
    if (basePricingCache) return basePricingCache;
    try {
        const raw = fs.readFileSync(path.resolve('pricing.json'), 'utf8');
        const parsed = JSON.parse(raw);
        basePricingCache = parsed.models || {};
        return basePricingCache!;
    } catch {
        return {};
    }
}

function estimateMultiplier(input: number, output: number): number {
    const blended = (input + output) / 2;
    if (blended <= 0) return 1;
    if (blended < 0.5) return 1.2;
    if (blended < 1) return 1.5;
    if (blended < 3) return 2.5;
    if (blended < 8) return 6;
    if (blended < 20) return 12;
    if (blended < 50) return 25;
    return 30;
}

function calculateDynamicPricing(modelId: string, providerCount: number): Record<string, any> | null {
    const basePricing = loadBasePricing();
    const stripped = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
    const price = basePricing[modelId] || basePricing[stripped];
    if (!price) return null;

    const inp = price.input || 0;
    const out = price.output || 0;
    
    // Provider availability factor: more providers = bigger discount
    // 1 provider: 0% discount (full competitor-match price)
    // 5 providers: 10% discount
    // 20+ providers: 20% discount (max undercut)
    const availDiscount = providerCount <= 1 ? 0
        : providerCount < 5 ? 0.05
        : providerCount < 10 ? 0.10
        : providerCount < 20 ? 0.15
        : 0.20;

    const mult = estimateMultiplier(inp, out);
    const compEffective = COMP_BASE_RATE * mult;
    const targetBlended = compEffective * (UNDERCUT_FACTOR - availDiscount);

    const shown: Record<string, any> = {};
    if (inp > 0 && out > 0) {
        const ratio = inp / (inp + out);
        shown.input = Math.round(targetBlended * 2 * ratio * 10000) / 10000;
        shown.output = Math.round(targetBlended * 2 * (1 - ratio) * 10000) / 10000;
    } else if (inp > 0) {
        shown.input = Math.round(targetBlended * 10000) / 10000;
        shown.output = 0;
    } else {
        shown.input = 0;
        shown.output = Math.round(targetBlended * 10000) / 10000;
    }

    // Special pricing (audio, image) — scale with availability
    const specialDiscount = 1 - (0.90 + availDiscount * 0.5); // 90-95% off official
    if (price.audio_input) shown.audio_input = Math.round(price.audio_input * specialDiscount * 10000) / 10000;
    if (price.audio_output) shown.audio_output = Math.round(price.audio_output * specialDiscount * 10000) / 10000;
    if (price.per_image) shown.per_image = Math.round(price.per_image * 0.20 * 1000000) / 1000000;
    if (price.per_request) shown.per_request = Math.round(price.per_request * 0.20 * 1000000) / 1000000;
    if (price.image_input) shown.image_input = Math.round(price.image_input * 0.20 * 1000000) / 1000000;

    shown.unit = 'per_million_tokens';
    return shown;
}

/**
 * Guess the owner/company of a model based on its ID
 */
function guessOwnedBy(modelId: string): string {
    const lower = modelId.toLowerCase();
    const prefix = lower.includes('/') ? lower.split('/')[0] : '';
    const prefixMap: Record<string, string> = {
        openai: 'openai',
        anthropic: 'anthropic',
        google: 'google',
        gemini: 'google',
        gemma: 'google',
        'meta-llama': 'meta',
        meta: 'meta',
        mistralai: 'mistral.ai',
        mistral: 'mistral.ai',
        qwen: 'alibaba',
        deepseek: 'deepseek',
        'x-ai': 'xai',
        xai: 'xai',
        cohere: 'cohere',
        ai21: 'ai21',
        openrouter: 'openrouter',
        bytedance: 'bytedance',
        'bytedance-seed': 'bytedance',
        baidu: 'baidu',
        'z-ai': 'z.ai',
        together: 'together',
        groq: 'groq',
        azure: 'microsoft',
        microsoft: 'microsoft',
        amazon: 'amazon',
        bedrock: 'amazon',
        nvidia: 'nvidia',
        nousresearch: 'nous',
        perplexity: 'perplexity',
        minimax: 'minimax',
        inflection: 'inflection',
        liquid: 'liquid',
        stepfun: 'stepfun',
        tencent: 'tencent',
        xiaomi: 'xiaomi',
        writer: 'writer',
        moonshotai: 'moonshot',
        'aion-labs': 'aion-labs',
        allenai: 'allenai',
        'arcee-ai': 'arcee',
        inception: 'inception',
        'prime-intellect': 'prime-intellect',
        upstage: 'upstage',
        opengvlab: 'opengvlab',
        morph: 'morph',
        essentialai: 'essentialai',
        'ibm-granite': 'ibm',
        kwaipilot: 'kwaipilot',
        meituan: 'meituan',
        relace: 'relace',
        'nex-agi': 'nex-agi',
        deepcogito: 'deepcogito',
        switchpoint: 'switchpoint',
    };
    if (prefix && prefixMap[prefix]) {
        return prefixMap[prefix];
    }
    // If model has a prefix/ format and we don't have a specific mapping, use the prefix directly
    if (prefix && prefix.length > 1) {
        return prefix;
    }

    // --- Pattern-based matching (order: most specific first) ---

    // OpenAI model families
    if (lower.startsWith('gpt-') || lower.startsWith('gpt4') || lower.startsWith('chatgpt')) return 'openai';
    if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'openai';
    if (lower.startsWith('ft:gpt') || lower.startsWith('ft:davinci') || lower.startsWith('ft:babbage') || lower.startsWith('ft:ada') || lower.startsWith('ft:curie')) return 'openai';
    if (lower.startsWith('davinci') || lower.startsWith('babbage') || lower.startsWith('curie') || lower.startsWith('ada')) return 'openai';
    if (lower.startsWith('tts-') || lower === 'whisper-1') return 'openai';
    if (lower.startsWith('text-embedding') || lower.startsWith('dall-e') || lower.startsWith('gpt-image')) return 'openai';
    if (lower.includes('omni-moderation')) return 'openai';

    // xAI / Grok
    if (lower.startsWith('grok')) return 'xai';

    // Deepseek
    if (lower.startsWith('deepseek')) return 'deepseek';

    // Google
    if (lower.includes('gemini') || lower.includes('gemma') || lower.startsWith('imagen') || lower.includes('nano-banana') || lower.startsWith('veo-') || lower.includes('learnlm') || lower === 'aqa') return 'google';

    // Anthropic
    if (lower.includes('claude')) return 'anthropic';

    // Meta
    if (lower.includes('llama')) return 'meta';

    // Mistral
    if (lower.includes('mistral') || lower.includes('ministral') || lower.includes('mixtral') || lower.startsWith('codestral') || lower.startsWith('pixtral')) return 'mistral.ai';

    // Alibaba
    if (lower.includes('qwen')) return 'alibaba';

    // Cohere
    if (lower.includes('command')) return 'cohere';

    // Perplexity
    if (lower.includes('sonar') || lower.startsWith('pplx-')) return 'perplexity';

    // Nvidia
    if (lower.includes('nemotron') || lower.includes('llama-3.1-nemotron')) return 'nvidia';

    // AI21
    if (lower.startsWith('jamba') || lower.startsWith('j2-')) return 'ai21';

    // Nous
    if (lower.includes('hermes') || lower.startsWith('nous-')) return 'nous';

    // Additional OpenAI patterns (broader, at end)
    if (/^o\d[-_]/.test(lower)) return 'openai'; // o1-*, o3-*, o4-*
    if (lower.startsWith('sora-') || lower === 'sora') return 'openai'; // Sora video models
    if (lower.startsWith('computer-use-preview') || lower.startsWith('deep-research')) return 'openai'; // Special OpenAI models

    return 'unknown';
}

/**
 * Enhanced model synchronization that:
 * 1. Removes models with 0 providers
 * 2. Adds new models that have at least 1 active provider
 * 3. Updates provider counts for existing models
 * 4. Removes models where their only provider is disabled or doesn't exist
 */
export async function refreshProviderCountsInModelsFile(): Promise<void> {
    const disableSync = (process.env.DISABLE_MODEL_SYNC || '').toLowerCase() !== 'false';
    if (disableSync) {
        console.log('Model sync is disabled (set DISABLE_MODEL_SYNC=false to enable). Skipping models.json update.');
        return;
    }
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
                if (!model.owned_by || model.owned_by === 'unknown') {
                    const guessedOwner = guessOwnedBy(model.id);
                    if (guessedOwner !== model.owned_by) {
                        model.owned_by = guessedOwner;
                        changesMade = true;
                        console.log(`Updated owner for ${model.id}: ${guessedOwner}`);
                    }
                }
                // Dynamic pricing based on provider availability
                const dynamicPrice = calculateDynamicPricing(model.id, newProviderCount);
                if (dynamicPrice) {
                    (model as any).pricing = dynamicPrice;
                    changesMade = true;
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
        const newModelsWithoutCaps: string[] = [];
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
                newModelsWithoutCaps.push(modelId);
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

        // Collect ALL models without capabilities (both new and existing)
        const allModelsWithoutCaps: string[] = [...newModelsWithoutCaps];
        for (const model of updatedModels) {
            if (!newModelsWithoutCaps.includes(model.id) && (!model.capabilities || !Array.isArray(model.capabilities) || model.capabilities.length === 0)) {
                allModelsWithoutCaps.push(model.id);
            }
        }

        // Trigger capability probing for models without capabilities
        if (allModelsWithoutCaps.length > 0) {
            try {
                console.log(`Models without capabilities: ${allModelsWithoutCaps.length} (${newModelsWithoutCaps.length} new, ${allModelsWithoutCaps.length - newModelsWithoutCaps.length} existing).`);
                notifyNewModelsDiscovered(allModelsWithoutCaps);
            } catch (err) {
                console.warn('Failed to notify about models needing probing:', err);
            }
        }

    } catch (error) {
        console.error('Error synchronizing models.json with providers:', error);
    }
}
