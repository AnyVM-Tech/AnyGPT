import { dataManager, LoadedProviders, ModelsFileStructure } from './dataManager.js';
import { notifyNewModelsDiscovered } from './adminKeySync.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isNonChatModel } from './openaiRouteUtils.js';
import { extractRetryAfterMs } from './errorClassification.js';

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
let supplementalPricingCache: Record<string, BasePricing> | null = null;
const API_WORKSPACE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredLogDirectory = (process.env.ANYGPT_LOG_DIR || '').trim();
const LOG_DIR = configuredLogDirectory
    ? path.resolve(configuredLogDirectory)
    : path.resolve(API_WORKSPACE_DIR, 'logs');

type CapabilitiesCache = Record<string, string[]>;
const CAPABILITIES_CACHE_PATH = path.join(LOG_DIR, 'model-capabilities.json');
const PROBE_TESTED_PATH = path.join(LOG_DIR, 'probe-tested.json');

type ProbeTestedFile = {
    data?: Record<string, Record<string, string>>;
    capability_skips?: Record<string, Record<string, string>>;
};

type PricingCache = Record<string, Record<string, any>>;

type LiveProviderCountSummary = {
    providers: number;
    active_providers: number;
    known_providers: number;
    cooling_down_providers: number;
    temporarily_unavailable_providers: number;
};

const CAPABILITY_ORDER = ['text', 'image_input', 'image_output', 'audio_input', 'audio_output', 'tool_calling'] as const;
const PRICING_CACHE_PATH = path.join(LOG_DIR, 'model-pricing.json');
const ROUTER_MODELS_PRICING_PATH = path.resolve(API_WORKSPACE_DIR, 'dev', 'routermodels.json');
const BASE_PRICING_PATH = path.resolve(API_WORKSPACE_DIR, 'pricing.json');
const PROVIDER_COOLDOWN_MS = Math.max(0, Number(process.env.PROVIDER_COOLDOWN_MS ?? 60_000));
const PROVIDER_AUTH_FAILURE_FAST_SKIP_MS = (() => {
    const raw = process.env.PROVIDER_AUTH_FAILURE_FAST_SKIP_MS;
    const parsed = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : 10 * 60 * 1000;
})();
const SHARED_PROVIDER_RETRY_AFTER_SAFETY_MS = (() => {
    const raw = Number(process.env.SHARED_PROVIDER_RETRY_AFTER_SAFETY_MS ?? 350);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 350;
})();

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

function shouldCountProviderModel(modelId: string, modelData: any): boolean {
    if (!modelData || typeof modelData !== 'object') return false;
    if (modelData.disabled === true || modelData.removed === true || modelData.unavailable === true) return false;

    const availability = collectAvailabilityConstraintMetadata(modelData);
    const nonChatType = isNonChatModel(modelId);
    const hasReasonConstraint = availability.reasonTexts.some((reason) => isAvailabilityConstraintReason(reason));

    if (nonChatType === 'image-gen' && (
        typeof availability.skips.image_output === 'string' && availability.skips.image_output.trim()
        || availability.blocked.includes('image_output')
        || hasReasonConstraint
    )) {
        return false;
    }
    if (nonChatType === 'video-gen' && (
        typeof availability.skips.image_output === 'string' && availability.skips.image_output.trim()
        || availability.blocked.includes('image_output')
        || hasReasonConstraint
    )) {
        return false;
    }
    if (nonChatType === 'tts' && (
        typeof availability.skips.audio_output === 'string' && availability.skips.audio_output.trim()
        || availability.blocked.includes('audio_output')
    )) {
        return false;
    }
    if (nonChatType === 'stt' && (
        typeof availability.skips.audio_input === 'string' && availability.skips.audio_input.trim()
        || availability.blocked.includes('audio_input')
    )) {
        return false;
    }
    return true;
}

function isSharedRateLimitProvider(providerId: string): boolean {
    const normalized = String(providerId || '').toLowerCase();
    if (!normalized) return true;
    if (normalized.includes('ollama')) return false;
    if (normalized.includes('mock')) return false;
    if (normalized.includes('local')) return false;
    return true;
}

function getProviderErrorSnapshot(provider: any): {
    message: string;
    code: string;
    status: number | null;
    lastErrorAt: number;
} {
    const message = String(
        provider?.lastError
        || provider?.last_error
        || provider?.disabled_reason
        || provider?.disabledReason
        || ''
    );
    const code = String(provider?.lastErrorCode || provider?.last_error_code || '');
    const statusRaw = Number(provider?.lastStatus || provider?.last_status || 0);
    const lastErrorAtRaw = Number(provider?.lastErrorAt || provider?.last_error_at || 0);
    return {
        message,
        code,
        status: Number.isFinite(statusRaw) && statusRaw > 0 ? Math.floor(statusRaw) : null,
        lastErrorAt: Number.isFinite(lastErrorAtRaw) && lastErrorAtRaw > 0 ? Math.floor(lastErrorAtRaw) : 0,
    };
}

function isPersistedRateLimitSignal(message: string, code: string, status: number | null): boolean {
    const combined = `${message} ${code}`.toLowerCase();
    if (!combined && status === null) return false;
    return (
        status === 429
        || status === 402
        || combined.includes('too many requests')
        || combined.includes('429 too many requests')
        || combined.includes('quota exceeded')
        || combined.includes('quota exhausted')
        || combined.includes('quota limit reached')
        || combined.includes('you exceeded your current quota')
        || combined.includes('resource has been exhausted')
        || combined.includes('resource_exhausted')
        || combined.includes('resource exhausted')
        || combined.includes('insufficient_quota')
        || combined.includes('free tier')
        || combined.includes('retrydelay')
        || combined.includes('retry delay')
        || combined.includes('retryinfo')
        || combined.includes('payment required')
        || combined.includes('generativelanguage.googleapis.com/generate_content')
    );
}

function isPersistedAuthFailureSignal(message: string, code: string, status: number | null): boolean {
    const combined = `${message} ${code}`.toLowerCase();
    if (!combined && status === null) return false;
    return (
        status === 401
        || status === 403
        || combined.includes('api key not found')
        || combined.includes('api key not valid')
        || combined.includes('api key expired')
        || combined.includes('please renew the api key')
        || combined.includes('invalid api key')
        || combined.includes('incorrect api key provided')
        || combined.includes('invalid_api_key')
        || combined.includes('service_disabled')
        || combined.includes('accessnotconfigured')
        || combined.includes('permission denied')
        || combined.includes('forbidden')
        || combined.includes('authentication failed')
        || combined.includes('authentication error')
        || combined.includes('generative language api has not been used in project')
        || combined.includes('generative language api is disabled')
        || combined.includes('gemini_api_disabled')
        || combined.includes('gemini_project_auth_failure')
    );
}

function isPersistedTemporarySkipSignal(message: string, code: string, status: number | null): boolean {
    const combined = `${message} ${code}`.toLowerCase();
    if (isPersistedRateLimitSignal(message, code, status)) return false;
    if (isPersistedAuthFailureSignal(message, code, status)) return true;
    return (
        combined.includes('invalid_response_structure')
        || combined.includes('invalid response structure')
        || combined.includes('empty streaming response')
        || combined.includes('returned an empty streaming response')
        || combined.includes('request timed out after')
        || combined.includes('aborterror')
        || combined.includes('timed out')
    );
}

function getPersistedProviderCooldownRemainingMs(provider: any, modelId: string, now: number): number | null {
    const { message, code, status, lastErrorAt } = getProviderErrorSnapshot(provider);
    if (lastErrorAt <= 0) return null;
    if (!isPersistedRateLimitSignal(message, code, status)) return null;

    const retryAfterMs = extractRetryAfterMs(message);
    const modelData = provider?.models?.[modelId];
    let cooldownMs = Number.isFinite(retryAfterMs as number) && (retryAfterMs as number) > 0
        ? Math.max(1, Math.ceil(retryAfterMs as number))
        : null;

    if (!cooldownMs) {
        const rateLimitWindowMs = Number(modelData?.rate_limit_window_ms ?? 0);
        if (Number.isFinite(rateLimitWindowMs) && rateLimitWindowMs > 0) {
            cooldownMs = Math.max(1_000, Math.min(PROVIDER_COOLDOWN_MS, Math.ceil(rateLimitWindowMs)));
        }
    }

    if (!cooldownMs) {
        const rateLimitRps = Number(modelData?.rate_limit_rps ?? 0);
        if (Number.isFinite(rateLimitRps) && rateLimitRps > 0) {
            cooldownMs = Math.min(
                PROVIDER_COOLDOWN_MS,
                Math.max(1_000, Math.ceil(1_000 / rateLimitRps))
            );
        }
    }

    if (!cooldownMs && PROVIDER_COOLDOWN_MS > 0) {
        cooldownMs = PROVIDER_COOLDOWN_MS;
    }

    if (!cooldownMs || cooldownMs <= 0) return null;
    if (isSharedRateLimitProvider(provider?.id)) {
        cooldownMs += SHARED_PROVIDER_RETRY_AFTER_SAFETY_MS;
    }

    const remainingMs = lastErrorAt + cooldownMs - now;
    return remainingMs > 0 ? remainingMs : null;
}

function classifyActiveProviderAvailability(
    provider: any,
    modelId: string,
    now: number
): 'usable' | 'cooling_down' | 'temporarily_unavailable' {
    const { message, code, status, lastErrorAt } = getProviderErrorSnapshot(provider);
    if (lastErrorAt <= 0) return 'usable';

    const cooldownRemainingMs = getPersistedProviderCooldownRemainingMs(
        provider,
        modelId,
        now
    );
    if (cooldownRemainingMs !== null) {
        return 'cooling_down';
    }

    if (now - lastErrorAt > PROVIDER_AUTH_FAILURE_FAST_SKIP_MS) {
        return 'usable';
    }

    if (isPersistedTemporarySkipSignal(message, code, status)) {
        return 'temporarily_unavailable';
    }

    return 'usable';
}

function collectLiveProviderCountSummaries(
    providersData: LoadedProviders,
    modelIds?: Set<string>,
    now: number = Date.now()
): Record<string, LiveProviderCountSummary> {
    const activeProviderCounts: Record<string, number> = {};
    const usableProviderCounts: Record<string, number> = {};
    const knownProviderCounts: Record<string, number> = {};
    const coolingDownProviderCounts: Record<string, number> = {};
    const temporarilyUnavailableProviderCounts: Record<string, number> = {};

    for (const provider of providersData || []) {
        if (!provider?.models || typeof provider.models !== 'object') continue;
        for (const modelId of Object.keys(provider.models)) {
            if (modelIds && !modelIds.has(modelId)) continue;
            const modelData = provider.models[modelId] as any;
            if (!shouldCountProviderModel(modelId, modelData)) continue;

            knownProviderCounts[modelId] = (knownProviderCounts[modelId] || 0) + 1;

            if (provider.disabled || modelData?.disabled === true) {
                continue;
            }

            activeProviderCounts[modelId] = (activeProviderCounts[modelId] || 0) + 1;
            const availabilityState = classifyActiveProviderAvailability(
                provider,
                modelId,
                now
            );

            if (availabilityState === 'usable') {
                usableProviderCounts[modelId] = (usableProviderCounts[modelId] || 0) + 1;
            } else if (availabilityState === 'cooling_down') {
                coolingDownProviderCounts[modelId] = (coolingDownProviderCounts[modelId] || 0) + 1;
            } else {
                temporarilyUnavailableProviderCounts[modelId] = (temporarilyUnavailableProviderCounts[modelId] || 0) + 1;
            }
        }
    }

    const allModelIds = new Set<string>([
        ...Object.keys(knownProviderCounts),
        ...Object.keys(activeProviderCounts),
        ...Object.keys(usableProviderCounts),
        ...Object.keys(coolingDownProviderCounts),
        ...Object.keys(temporarilyUnavailableProviderCounts),
        ...(modelIds ? [...modelIds] : []),
    ]);

    const summaries: Record<string, LiveProviderCountSummary> = {};
    for (const modelId of allModelIds) {
        summaries[modelId] = {
            providers: usableProviderCounts[modelId] || 0,
            active_providers: activeProviderCounts[modelId] || 0,
            known_providers: knownProviderCounts[modelId] || 0,
            cooling_down_providers: coolingDownProviderCounts[modelId] || 0,
            temporarily_unavailable_providers:
                temporarilyUnavailableProviderCounts[modelId] || 0,
        };
    }
    return summaries;
}

export function applyLiveProviderCountsToModelsData(
    modelsData: ModelsFileStructure,
    providersData: LoadedProviders,
    now: number = Date.now()
): ModelsFileStructure {
    const data = Array.isArray(modelsData?.data) ? modelsData.data : [];
    const modelIds = new Set<string>(
        data
            .map((model) => (typeof model?.id === 'string' ? model.id : ''))
            .filter(Boolean)
    );
    const summaries = collectLiveProviderCountSummaries(
        providersData,
        modelIds,
        now
    );

    return {
        ...modelsData,
        data: data.map((model) => {
            const summary = summaries[model.id] || {
                providers: 0,
                active_providers: 0,
                known_providers: 0,
                cooling_down_providers: 0,
                temporarily_unavailable_providers: 0,
            };
            return {
                ...model,
                providers: summary.providers,
                active_providers: summary.active_providers,
                known_providers: summary.known_providers,
                cooling_down_providers: summary.cooling_down_providers,
                temporarily_unavailable_providers:
                    summary.temporarily_unavailable_providers,
            };
        }),
    };
}

function collectAvailabilityConstraintMetadata(modelData: any): {
    blocked: string[];
    skips: Record<string, string>;
    reasonTexts: string[];
} {
    if (!modelData || typeof modelData !== 'object') {
        return {
            blocked: [],
            skips: {},
            reasonTexts: [],
        };
    }

    const normalizeCapabilityConstraintKey = (key: unknown): string => {
        const normalized = String(key || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (!normalized) return '';
        if (
            normalized === 'image'
            || normalized === 'image_output'
            || normalized === 'image_generation'
            || normalized === 'image_gen'
            || normalized === 'image_output_generation'
            || normalized === 'image_output_gen'
            || normalized === 'image_output_only'
            || normalized === 'image_output_create'
            || normalized === 'image_output_create_only'
            || normalized === 'image_creation'
            || normalized === 'image_generation_unavailable'
            || normalized === 'image_generation_unavailable_in_country'
            || normalized === 'image_generation_unavailable_in_countries'
            || normalized === 'image_generation_unavailable_in_region'
            || normalized === 'image_generation_unavailable_in_regions'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_regions'
            || normalized === 'image_generation_blocked_in_country'
            || normalized === 'image_generation_blocked_in_region'
            || normalized === 'image_generation_blocked_in_provider_region'
            || normalized === 'image_generation_unavailable_in_region'
            || normalized === 'image_generation_unavailable_in_regions'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_regions'
            || normalized === 'generation_unavailable_in_country'
            || normalized === 'generation_unavailable_in_countries'
            || normalized === 'generation_unavailable_in_region'
            || normalized === 'generation_unavailable_in_regions'
            || normalized === 'generation_unavailable_in_provider_region'
            || normalized === 'generation_unavailable_in_provider_regions'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'generation_unavailable_in_country'
            || normalized === 'generation_unavailable_in_region'
            || normalized === 'generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_regions'
            || normalized === 'image_output_unavailable_in_country'
            || normalized === 'image_output_unavailable_in_region'
            || normalized === 'image_output_unavailable_in_provider_region'
            || normalized === 'image_output_unavailable_in_provider_regions'
            || normalized === 'image_output_blocked_in_country'
            || normalized === 'image_output_blocked_in_region'
            || normalized === 'image_output_blocked_in_provider_region'
            || normalized === 'image_output_blocked_in_provider_regions'
            || normalized === 'image_generation_unavailable_in_country'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_regions'
            || normalized === 'image_output_unavailable_in_country'
            || normalized === 'image_output_unavailable_in_provider_region'
            || normalized === 'image_output_unavailable_in_provider_regions'
            || normalized === 'image_output_blocked_in_country'
            || normalized === 'image_output_blocked_in_provider_region'
            || normalized === 'image_output_blocked_in_provider_regions'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_regions'
            || normalized === 'image_output_unavailable_in_country'
            || normalized === 'image_output_unavailable_in_region'
            || normalized === 'image_output_unavailable_in_provider_region'
            || normalized === 'image_output_blocked_in_country'
            || normalized === 'image_output_blocked_in_region'
            || normalized === 'image_output_blocked_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_regions'
            || normalized === 'image_generation_unavailable_in_the_provider_region'
            || normalized === 'image_generation_unavailable_in_the_provider_regions'
            || normalized === 'image_generation_unavailable_in_your_country'
            || normalized === 'image_generation_unavailable_in_your_region'
            || normalized === 'image_generation_unavailable_for_your_country'
            || normalized === 'image_generation_unavailable_for_your_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_country'
            || normalized === 'blocked_in_provider_region'
            || normalized === 'blocked_in_country'
            || normalized === 'provider_region_blocked'
            || normalized === 'country_blocked'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_regions'
            || normalized === 'image_output_unavailable_in_country'
            || normalized === 'image_output_unavailable_in_region'
            || normalized === 'image_output_unavailable_in_provider_region'
            || normalized === 'image_output_unavailable_in_provider_regions'
            || normalized === 'blocked_in_country'
            || normalized === 'blocked_in_region'
            || normalized === 'blocked_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_the_provider_region'
            || normalized === 'image_generation_unavailable_in_your_country'
            || normalized === 'image_generation_unavailable_in_your_region'
            || normalized === 'image_generation_unavailable_for_your_region'
            || normalized === 'image_generation_unavailable_for_your_country'
            || normalized === 'image_generation_blocked_in_country'
            || normalized === 'image_generation_blocked_in_region'
            || normalized === 'image_generation_blocked_in_provider_region'
            || normalized === 'image_output_unavailable_in_country'
            || normalized === 'image_output_unavailable_in_region'
            || normalized === 'image_output_unavailable_in_provider_region'
            || normalized === 'image_output_blocked_in_country'
            || normalized === 'image_output_blocked_in_region'
            || normalized === 'image_output_blocked_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_blocked_in_country'
            || normalized === 'image_generation_blocked_in_region'
            || normalized === 'image_generation_blocked_in_provider_region'
            || normalized === 'blocked_in_country'
            || normalized === 'blocked_in_region'
            || normalized === 'blocked_in_provider_region'
            || normalized === 'provider_region_blocked'
            || normalized === 'country_blocked'
            || normalized === 'region_blocked'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_blocked_in_country'
            || normalized === 'image_generation_blocked_in_region'
            || normalized === 'image_generation_blocked_in_provider_region'
            || normalized === 'blocked_in_country'
            || normalized === 'blocked_in_region'
            || normalized === 'blocked_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_providers_region'
            || normalized === 'image_generation_blocked_in_country'
            || normalized === 'image_generation_blocked_in_region'
            || normalized === 'image_generation_blocked_in_provider_region'
            || normalized === 'image_output_unavailable_in_country'
            || normalized === 'image_output_unavailable_in_region'
            || normalized === 'image_output_unavailable_in_provider_region'
            || normalized === 'image_output_blocked_in_country'
            || normalized === 'image_output_blocked_in_region'
            || normalized === 'image_output_blocked_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_generation_unavailable_in_location'
            || normalized === 'blocked_in_country'
            || normalized === 'blocked_in_region'
            || normalized === 'blocked_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_output_unavailable'
            || normalized === 'image_output_unavailable_in_country'
            || normalized === 'image_output_unavailable_in_region'
            || normalized === 'image_output_unavailable_in_provider_region'
            || normalized === 'blocked_in_country'
            || normalized === 'blocked_in_region'
            || normalized === 'blocked_in_provider_region'
            || normalized === 'image_generation_unavailable_in_provider_region'
            || normalized === 'image_output_unavailable'
            || normalized === 'image_output_unavailable_in_country'
            || normalized === 'image_output_unavailable_in_region'
            || normalized === 'image_output_unavailable_in_provider_region'
            || normalized === 'provider_region_image_output'
            || normalized === 'country_image_output'
            || normalized === 'image_generation_output'
            || normalized === 'image_generation_only'
            || normalized === 'image_generation_create'
            || normalized === 'image_generation_create_output'
            || normalized === 'image_generation_create_only'
            || normalized === 'image_generation_create_capability'
            || normalized === 'image_generation_capability'
            || normalized === 'image_generation_blocked'
            || normalized === 'image_generation_unavailable'
            || normalized === 'image_generation_disabled'
            || normalized === 'image_generation_restricted'
            || normalized === 'image_generation_region_blocked'
            || normalized === 'image_generation_country_blocked'
            || normalized === 'image_generation_geo_blocked'
            || normalized === 'image_generation_geo_restricted'
            || normalized === 'image_generation_not_available'
            || normalized === 'image_generation_not_supported'
            || normalized === 'image_generation_only_blocked'
            || normalized === 'image_generation_only_unavailable'
            || normalized === 'image_create'
            || normalized === 'image_create_only'
            || normalized === 'image_create_capability'
            || normalized === 'image_creation_only'
            || normalized === 'image_creation_capability'
            || normalized === 'images'
            || normalized === 'images_generation'
            || normalized === 'images_create'
            || normalized === 'generate_images'
            || normalized === 'generated_images'
            || normalized === 'image_gen_blocked'
            || normalized === 'image_gen_unavailable'
            || normalized === 'image_output_blocked'
            || normalized === 'image_output_unavailable'
            || normalized === 'image_output_disabled'
            || normalized === 'image_output_restricted'
            || normalized === 'image_output_region_blocked'
            || normalized === 'image_output_country_blocked'
            || normalized === 'image_output_geo_blocked'
            || normalized === 'image_output_not_available'
            || normalized === 'image_output_not_supported'
            || normalized === 'image_generation_unavailable'
            || normalized === 'image_output_unavailable'
            || normalized === 'image_generation_blocked'
            || normalized === 'image_output_blocked'
            || normalized === 'image_generation_region_blocked'
            || normalized === 'image_output_region_blocked'
            || normalized === 'image_generation_country_blocked'
            || normalized === 'image_output_country_blocked'
            || normalized === 'image_generation_create_only'
            || normalized === 'image_generation_create_image'
            || normalized === 'image_generation_create_images'
            || normalized === 'image_generation_unavailable'
            || normalized === 'image_generation_blocked'
            || normalized === 'image_generation_disabled'
            || normalized === 'image_generation_removed'
            || normalized === 'image_generation_create_image'
            || normalized === 'image_generation_create_images'
            || normalized === 'image_generation_unavailable'
            || normalized === 'image_generation_blocked'
            || normalized === 'image_generation_disabled'
            || normalized === 'image_generation_removed'
            || normalized === 'image_output_unavailable'
            || normalized === 'image_output_blocked'
            || normalized === 'image_output_disabled'
            || normalized === 'image_output_removed'
            || normalized === 'image_generation_images'
            || normalized === 'image_generation_image'
            || normalized === 'image_generation_capability'
            || normalized === 'image_output_create'
            || normalized === 'image_output_create_image'
            || normalized === 'image_output_create_images'
            || normalized === 'image_output_images'
            || normalized === 'image_output_image'
        ) return 'image_output';
        if (normalized === 'vision' || normalized === 'image_input_vision') return 'image_input';
        if (
            normalized === 'audio'
            || normalized === 'speech_to_text'
            || normalized === 'speech_input'
            || normalized === 'transcription'
        ) return 'audio_input';
        if (
            normalized === 'text_to_speech'
            || normalized === 'speech'
            || normalized === 'speech_output'
        ) return 'audio_output';
        if (
            normalized === 'tools'
            || normalized === 'function_calling'
            || normalized === 'tool_use'
        ) return 'tool_calling';
        return normalized;
    };

    const blocked = Array.from(new Set([
        ...(Array.isArray(modelData.capability_blocked) ? modelData.capability_blocked : []),
        ...(Array.isArray(modelData.blocked) ? modelData.blocked : []),
        ...(Array.isArray(modelData.availability?.capability_blocked) ? modelData.availability.capability_blocked : []),
        ...(Array.isArray(modelData.availability?.blocked) ? modelData.availability.blocked : []),
    ]
        .map((entry: unknown) => normalizeCapabilityConstraintKey(entry))
        .filter(Boolean)));

    const skips: Record<string, string> = {};
    for (const source of [
        modelData.availability?.capability_skips,
        modelData.availability?.skips,
        modelData.capability_skips,
        modelData.skips,
    ]) {
        if (!source || typeof source !== 'object') continue;
        for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
            const normalizedKey = normalizeCapabilityConstraintKey(key);
            const normalizedValue = String(value || '').trim();
            if (!normalizedKey || !normalizedValue || skips[normalizedKey]) continue;
            skips[normalizedKey] = normalizedValue;
        }
    }

    const reasonTexts = [
        modelData.reason,
        modelData.unavailable_reason,
        modelData.removal_reason,
        modelData.availability?.reason,
        modelData.availability?.unavailable_reason,
        modelData.availability?.removal_reason,
    ]
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);

    return { blocked, skips, reasonTexts };
}

function isAvailabilityConstraintReason(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return false;
    return /provider[_ -]?model[_ -]?removed|provider[_ -]?cap[_ -]?blocked|capability[_ -]?blocked|image generation unavailable|image generation is unavailable|generation unavailable|generation is unavailable|image generation unavailable in (?:the )?(?:provider(?:'s)? )?region(?:s)?|image generation unavailable in (?:the )?country|image generation blocked in (?:the )?(?:provider(?:'s)? )?region(?:s)?|image generation blocked in (?:the )?country|image output blocked in (?:the )?(?:provider(?:'s)? )?region(?:s)?|image output blocked in (?:the )?country|blocked in (?:the )?(?:provider(?:'s)? )?region(?:s)?|blocked in (?:the )?country|image generation unavailable in provider region(?:s)?|image generation is unavailable in (?:the )?(?:provider(?:'s)? )?region(?:s)?|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|unavailable in provider region(?:s)?|unavailable in country|blocked in provider region(?:s)?|blocked in country|provider region(?:s)?|provider-region(?:s)?|regional availability|region(?:al)? availability|country availability|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|unavailable in country|blocked in country|country-blocked|country blocked|unavailable in provider region|blocked in provider region|provider-region|regional availability|region(?:al)? availability|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|generation unavailable in (?:the )?country|generation is unavailable in (?:the )?country|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|image generation unavailable in provider region|image generation is unavailable in provider region|unavailable in country|unavailable in provider region|image generation unavailable in country|image generation is unavailable in country|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|unavailable in provider region|unavailable in country|blocked in provider region|blocked in country|provider region|provider-region|country-blocked|country blocked|regional availability|region(?:al)? availability|region-locked|region locked|geo(?:graph(?:ic)?)? restriction|geo(?:graph(?:ic)?)? restricted|geo-restricted|georestricted|country availability|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|blocked in (?:the )?(?:provider(?:'s)? )?region|blocked in (?:the )?country|not available in (?:the )?country|not available in (?:the )?(?:provider(?:'s)? )?region|provider[_ -]?region|country[_ -]?blocked|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|image generation unavailable in provider region|probe[_ -]?skip|skip(?:ped)?\s+image[_ -]?output|capability[_ -]?blocked|image generation is unavailable in provider region|image generation unavailable for (?:the )?(?:provider(?:'s)? )?region|image generation is unavailable for (?:the )?(?:provider(?:'s)? )?region|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|image generation unavailable for (?:the )?country|image generation is unavailable for (?:the )?country|generation unavailable in (?:the )?(?:provider(?:'s)? )?region|generation is unavailable in (?:the )?(?:provider(?:'s)? )?region|generation unavailable for (?:the )?(?:provider(?:'s)? )?region|generation is unavailable for (?:the )?(?:provider(?:'s)? )?region|generation unavailable in (?:the )?country|generation is unavailable in (?:the )?country|generation unavailable for (?:the )?country|generation is unavailable for (?:the )?country|unavailable in (?:the )?provider(?:'s)? region|unavailable for (?:the )?provider(?:'s)? region|unavailable in provider region|unavailable for provider region|unavailable in country|unavailable for country|provider region|provider-region|blocked in provider region|blocked for provider region|blocked in country|blocked for country|country blocked|country-blocked|region blocked|region-blocked|regional availability|region(?:al)? availability|not available in (?:your |this )?(?:region|country|location)|not available for (?:your |this )?(?:region|country|location)|not supported in (?:your |this )?(?:region|country|location)|blocked in (?:your |this )?(?:region|country|location)|unavailable in (?:your |this )?(?:region|country|location)|unavailable for (?:your |this )?(?:region|country|location)|blocked in country|blocked in provider-region|blocked in-country|blocked in the provider region|image generation unavailable in the provider region|image generation is unavailable in the provider region|generation unavailable in the provider region|generation is unavailable in the provider region|country|country-blocked|country blocked|regional availability|region(?:al)? availability|region-locked|region locked|geo(?:graph(?:ic)?)? restriction|geo(?:graph(?:ic)?)? restricted|geo-restricted|georestricted|country availability|unsupported image output|\bno access\b|access denied|not entitled|not enabled for (?:this )?(?:account|project)|permission denied|forbidden|not available to your account|not available for your account|not available in (?:your |this )?(?:region|country|location)|not available for (?:your |this )?(?:region|country|location)|not supported in (?:your |this )?(?:region|country|location)|blocked in (?:your |this )?(?:region|country|location)|unavailable in (?:your |this |the )?(?:region|country|location)|unavailable for (?:your |this |the )?(?:region|country|location)|(?:region|country|location) is unavailable|unavailable due to (?:region|country|location)|not available in the selected model|no allowed providers are available|model is not available|provider[_ -]?governance|governance drift|provider availability|availability constraint|blocked by provider|provider blocked|provider restriction|provider policy|policy restriction|region blocked|country blocked|geo blocked|regional restriction|country restriction|provider[_ -]?region|provider[_ -]?availability|provider[_ -]?policy|provider[_ -]?restriction|provider[_ -]?blocked|provider[_ -]?disabled|region[_ -]?blocked|country[_ -]?blocked|geo[_ -]?blocked|availability[_ -]?constraint|availability[_ -]?blocked|catalog drift|regional catalog drift|unavailable in (?:the )?provider(?:'s)? region|unavailable for (?:the )?provider(?:'s)? region|image generation unavailable in (?:the )?provider(?:'s)? region|image generation is unavailable in (?:the )?provider(?:'s)? region|image generation unavailable in (?:the )?provider region|image generation is unavailable in (?:the )?provider region|image generation unavailable for (?:the )?provider region|image generation is unavailable for (?:the )?provider region|image generation unavailable in (?:the )?country|image generation is unavailable in (?:the )?country|generation unavailable in (?:the )?provider(?:'s)? region|generation is unavailable in (?:the )?provider(?:'s)? region|generation unavailable for (?:the )?provider(?:'s)? region|generation is unavailable for (?:the )?(?:provider(?:'s)? )?region|generation unavailable in (?:the )?country|generation is unavailable in (?:the )?country|provider[- ]region availability|provider[- ]level availability|provider[- ]country availability|country[- ]level availability|geo[- ]availability|regional catalog|country catalog|available only in selected regions|not available in all regions|not available in this provider region|not available for this provider region|provider region unavailable|country unavailable|region unavailable|unavailable in provider[- ]level region|unavailable for provider[- ]level region|blocked in provider[- ]level region|provider[- ]level region unavailable|image generation unavailable in provider[- ]level region|generation unavailable in provider[- ]level region|image generation unavailable for your country|image generation unavailable for this country|generation unavailable for your country|generation unavailable for this country|image generation unavailable in your country|image generation unavailable in this country|image generation unavailable in your region|image generation unavailable in this region|generation unavailable in your country|generation unavailable in this country|generation unavailable in your region|generation unavailable in this region|not available in provider[- ]country|not available for provider[- ]country|provider[- ]country unavailable|country[- ]restricted|region[- ]restricted|geo[- ]restricted|provider[- ]region blocked|provider[- ]country blocked|provider[- ]level country|provider[- ]level location|location[- ]restricted|location blocked|blocked in provider[- ]location|unavailable in provider[- ]location|unavailable for provider[- ]location/.test(normalized);
}

function hasAvailabilityConstraint(modelId: string, modelData: any): boolean {
    if (!modelData || typeof modelData !== 'object') return false;

    const availability = collectAvailabilityConstraintMetadata(modelData);
    const hasExplicitAvailabilityReason = availability.reasonTexts.some((reason) => isAvailabilityConstraintReason(reason));
    const hasProviderConstraintEventReason = availability.reasonTexts.some((reason) => {
        const normalized = String(reason || '').trim().toLowerCase();
        return normalized.includes('provider_cap_blocked') || normalized.includes('provider_model_removed');
    });
    const hasCapabilityScopedAvailabilityMetadata = availability.blocked.length > 0
        || Object.keys(availability.skips).length > 0;

    if ((hasExplicitAvailabilityReason || hasProviderConstraintEventReason) && hasCapabilityScopedAvailabilityMetadata) {
        return true;
    }
    if (modelData.removed === true || modelData.unavailable === true) {
        return hasExplicitAvailabilityReason || hasProviderConstraintEventReason || hasCapabilityScopedAvailabilityMetadata;
    }
    if (modelData.disabled === true) {
        return hasExplicitAvailabilityReason || hasProviderConstraintEventReason || hasCapabilityScopedAvailabilityMetadata;
    }

    const nonChatType = isNonChatModel(modelId);
    const hasImageConstraint = (
        typeof availability.skips.image_output === 'string' && availability.skips.image_output.trim()
    ) || availability.blocked.includes('image_output');
    const hasAudioOutputConstraint = (
        typeof availability.skips.audio_output === 'string' && availability.skips.audio_output.trim()
    ) || availability.blocked.includes('audio_output');
    const hasAudioInputConstraint = (
        typeof availability.skips.audio_input === 'string' && availability.skips.audio_input.trim()
    ) || availability.blocked.includes('audio_input');

    if (availability.reasonTexts.some((reason) => isAvailabilityConstraintReason(reason)) && (
        hasImageConstraint || hasAudioOutputConstraint || hasAudioInputConstraint
    )) {
        return true;
    }

    if ((nonChatType === 'image-gen' || nonChatType === 'video-gen') && (
        hasImageConstraint
        || availability.reasonTexts.some((reason) => isAvailabilityConstraintReason(reason))
    )) {
        return true;
    }

    if (nonChatType === 'tts' && hasAudioOutputConstraint) {
        return true;
    }

    if (nonChatType === 'stt' && hasAudioInputConstraint) {
        return true;
    }

    return false;
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
        const raw = fs.readFileSync(BASE_PRICING_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        basePricingCache = {
            ...loadSupplementalRouterPricing(),
            ...(parsed.models || {}),
        };
        return basePricingCache!;
    } catch {
        return loadSupplementalRouterPricing();
    }
}

function normalizeRouterPricing(entry: any): BasePricing | null {
    if (!entry || typeof entry !== 'object') return null;
    const prompt = Number.parseFloat(String(entry.prompt ?? '0'));
    const completion = Number.parseFloat(String(entry.completion ?? '0'));
    const image = Number.parseFloat(String(entry.image ?? '0'));
    const request = Number.parseFloat(String(entry.request ?? '0'));
    const MARKUP = 0.95;

    if (!(prompt > 0 || completion > 0 || image > 0 || request > 0)) {
        return null;
    }

    const normalized: BasePricing = {
        input: Number.isFinite(prompt) && prompt > 0 ? Number.parseFloat((prompt * 1e6 * MARKUP).toFixed(6)) : 0,
        output: Number.isFinite(completion) && completion > 0 ? Number.parseFloat((completion * 1e6 * MARKUP).toFixed(6)) : 0,
    };
    if (Number.isFinite(image) && image > 0) {
        normalized.per_image = Number.parseFloat((image * MARKUP).toFixed(8));
    }
    if (Number.isFinite(request) && request > 0) {
        normalized.per_request = Number.parseFloat((request * MARKUP).toFixed(8));
    }
    return normalized;
}

function loadSupplementalRouterPricing(): Record<string, BasePricing> {
    if (supplementalPricingCache) return supplementalPricingCache;
    const next: Record<string, BasePricing> = {};
    try {
        if (!fs.existsSync(ROUTER_MODELS_PRICING_PATH)) {
            supplementalPricingCache = next;
            return next;
        }
        const raw = fs.readFileSync(ROUTER_MODELS_PRICING_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const rows = Array.isArray(parsed?.data) ? parsed.data : [];
        for (const row of rows) {
            const slug = typeof row?.slug === 'string' ? row.slug : '';
            if (!slug) continue;
            const pricing = normalizeRouterPricing(row?.endpoint?.pricing || row?.pricing);
            if (!pricing) continue;
            next[slug] = pricing;
        }
    } catch {
        // Ignore supplemental pricing failures and keep the primary pricing source usable.
    }
    supplementalPricingCache = next;
    return next;
}

function isPricingRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clonePricingRecord(value: Record<string, any>): Record<string, any> {
    return JSON.parse(JSON.stringify(value));
}

function loadPricingCache(): PricingCache {
    try {
        if (!fs.existsSync(PRICING_CACHE_PATH)) return {};
        const raw = fs.readFileSync(PRICING_CACHE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const next: PricingCache = {};
        for (const [modelId, pricing] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof modelId === 'string' && isPricingRecord(pricing)) {
                next[modelId] = clonePricingRecord(pricing);
            }
        }
        return next;
    } catch {
        return {};
    }
}

function savePricingCache(cache: PricingCache): void {
    try {
        fs.mkdirSync(path.dirname(PRICING_CACHE_PATH), { recursive: true });
        fs.writeFileSync(PRICING_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch {
        // Pricing cache write failures should not block model sync.
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

    const bare = stripped;
    const namespace = modelId.includes('/') ? `${modelId.split('/')[0]}/` : '';
    const withoutDateSuffix = bare.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    add(withoutDateSuffix);
    if (namespace) add(`${namespace}${withoutDateSuffix}`);

    const gpt5Match = withoutDateSuffix.match(/^gpt-5(?:\.\d+)?(?:-(pro|mini|nano|chat(?:-latest)?|chat|codex(?:-mini|-max)?|codex))?$/);
    if (gpt5Match) {
        const variant = gpt5Match[1];
        const canonical = variant ? `gpt-5-${variant}` : 'gpt-5';
        add(canonical);
        if (namespace) add(`${namespace}${canonical}`);
        if (!variant || variant === 'chat' || variant === 'chat-latest') {
            add('gpt-5');
            if (namespace) add(`${namespace}gpt-5`);
        }
    }

    if (withoutDateSuffix === 'omni-moderation-latest') {
        add('omni-moderation-2024-09-26');
    }

    if (/^gpt-4o-mini-transcribe(?:-\d{4}-\d{2}-\d{2})?$/i.test(withoutDateSuffix)) {
        add('gpt-4o-mini-transcribe');
    }
    if (/^gpt-4o-transcribe(?:-\d{4}-\d{2}-\d{2})?$/i.test(withoutDateSuffix)) {
        add('gpt-4o-transcribe');
    }
    if (/^gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?$/i.test(withoutDateSuffix)) {
        add('gpt-4o-mini-tts');
    }
    if (/^gpt-audio(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/i.test(withoutDateSuffix)) {
        const audioMatch = withoutDateSuffix.match(/^(gpt-audio(?:-mini)?)/i);
        if (audioMatch?.[1]) add(audioMatch[1].toLowerCase());
    }

    return Array.from(candidates);
}

function buildZeroPricing(): Record<string, any> {
    return {
        input: 0,
        output: 0,
        unit: 'per_million_tokens',
    };
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

    if (shown.input === undefined) {
        shown.input = 0;
    }
    if (shown.output === undefined) {
        shown.output = 0;
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
 * 1. Removes models with 0 providers unless they are preserved as explicit availability-constrained entries
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
        const pricingCache = loadPricingCache();
        const probeTested = loadProbeTested();
        const probeData = probeTested.data || {};
        const probeSkips = probeTested.capability_skips || {};

        // Calculate provider counts and average TPS for each model ID.
        // `activeProviderCounts` only includes currently enabled providers.
        // `knownProviderCounts` includes providers even when temporarily disabled,
        // and remains useful for diagnostics and pricing heuristics.
        const activeProviderCounts: { [modelId: string]: number } = {};
        const usableProviderCounts: { [modelId: string]: number } = {};
        const knownProviderCounts: { [modelId: string]: number } = {};
        const coolingDownProviderCounts: { [modelId: string]: number } = {};
        const temporarilyUnavailableProviderCounts: { [modelId: string]: number } = {};
        const catalogProviderCounts: { [modelId: string]: number } = {};
        const availableModelIds = new Set<string>();
        const constrainedModelIds = new Set<string>();
        const constrainedCatalogModelIds = new Set<string>();
        const modelTpsSamples: { [modelId: string]: number[] } = {};
        const runtimeNow = Date.now();

        for (const provider of providersData) {
            if (!provider.models) continue;
            for (const modelId in provider.models) {
                const modelData = provider.models[modelId] as any;
                const hasConstraint = hasAvailabilityConstraint(modelId, modelData);
                const isConstraintCatalogPresent = !!modelData
                    && hasConstraint
                    && (
                        !provider.disabled
                        || modelData?.removed === true
                        || modelData?.unavailable === true
                        || modelData?.disabled === true
                    );
                const providerConstraintEntries = Array.isArray((provider as any)?.capability_blocked)
                    ? (provider as any).capability_blocked
                    : [];
                const providerHasAvailabilityConstraint = providerConstraintEntries.some((entry: any) => {
                        const normalizedEntry = typeof entry === 'string'
                            ? entry.trim()
                            : entry && typeof entry === 'object'
                                ? JSON.stringify(entry)
                                : String(entry || '').trim();
                        const structuredReasonTexts = entry && typeof entry === 'object'
                            ? [
                                (entry as any).reason,
                                (entry as any).message,
                                (entry as any).detail,
                                (entry as any).capability,
                                (entry as any).modelId,
                            ]
                                .map((value) => String(value || '').trim())
                                .filter(Boolean)
                            : [];
                        return normalizedEntry.length > 0
                            && (
                                isAvailabilityConstraintReason(normalizedEntry)
                                || structuredReasonTexts.some((value) => isAvailabilityConstraintReason(value))
                            )
                            && hasAvailabilityConstraint(modelId, {
                                availability: {
                                    capability_blocked: [entry as any],
                                    reason: normalizedEntry,
                                },
                                reason: normalizedEntry,
                            });
                    });
                const hasAvailabilityMetadata = !!modelData && (
                    modelData?.availability
                    || providerHasAvailabilityConstraint
                    || (Array.isArray(modelData?.capability_blocked) && modelData.capability_blocked.length > 0)
                    || (Array.isArray(modelData?.availability?.capability_blocked) && modelData.availability.capability_blocked.length > 0)
                    || (Array.isArray(modelData?.blocked) && modelData.blocked.length > 0)
                    || (Array.isArray(modelData?.availability?.blocked) && modelData.availability.blocked.length > 0)
                    || (modelData?.skips && typeof modelData.skips === 'object' && Object.keys(modelData.skips).length > 0)
                    || (modelData?.availability?.skips && typeof modelData.availability.skips === 'object' && Object.keys(modelData.availability.skips).length > 0)
                );
                const isActiveCatalogPresent = !!modelData
                    && !provider.disabled
                    && !modelData?.disabled
                    && (!modelData?.unavailable || hasConstraint || hasAvailabilityMetadata)
                    && (!modelData?.removed || hasConstraint || hasAvailabilityMetadata);
                if (hasConstraint) {
                    constrainedModelIds.add(modelId);
                    if (isConstraintCatalogPresent || providerHasAvailabilityConstraint) {
                        constrainedCatalogModelIds.add(modelId);
                    }
                } else if (isActiveCatalogPresent) {
                    availableModelIds.add(modelId);
                }
                if (isActiveCatalogPresent || isConstraintCatalogPresent) {
                    catalogProviderCounts[modelId] = (catalogProviderCounts[modelId] || 0) + 1;
                }
                if (!shouldCountProviderModel(modelId, modelData)) {
                    continue;
                }
                knownProviderCounts[modelId] = (knownProviderCounts[modelId] || 0) + 1;

                if (!provider.disabled) { // Consider a provider active if 'disabled' is false or undefined
                    activeProviderCounts[modelId] = (activeProviderCounts[modelId] || 0) + 1;
                    const availabilityState = classifyActiveProviderAvailability(
                        provider,
                        modelId,
                        runtimeNow
                    );
                    if (availabilityState === 'usable') {
                        usableProviderCounts[modelId] = (usableProviderCounts[modelId] || 0) + 1;
                    } else if (availabilityState === 'cooling_down') {
                        coolingDownProviderCounts[modelId] = (coolingDownProviderCounts[modelId] || 0) + 1;
                    } else {
                        temporarilyUnavailableProviderCounts[modelId] = (temporarilyUnavailableProviderCounts[modelId] || 0) + 1;
                    }
                    if (!modelData?.disabled && !modelData?.unavailable && !modelData?.removed && !hasConstraint) {
                        availableModelIds.add(modelId);
                    }
                } else if (hasConstraint) {
                    constrainedModelIds.add(modelId);

                    // Collect TPS data for throughput calculation
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
            const newProviderCount = usableProviderCounts[model.id] || 0;
            const activeProviderCount = activeProviderCounts[model.id] || 0;
            const knownProviderCount = knownProviderCounts[model.id] || 0;
            const coolingDownProviderCount = coolingDownProviderCounts[model.id] || 0;
            const temporarilyUnavailableProviderCount = temporarilyUnavailableProviderCounts[model.id] || 0;
            const isConstrained = constrainedModelIds.has(model.id);
            const shouldRetainAsConstrained = activeProviderCount === 0 && isConstrained;
            const rememberedCaps = getRememberedCapabilities(model.id, model.capabilities, capabilitiesCache, probeData);
            if (isPricingRecord((model as any).pricing)) {
                pricingCache[model.id] = clonePricingRecord((model as any).pricing);
            }

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
            
            if (activeProviderCount > 0 || shouldRetainAsConstrained) {
                if (model.providers !== newProviderCount) {
                    const oldProviderCount = model.providers;
                    model.providers = newProviderCount;
                    changesMade = true;
                    if (shouldRetainAsConstrained) {
                        console.log(`Retained ${model.id} with 0 active providers due to availability constraints (${oldProviderCount} -> ${newProviderCount})`);
                    } else {
                        console.log(`Updated provider count for ${model.id}: ${oldProviderCount} -> ${newProviderCount}`);
                    }
                }
                if ((model as any).active_providers !== activeProviderCount) {
                    (model as any).active_providers = activeProviderCount;
                    changesMade = true;
                }
                if ((model as any).known_providers !== knownProviderCount) {
                    (model as any).known_providers = knownProviderCount;
                    changesMade = true;
                }
                if ((model as any).cooling_down_providers !== coolingDownProviderCount) {
                    (model as any).cooling_down_providers = coolingDownProviderCount;
                    changesMade = true;
                }
                if ((model as any).temporarily_unavailable_providers !== temporarilyUnavailableProviderCount) {
                    (model as any).temporarily_unavailable_providers = temporarilyUnavailableProviderCount;
                    changesMade = true;
                }
                if (!model.owned_by || model.owned_by === 'unknown') {
                    const guessedOwner = guessOwnedBy(model.id);
                    if (guessedOwner !== model.owned_by) {
                        model.owned_by = guessedOwner;
                        changesMade = true;
                        console.log(`Updated owner for ${model.id}: ${guessedOwner}`);
                    }
                }
                if (activeProviderCount > 0) {
                    // Dynamic pricing based on provider availability
                    const dynamicPrice = calculateDynamicPricing(model.id, Math.max(activeProviderCount, knownProviderCount));
                    const rememberedPricing = isPricingRecord(pricingCache[model.id]) ? pricingCache[model.id] : null;
                    const nextPricing = dynamicPrice
                        ? clonePricingRecord(dynamicPrice)
                        : (rememberedPricing ? clonePricingRecord(rememberedPricing) : buildZeroPricing());
                    if (JSON.stringify((model as any).pricing || null) !== JSON.stringify(nextPricing)) {
                        (model as any).pricing = nextPricing;
                        changesMade = true;
                    }
                    pricingCache[model.id] = clonePricingRecord((model as any).pricing);
                    // Update throughput from real provider TPS data
                    const realThroughput = modelThroughput[model.id];
                    if (realThroughput && realThroughput > 0) {
                        const currentThroughput = (model as any).throughput;
                        if (currentThroughput !== realThroughput) {
                            (model as any).throughput = realThroughput;
                            changesMade = true;
                        }
                    }
                } else if (shouldRetainAsConstrained) {
                    console.log(`Retaining ${model.id} with 0 active providers because only availability-constrained providers remain.`);
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
                const providerCount = usableProviderCounts[modelId] ?? 0;
                const activeProviderCount = activeProviderCounts[modelId] ?? 0;
                const knownProviderCount = knownProviderCounts[modelId] ?? 0;
                const coolingDownProviderCount = coolingDownProviderCounts[modelId] ?? 0;
                const temporarilyUnavailableProviderCount = temporarilyUnavailableProviderCounts[modelId] ?? 0;
                if (activeProviderCount <= 0) {
                    continue;
                }
                const newModel: any = {
                    id: modelId,
                    object: MODEL_OBJECT_TYPE,
                    created: Date.now(),
                    owned_by: guessOwnedBy(modelId),
                    providers: providerCount,
                    active_providers: activeProviderCount,
                    known_providers: knownProviderCount,
                    cooling_down_providers: coolingDownProviderCount,
                    temporarily_unavailable_providers: temporarilyUnavailableProviderCount,
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
                const dynamicPrice = calculateDynamicPricing(modelId, Math.max(activeProviderCount, knownProviderCount));
                const rememberedPricing = isPricingRecord(pricingCache[modelId]) ? pricingCache[modelId] : null;
                newModel.pricing = dynamicPrice
                    ? clonePricingRecord(dynamicPrice)
                    : (rememberedPricing ? clonePricingRecord(rememberedPricing) : buildZeroPricing());
                pricingCache[modelId] = clonePricingRecord(newModel.pricing);
                updatedModels.push(newModel);
                if (!Array.isArray(newModel.capabilities) || newModel.capabilities.length === 0) {
                    newModelsWithoutCaps.push(modelId);
                }
                console.log(`Added new model ${modelId} with ${providerCount} usable / ${activeProviderCount} active / ${knownProviderCount} known provider(s), owned by: ${newModel.owned_by}`);
                changesMade = true;
            }
        }

        for (const modelId of constrainedModelIds) {
            if (existingModelIds.has(modelId)) continue;
            if (updatedModels.some((model) => model.id === modelId)) continue;

            const newModel: any = {
                id: modelId,
                object: MODEL_OBJECT_TYPE,
                created: Date.now(),
                owned_by: guessOwnedBy(modelId),
                providers: 0,
                active_providers: 0,
                known_providers: knownProviderCounts[modelId] ?? 0,
                cooling_down_providers: coolingDownProviderCounts[modelId] ?? 0,
                temporarily_unavailable_providers: temporarilyUnavailableProviderCounts[modelId] ?? 0,
                throughput: 50,
            };
            const rememberedCaps = getRememberedCapabilities(modelId, undefined, capabilitiesCache, probeData);
            if (rememberedCaps.length > 0) {
                newModel.capabilities = [...rememberedCaps];
                const cachedCaps = capabilitiesCache[modelId];
                if (!cachedCaps || !areCapabilitiesEqual(cachedCaps, rememberedCaps)) {
                    capabilitiesCache[modelId] = [...rememberedCaps];
                }
            }
            const rememberedPricing = isPricingRecord(pricingCache[modelId]) ? pricingCache[modelId] : null;
            newModel.pricing = rememberedPricing
                ? clonePricingRecord(rememberedPricing)
                : buildZeroPricing();
            pricingCache[modelId] = clonePricingRecord(newModel.pricing);
            updatedModels.push(newModel);
            console.log(`Retained constrained model ${modelId} with 0 active providers due to availability constraints.`);
            changesMade = true;
        }

        // Normalize key order for consistent JSON output
        const KEY_ORDER = [
            'id',
            'object',
            'created',
            'owned_by',
            'providers',
            'active_providers',
            'known_providers',
            'cooling_down_providers',
            'temporarily_unavailable_providers',
            'throughput',
            'capabilities',
            'pricing'
        ];
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
        if (Object.keys(pricingCache).length > 0) {
            savePricingCache(pricingCache);
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
