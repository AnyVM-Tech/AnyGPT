import { dataManager, LoadedProviders, ModelsFileStructure } from './dataManager.js';
import { notifyNewModelsDiscovered } from './adminKeySync.js';
import * as fs from 'fs';
import * as path from 'path';

// --- Dynamic Pricing ---
// Loads base pricing from pricing.json and adjusts based on provider count
// Low providers = higher price (scarcity), many providers = lower price (abundance)
const COMP_BASE_RATE = 0.0233; // Competitor ULTRA effective rate per M tokens
const UNDERCUT_FACTOR = 0.80;  // 20% cheaper than competitor
const MODEL_OBJECT_TYPE = 'model' as const;

interface BasePricing {
    input: number;
    output: number;
    audio_input?: number;
    audio_output?: number;
    per_image?: number;
    per_request?: number;
    image_input?: number;
}

/**
 * Extracts a token-per-second (TPS) value from raw model metadata.
 *
 * Priority:
 *  - Prefer `avg_token_speed` when it is a positive number.
 *  - Fallback to `token_generation_speed` when it is a positive number.
 *
 * Notes:
 *  - Some providers report `token_generation_speed === 50` as a default/sentinel
 *    value that does not reflect real throughput; we explicitly exclude that.
 *  - Returns `null` if no valid TPS metric is available.
 */
function extractTokenSpeed(modelData: any): number | null {
    const avgSpeed = modelData?.avg_token_speed;
    if (typeof avgSpeed === 'number' && avgSpeed > 0) {
        return avgSpeed;
    }

    const genSpeed = modelData?.token_generation_speed;
    if (typeof genSpeed === 'number' && genSpeed > 0 && genSpeed !== 50) {
        return genSpeed;
    }

    return null;
}

let basePricingCache: Record<string, BasePricing> | null = null;
let competitorMultsCache: Record<string, number> | null = null;

type CapabilitiesCache = Record<string, string[]>;
const CAPABILITIES_CACHE_PATH = path.resolve('logs', 'model-capabilities.json');
const PROBE_TESTED_PATH = path.resolve('logs', 'probe-tested.json');

type ProbeTestedFile = {
    data?: Record<string, Record<string, string>>;
    capability_skips?: Record<string, Record<string, string>>;
};

const CAPABILITY_ORDER = ['text', 'image_input', 'image_output', 'audio_input', 'audio_output', 'tool_calling'] as const;

function normalizeCapabilities(caps: Iterable<string>): string[] {
    const unique = new Set<string>();
    for (const cap of caps) {
        if (typeof cap === 'string' && cap.length > 0) unique.add(cap);
    }

    const ordered: string[] = [];
    for (const cap of CAPABILITY_ORDER) {
        if (unique.delete(cap)) ordered.push(cap);
    }
    ordered.push(...unique);
    return ordered;
}

function inferCapabilitiesFromStoredResults(entry?: Record<string, string>): string[] {
    if (!entry) return [];
    return CAPABILITY_ORDER.filter((cap) => typeof entry[cap] === 'string' && entry[cap]!.toLowerCase().startsWith('ok'));
}

function getRememberedCapabilities(
    modelId: string,
    currentCapabilities: string[] | undefined,
    capabilitiesCache: CapabilitiesCache,
    probeData: Record<string, Record<string, string>>
): string[] {
    const current = Array.isArray(currentCapabilities)
        ? currentCapabilities.filter((cap): cap is string => typeof cap === 'string' && cap.length > 0)
        : [];
    const cached = Array.isArray(capabilitiesCache[modelId])
        ? capabilitiesCache[modelId].filter((cap): cap is string => typeof cap === 'string' && cap.length > 0)
        : [];
    const stored = inferCapabilitiesFromStoredResults(probeData[modelId]);
    return normalizeCapabilities([...current, ...cached, ...stored]);
}

function loadCapabilitiesCache(): CapabilitiesCache {
    try {
        if (!fs.existsSync(CAPABILITIES_CACHE_PATH)) return {};
        const raw = fs.readFileSync(CAPABILITIES_CACHE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const normalized: CapabilitiesCache = {};
        for (const [modelId, caps] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(caps)) {
                const filtered = (caps as unknown[]).filter((cap): cap is string => typeof cap === 'string' && cap.length > 0);
                if (filtered.length > 0) normalized[modelId] = filtered;
            }
        }
        return normalized;
    } catch {
        return {};
    }
}

function saveCapabilitiesCache(cache: CapabilitiesCache): void {
    try {
        fs.mkdirSync(path.dirname(CAPABILITIES_CACHE_PATH), { recursive: true });
        fs.writeFileSync(CAPABILITIES_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch {
        // Ignore cache write failures; should not block model sync.
    }
}

function loadProbeTested(): ProbeTestedFile {
    try {
        if (!fs.existsSync(PROBE_TESTED_PATH)) return { data: {}, capability_skips: {} };
        const raw = fs.readFileSync(PROBE_TESTED_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { data: {}, capability_skips: {} };
        if (!parsed.data || typeof parsed.data !== 'object') parsed.data = {};
        if (!parsed.capability_skips || typeof parsed.capability_skips !== 'object') parsed.capability_skips = {};
        return parsed as ProbeTestedFile;
    } catch {
        return { data: {}, capability_skips: {} };
    }
}

function isProbeEntryEmpty(entry?: Record<string, string>): boolean {
    return !entry || Object.keys(entry).length === 0;
}

function areCapabilitiesEqual(a: string[] | undefined, b: string[] | undefined): boolean {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

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

function isFreeModelId(modelId: string): boolean {
    return modelId.endsWith(':free') || modelId === 'openrouter/free';
}

function buildPricingCandidates(modelId: string): string[] {
    const candidates = new Set<string>();
    const add = (value?: string | null) => {
        if (!value) return;
        candidates.add(value);
    };

    add(modelId);
    const stripped = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
    add(stripped);

    if (modelId.endsWith(':free')) {
        const withoutFree = modelId.slice(0, -5);
        add(withoutFree);
        add(withoutFree.includes('/') ? withoutFree.split('/').pop()! : withoutFree);
    }

    if (modelId.endsWith(':exacto')) {
        const withoutExacto = modelId.slice(0, -7);
        add(withoutExacto);
        add(withoutExacto.includes('/') ? withoutExacto.split('/').pop()! : withoutExacto);
    }

    if (modelId.includes('-thinking')) {
        const withoutThinking = modelId.replace('-thinking', '');
        add(withoutThinking);
        add(withoutThinking.includes('/') ? withoutThinking.split('/').pop()! : withoutThinking);

        const collapsedThinking = modelId.replace('-thinking-', '-');
        add(collapsedThinking);
        add(collapsedThinking.includes('/') ? collapsedThinking.split('/').pop()! : collapsedThinking);

        const instructVariant = modelId.replace('-thinking', '-instruct');
        add(instructVariant);
        add(instructVariant.includes('/') ? instructVariant.split('/').pop()! : instructVariant);
    }

    return Array.from(candidates);
}

function resolveBasePricing(modelId: string, basePricing: Record<string, BasePricing>): BasePricing | null {
    for (const candidate of buildPricingCandidates(modelId)) {
        const price = basePricing[candidate];
        if (price) return price;
    }
    return null;
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

const TOKEN_PRICE_DECIMALS = 6;
const SPECIAL_PRICE_DECIMALS = 8;

function roundTo(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

export function calculateDynamicPricing(modelId: string, providerCount: number): Record<string, any> | null {
    const basePricing = loadBasePricing();
    const isFree = isFreeModelId(modelId);
    const price = resolveBasePricing(modelId, basePricing);
    if (!price) {
        if (isFree || modelId.startsWith('openrouter/')) {
            return { input: 0, output: 0, unit: 'per_million_tokens' };
        }
        return null;
    }
    if (isFree) {
        return { input: 0, output: 0, unit: 'per_million_tokens' };
    }

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
        shown.input = roundTo(targetBlended * 2 * ratio, TOKEN_PRICE_DECIMALS);
        shown.output = roundTo(targetBlended * 2 * (1 - ratio), TOKEN_PRICE_DECIMALS);
    } else if (inp > 0) {
        shown.input = roundTo(targetBlended, TOKEN_PRICE_DECIMALS);
        shown.output = 0;
    } else if (out > 0) {
        shown.input = 0;
        shown.output = roundTo(targetBlended, TOKEN_PRICE_DECIMALS);
    }

    // Special pricing (audio, image) — scale with availability
    // Floor at 5% so audio pricing doesn't drop to zero for high provider counts.
    const specialDiscount = Math.max(0.05, 0.10 - availDiscount * 0.5); // 5-10% of official
    if (price.audio_input) shown.audio_input = roundTo(price.audio_input * specialDiscount, TOKEN_PRICE_DECIMALS);
    if (price.audio_output) shown.audio_output = roundTo(price.audio_output * specialDiscount, TOKEN_PRICE_DECIMALS);
    if (price.per_image) shown.per_image = roundTo(price.per_image * 0.20, SPECIAL_PRICE_DECIMALS);
    if (price.per_request) shown.per_request = roundTo(price.per_request * 0.20, SPECIAL_PRICE_DECIMALS);
    if (price.image_input) shown.image_input = roundTo(price.image_input * 0.20, SPECIAL_PRICE_DECIMALS);

    if (shown.input === undefined && shown.output === undefined) {
        if (price.per_image || price.per_request || price.image_input) {
            shown.input = 0;
            shown.output = 0;
        } else if (inp > 0) {
            shown.input = roundTo(targetBlended, TOKEN_PRICE_DECIMALS);
            shown.output = 0;
        } else if (out > 0) {
            shown.input = 0;
            shown.output = roundTo(targetBlended, TOKEN_PRICE_DECIMALS);
        }
    }

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
 * 4. Rehydrates remembered capabilities so re-added models do not need to be re-probed
 */
export async function refreshProviderCountsInModelsFile(options: { notifyProbes?: boolean } = {}): Promise<void> {
    const notifyProbes = options.notifyProbes ?? true;
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

        const capabilitiesCache = loadCapabilitiesCache();
        const probeTested = loadProbeTested();
        const probeData = probeTested.data || {};
        const probeSkips = probeTested.capability_skips || {};

        // Calculate provider counts and average TPS for each model ID.
        // `activeProviderCounts` only includes currently enabled providers.
        // `knownProviderCounts` includes providers even when temporarily disabled,
        // and remains useful for diagnostics and pricing heuristics.
        const activeProviderCounts: { [modelId: string]: number } = {};
        const knownProviderCounts: { [modelId: string]: number } = {};
        const availableModelIds = new Set<string>();
        const modelTpsSamples: { [modelId: string]: number[] } = {};

        for (const provider of providersData) {
            if (!provider.models) continue;
            for (const modelId in provider.models) {
                knownProviderCounts[modelId] = (knownProviderCounts[modelId] || 0) + 1;

                if (!provider.disabled) { // Consider a provider active if 'disabled' is false or undefined
                    activeProviderCounts[modelId] = (activeProviderCounts[modelId] || 0) + 1;
                    availableModelIds.add(modelId);

                    // Collect TPS data for throughput calculation
                    const modelData = provider.models[modelId] as any;
                    const tps = extractTokenSpeed(modelData);
                    if (tps !== null && tps > 0.1 && tps < 5000) { // Filter outliers
                        if (!modelTpsSamples[modelId]) modelTpsSamples[modelId] = [];
                        modelTpsSamples[modelId].push(tps);
                    }
                }
            }
        }

        // Calculate average throughput per model (median to reduce outlier impact)
        const modelThroughput: { [modelId: string]: number } = {};
        for (const [modelId, samples] of Object.entries(modelTpsSamples)) {
            if (samples.length >= 1) {
                samples.sort((a, b) => a - b);
                const median = samples.length % 2 === 0
                    ? (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2
                    : samples[Math.floor(samples.length / 2)];
                modelThroughput[modelId] = Math.round(median);
            }
        }

        let changesMade = false;
        const updatedModels: ModelsFileStructure['data'] = [];

        // Process existing models
        for (const model of modelsFile.data) {
            const newProviderCount = activeProviderCounts[model.id] || 0;
            const knownProviderCount = knownProviderCounts[model.id] || 0;
            const rememberedCaps = getRememberedCapabilities(model.id, model.capabilities, capabilitiesCache, probeData);

            if (rememberedCaps.length > 0) {
                const currentCaps = Array.isArray(model.capabilities)
                    ? model.capabilities.filter((cap): cap is string => typeof cap === 'string' && cap.length > 0)
                    : [];
                if (!areCapabilitiesEqual(currentCaps, rememberedCaps)) {
                    model.capabilities = [...rememberedCaps];
                    changesMade = true;
                }
                const cachedCaps = capabilitiesCache[model.id];
                if (!cachedCaps || !areCapabilitiesEqual(cachedCaps, rememberedCaps)) {
                    capabilitiesCache[model.id] = [...rememberedCaps];
                }
            }
            
            if (newProviderCount > 0) {
                if (model.providers !== newProviderCount) {
                    const oldProviderCount = model.providers;
                    model.providers = newProviderCount;
                    changesMade = true;
                    console.log(`Updated provider count for ${model.id}: ${oldProviderCount} -> ${newProviderCount}`);
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
                const dynamicPrice = calculateDynamicPricing(model.id, Math.max(newProviderCount, knownProviderCount));
                if (dynamicPrice && JSON.stringify((model as any).pricing || null) !== JSON.stringify(dynamicPrice)) {
                    (model as any).pricing = dynamicPrice;
                    changesMade = true;
                }
                // Update throughput from real provider TPS data
                const realThroughput = modelThroughput[model.id];
                if (realThroughput && realThroughput > 0) {
                    const currentThroughput = (model as any).throughput;
                    if (currentThroughput !== realThroughput) {
                        (model as any).throughput = realThroughput;
                        changesMade = true;
                    }
                }
                updatedModels.push(model);
            } else {
                const reason = knownProviderCount > 0
                    ? `${knownProviderCount} provider(s) still advertise it, but none are currently active`
                    : 'no providers advertise it anymore';
                console.log(`Removing model ${model.id}: ${reason}`);
                changesMade = true;
            }
        }

        // Add new models only when they have at least one currently active provider.
        const existingModelIds = new Set(modelsFile.data.map(model => model.id));
        const newModelsWithoutCaps: string[] = [];
        for (const modelId of availableModelIds) {
            if (!existingModelIds.has(modelId)) {
                const providerCount = activeProviderCounts[modelId] ?? 0;
                const knownProviderCount = knownProviderCounts[modelId] ?? 0;
                if (providerCount <= 0) {
                    continue;
                }
                const newModel: any = {
                    id: modelId,
                    object: MODEL_OBJECT_TYPE,
                    created: Date.now(),
                    owned_by: guessOwnedBy(modelId),
                    providers: providerCount,
                    throughput: modelThroughput[modelId] || 50
                };
                const rememberedCaps = getRememberedCapabilities(modelId, undefined, capabilitiesCache, probeData);
                if (rememberedCaps.length > 0) {
                    newModel.capabilities = [...rememberedCaps];
                    const cachedCaps = capabilitiesCache[modelId];
                    if (!cachedCaps || !areCapabilitiesEqual(cachedCaps, rememberedCaps)) {
                        capabilitiesCache[modelId] = [...rememberedCaps];
                    }
                }
                const dynamicPrice = calculateDynamicPricing(modelId, Math.max(providerCount, knownProviderCount));
                if (dynamicPrice) {
                    newModel.pricing = dynamicPrice;
                }
                updatedModels.push(newModel);
                if (!Array.isArray(newModel.capabilities) || newModel.capabilities.length === 0) {
                    newModelsWithoutCaps.push(modelId);
                }
                console.log(`Added new model ${modelId} with ${providerCount} active / ${knownProviderCount} known provider(s), owned by: ${newModel.owned_by}`);
                changesMade = true;
            }
        }

        // Normalize key order for consistent JSON output
        const KEY_ORDER = ['id', 'object', 'created', 'owned_by', 'providers', 'throughput', 'capabilities', 'pricing'];
        const normalizedModels = updatedModels.map((m: any) => {
            const ordered: any = {};
            for (const k of KEY_ORDER) {
                if (k in m) ordered[k] = m[k];
            }
            for (const k of Object.keys(m)) {
                if (!(k in ordered)) ordered[k] = m[k];
            }
            return ordered;
        });

        // Update the models file if changes were made
        if (changesMade) {
            modelsFile.data = normalizedModels;
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

        // Track models that still have no capabilities and no probe history.
        const modelsWithoutProbe: string[] = [];
        for (const model of updatedModels) {
            if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
                continue;
            }
            const dataEntry = probeData[model.id];
            const skipEntry = probeSkips[model.id];
            if (isProbeEntryEmpty(dataEntry) && isProbeEntryEmpty(skipEntry)) {
                modelsWithoutProbe.push(model.id);
            }
        }

        if (Object.keys(capabilitiesCache).length > 0) {
            saveCapabilitiesCache(capabilitiesCache);
        }

        // Trigger capability probing for models without capabilities
        const modelsNeedingProbe = Array.from(new Set([...allModelsWithoutCaps, ...modelsWithoutProbe]));
        const disableProbeNotify = !notifyProbes || (process.env.DISABLE_MODEL_PROBE_NOTIFY || '').toLowerCase() === 'true';
        if (modelsNeedingProbe.length > 0 && !disableProbeNotify) {
            try {
                if (allModelsWithoutCaps.length > 0) {
                    console.log(`Models without capabilities: ${allModelsWithoutCaps.length} (${newModelsWithoutCaps.length} new, ${allModelsWithoutCaps.length - newModelsWithoutCaps.length} existing).`);
                }
                if (modelsWithoutProbe.length > 0) {
                    console.log(`Models without probe history: ${modelsWithoutProbe.length}.`);
                }
                notifyNewModelsDiscovered(modelsNeedingProbe);
            } catch (err) {
                console.warn('Failed to notify about models needing probing:', err);
            }
        }

    } catch (error) {
        console.error('Error synchronizing models.json with providers:', error);
    }
}
