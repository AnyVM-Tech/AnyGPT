import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import { dataManager, LoadedProviders, ModelsFileStructure } from '../modules/dataManager.js'; // For serving the main models.json
import { logError } from '../modules/errorLogger.js'; // Changed import
import { enforceInMemoryRateLimit, RequestTimestampStore } from '../modules/rateLimit.js';
import { extractBearerToken, readTierRateLimitsFromEnv, runAuthMiddleware, runIpRateLimitMiddleware } from '../modules/middlewareFactory.js';
import { validateApiKeyAndUsage } from '../modules/userData.js';
import { buildPublicPlanPayload, filterModelsForTier } from '../modules/planAccess.js';
import { applyLiveProviderCountsToModelsData } from '../modules/modelUpdater.js';

const modelsRouter = new HyperExpress.Router();

const publicModelsRequestStore: RequestTimestampStore = {};
const adminModelsRequestStore: RequestTimestampStore = {};
const publicModelsRateLimits = readTierRateLimitsFromEnv('PUBLIC_MODELS', { rps: 10, rpm: 120, rpd: 5000 });
const adminRouteRateLimits = readTierRateLimitsFromEnv('ADMIN_ROUTE_RATE_LIMIT', { rps: 10, rpm: 300, rpd: 5000 });
const debugIpRouteEnabled = process.env.ENABLE_DEBUG_IP_ROUTE === '1';
const MODELS_LIVE_POLL_MS = Math.max(500, Number(process.env.MODELS_LIVE_POLL_MS ?? 2000));
const MODELS_LIVE_HEARTBEAT_MS = Math.max(1000, Number(process.env.MODELS_LIVE_HEARTBEAT_MS ?? 15000));
const NATIVE_ROUTE_MODELS_DEFAULT_LIMIT = (() => {
    const raw = Number(process.env.NATIVE_ROUTE_MODELS_LIMIT ?? 24);
    if (!Number.isFinite(raw)) return 24;
    if (raw <= 0) return 0;
    return Math.max(1, Math.floor(raw));
})();
const DEFAULT_ROUTE_CORS_ALLOW_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
const DEFAULT_ROUTE_CORS_ALLOW_HEADERS = [
    'Authorization',
    'Content-Type',
    'X-API-Key',
    'X-Goog-Api-Key',
    'API-Key',
    'Anthropic-Version',
    'Anthropic-Beta',
] as const;
const DEFAULT_ROUTE_CORS_EXPOSE_HEADERS = [
    'Cache-Control',
    'Content-Disposition',
    'Content-Type',
    'Retry-After',
] as const;
const MODELS_ROUTE_CORS_ALLOW_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
const MODELS_ROUTE_CORS_EXPOSE_HEADERS = [
    'X-AnyGPT-Availability-Constrained',
    'X-AnyGPT-Availability-Constrained-Only',
    'X-AnyGPT-Availability-Unconstrained-Models',
    'X-AnyGPT-Models-Catalog-State',
    'X-AnyGPT-Models-Filtered',
    'X-AnyGPT-Models-Limit',
    'X-AnyGPT-Models-Truncated',
    'X-AnyGPT-Models-Total-Before-Truncation',
    'X-AnyGPT-Models-Updated-At',
    'X-AnyGPT-Plan',
    'X-AnyGPT-Plan-Included',
    'X-AnyGPT-Provider-Counts-Live',
    'X-AnyGPT-Provider-Counts-Updated-At',
    'X-AnyGPT-Providers-Filtered',
    'X-AnyGPT-Total-Constrained-Models',
    'X-AnyGPT-Total-Models',
    'X-AnyGPT-Total-Providers',
    'X-AnyGPT-Routed-Family',
    'X-AnyGPT-Visible-Constrained-Models',
    'X-AnyGPT-Visible-Models',
    'X-AnyGPT-Visible-Providers',
] as const;

type NativeModelsRouteFamily =
    | 'openai'
    | 'anthropic'
    | 'gemini'
    | 'openrouter'
    | 'deepseek'
    | 'xai';

type RouteCorsOptions = {
    allowMethods?: readonly string[];
    exposeHeaders?: readonly string[];
};

function normalizeCorsHeaderValues(value: string | null | undefined): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const entry of String(value ?? '').split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(trimmed);
    }
    return normalized;
}

export function applyRouteCorsHeaders(request: Request | any, response: Response | any, options: RouteCorsOptions = {}): void {
    const origin = typeof request?.headers?.origin === 'string' && request.headers.origin.trim()
        ? request.headers.origin.trim()
        : '*';
    const requestedHeaders = typeof request?.headers?.['access-control-request-headers'] === 'string'
        ? request.headers['access-control-request-headers']
        : null;
    const allowMethods = options.allowMethods && options.allowMethods.length > 0
        ? [...options.allowMethods]
        : [...DEFAULT_ROUTE_CORS_ALLOW_METHODS];
    const allowHeaders = normalizeCorsHeaderValues(requestedHeaders);
    const exposeHeaders = normalizeCorsHeaderValues([
        ...DEFAULT_ROUTE_CORS_EXPOSE_HEADERS,
        ...(options.exposeHeaders || []),
    ].join(','));

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method');
    response.setHeader('Access-Control-Allow-Methods', allowMethods.join(', '));
    response.setHeader(
        'Access-Control-Allow-Headers',
        (allowHeaders.length > 0 ? allowHeaders : [...DEFAULT_ROUTE_CORS_ALLOW_HEADERS]).join(', ')
    );
    if (exposeHeaders.length > 0) {
        response.setHeader('Access-Control-Expose-Headers', exposeHeaders.join(', '));
    }
    response.setHeader('Access-Control-Max-Age', '86400');
}

function modelsCorsMiddleware(request: Request, response: Response, next: () => void): void {
    applyRouteCorsHeaders(request, response, {
        allowMethods: MODELS_ROUTE_CORS_ALLOW_METHODS,
        exposeHeaders: MODELS_ROUTE_CORS_EXPOSE_HEADERS,
    });
    next();
}

function sendModelsPreflightResponse(request: Request, response: Response): void {
    applyRouteCorsHeaders(request, response, {
        allowMethods: MODELS_ROUTE_CORS_ALLOW_METHODS,
        exposeHeaders: MODELS_ROUTE_CORS_EXPOSE_HEADERS,
    });
    response.status(204).end();
}


type PreparedModelsPayload =
    | { ok: true; body: any; headers: Record<string, string>; serialized: string }
    | { ok: false; statusCode: number; body: any; headers?: Record<string, string> };

let lastLiveModelsSignature: string | null = null;
let lastLiveCountsUpdatedAt = new Date(0).toISOString();

function getStableLiveCountsUpdatedAt(modelsData: ModelsFileStructure): string {
    let nextSignature: string | null = null;
    try {
        nextSignature = JSON.stringify(modelsData);
    } catch {
        nextSignature = null;
    }

    if (!nextSignature) {
        return new Date().toISOString();
    }

    if (nextSignature !== lastLiveModelsSignature) {
        lastLiveModelsSignature = nextSignature;
        lastLiveCountsUpdatedAt = new Date().toISOString();
    }

    return lastLiveCountsUpdatedAt;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function applyResponseHeaders(response: Response, headers: Record<string, string> | undefined): void {
    if (!headers) return;
    for (const [name, value] of Object.entries(headers)) {
        response.setHeader(name, value);
    }
}

function canonicalizeNativeModelsRouteFamily(raw: string): NativeModelsRouteFamily | null {
    const normalized = String(raw || '').trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'openai') return 'openai';
    if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
    if (normalized === 'gemini' || normalized === 'google') return 'gemini';
    if (normalized === 'openrouter') return 'openrouter';
    if (normalized === 'deepseek') return 'deepseek';
    if (normalized === 'xai' || normalized === 'x-ai') return 'xai';
    return null;
}

function inferNativeModelsRouteFamily(request: Request | any): NativeModelsRouteFamily | null {
    const requestPath = typeof request?.path === 'string' ? request.path : '';
    const match = requestPath.match(/^\/native\/([^/]+)/i);
    return match?.[1] ? canonicalizeNativeModelsRouteFamily(match[1]) : null;
}

function resolveDeclaredNativeModelsRouteFamily(provider: LoadedProviders[number]): NativeModelsRouteFamily | null {
    for (const candidate of [
        (provider as any)?.nativeFamily,
        (provider as any)?.nativeProtocol,
        (provider as any)?.native_family,
        (provider as any)?.native_protocol,
    ]) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        const resolved = canonicalizeNativeModelsRouteFamily(candidate);
        if (resolved) return resolved;
    }
    return null;
}

function resolveProviderNativeModelsRouteFamily(provider: LoadedProviders[number]): NativeModelsRouteFamily | null {
    const declared = resolveDeclaredNativeModelsRouteFamily(provider);
    if (declared) return declared;

    const haystack = `${provider.id} ${provider.provider_url}`.toLowerCase();
    if (haystack.includes('openrouter')) return 'openrouter';
    if (haystack.includes('deepseek')) return 'deepseek';
    if (haystack.includes('xai') || haystack.includes('x.ai') || haystack.includes('grok')) return 'xai';
    if (haystack.includes('anthropic') || haystack.includes('claude')) return 'anthropic';
    if (
        haystack.includes('gemini')
        || haystack.includes('google')
        || haystack.includes('generativelanguage')
        || haystack.includes('googleapis')
    ) {
        return 'gemini';
    }
    if (haystack.includes('mock')) return 'openai';
    return 'openai';
}

function buildNativeRouteModelVariants(modelId: string): string[] {
    const normalized = String(modelId || '').trim().toLowerCase();
    if (!normalized) return [];
    const variants = new Set<string>([normalized]);
    if (normalized.includes('/')) {
        variants.add(normalized.slice(normalized.lastIndexOf('/') + 1));
    }
    return Array.from(variants);
}

function providerSupportsNativeRouteModel(provider: LoadedProviders[number], modelId: string): boolean {
    const modelVariants = new Set(buildNativeRouteModelVariants(modelId));
    if (modelVariants.size === 0) return false;
    const providerModels = provider?.models && typeof provider.models === 'object'
        ? Object.keys(provider.models)
        : [];
    for (const providerModelId of providerModels) {
        for (const variant of buildNativeRouteModelVariants(providerModelId)) {
            if (modelVariants.has(variant)) return true;
        }
    }
    return false;
}

function filterModelsForNativeRouteFamily(
    modelsData: ModelsFileStructure,
    providersData: LoadedProviders,
    family: NativeModelsRouteFamily
): { models: ModelsFileStructure; filteredOutCount: number } {
    const activeProviders = (providersData || [])
        .filter((provider) => !provider.disabled)
        .filter((provider) => typeof provider.apiKey === 'string' && provider.apiKey.trim().length > 0)
        .filter((provider) => typeof provider.provider_url === 'string' && provider.provider_url.trim().length > 0)
        .filter((provider) => resolveProviderNativeModelsRouteFamily(provider) === family);

    const filteredData = Array.isArray(modelsData?.data)
        ? modelsData.data
            .map((model) => {
                const matchingProviders = activeProviders.filter((provider) =>
                    providerSupportsNativeRouteModel(provider, String(model?.id || ''))
                );
                if (matchingProviders.length === 0) return null;
                return {
                    ...model,
                    providers: matchingProviders.length,
                };
            })
            .filter((model): model is NonNullable<typeof model> => Boolean(model))
        : [];

    return {
        models: {
            ...modelsData,
            data: filteredData,
        },
        filteredOutCount: Math.max((modelsData?.data?.length || 0) - filteredData.length, 0),
    };
}

const NATIVE_ROUTE_MODEL_PRIORITY = [
    'gpt-5.4',
    'gpt-5-mini',
    'gpt-4.1-mini',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4o',
    'gpt-3.5-turbo',
    'gpt-5-codex',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'anthropic/claude-sonnet-4.5',
    'claude-sonnet-4.5',
    'claude-3.7-sonnet',
    'deepseek-chat',
    'deepseek-reasoner',
    'grok-4',
    'grok-3',
] as const;
const nativeRouteModelPriorityMap = new Map<string, number>(
    NATIVE_ROUTE_MODEL_PRIORITY.map((modelId, index) => [modelId, index])
);

function normalizeModelCapabilities(model: any): string[] {
    return Array.isArray(model?.capabilities)
        ? model.capabilities.map((cap: unknown) => String(cap).toLowerCase())
        : [];
}

function getNativeRouteModelPriority(modelId: string): number {
    const variants = buildNativeRouteModelVariants(modelId);
    for (const variant of variants) {
        const priority = nativeRouteModelPriorityMap.get(variant);
        if (typeof priority === 'number') return priority;
    }
    return Number.POSITIVE_INFINITY;
}

function compareNativeRouteModels(left: any, right: any): number {
    const leftId = String(left?.id || '');
    const rightId = String(right?.id || '');
    const leftPriority = getNativeRouteModelPriority(leftId);
    const rightPriority = getNativeRouteModelPriority(rightId);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;

    const leftCapabilities = normalizeModelCapabilities(left);
    const rightCapabilities = normalizeModelCapabilities(right);
    const leftText = leftCapabilities.includes('text') ? 1 : 0;
    const rightText = rightCapabilities.includes('text') ? 1 : 0;
    if (leftText !== rightText) return rightText - leftText;

    const leftToolCalling = leftCapabilities.includes('tool_calling') ? 1 : 0;
    const rightToolCalling = rightCapabilities.includes('tool_calling') ? 1 : 0;
    if (leftToolCalling !== rightToolCalling) return rightToolCalling - leftToolCalling;

    const leftProviders = Number(left?.providers) || 0;
    const rightProviders = Number(right?.providers) || 0;
    if (leftProviders !== rightProviders) return rightProviders - leftProviders;

    const leftThroughput = Number(left?.throughput) || 0;
    const rightThroughput = Number(right?.throughput) || 0;
    if (leftThroughput !== rightThroughput) return rightThroughput - leftThroughput;

    return leftId.localeCompare(rightId);
}

function resolveNativeRouteModelsLimit(request: Request | any): number | null {
    for (const candidate of [
        request?.query?.limit,
        request?.query?.max_models,
        request?.query?.maxModels,
    ]) {
        if (candidate === undefined || candidate === null || candidate === '') continue;
        const parsed = Number(candidate);
        if (!Number.isFinite(parsed)) continue;
        if (parsed <= 0) return null;
        return Math.max(1, Math.floor(parsed));
    }

    return NATIVE_ROUTE_MODELS_DEFAULT_LIMIT > 0
        ? NATIVE_ROUTE_MODELS_DEFAULT_LIMIT
        : null;
}

function truncateNativeRouteModels(
    modelsData: ModelsFileStructure,
    request: Request | any
): {
    models: ModelsFileStructure;
    appliedLimit: number | null;
    totalBeforeTruncation: number;
    truncated: boolean;
} {
    const totalBeforeTruncation = Array.isArray(modelsData?.data)
        ? modelsData.data.length
        : 0;
    const appliedLimit = resolveNativeRouteModelsLimit(request);
    if (!appliedLimit || totalBeforeTruncation <= appliedLimit) {
        return {
            models: modelsData,
            appliedLimit,
            totalBeforeTruncation,
            truncated: false,
        };
    }

    return {
        models: {
            ...modelsData,
            data: [...modelsData.data].sort(compareNativeRouteModels).slice(0, appliedLimit),
        },
        appliedLimit,
        totalBeforeTruncation,
        truncated: true,
    };
}

function extractRequestApiKey(request: any): string | null {
    const authHeader = request.headers['authorization'] || request.headers['Authorization'];
    const bearer = extractBearerToken(typeof authHeader === 'string' ? authHeader : null);
    const queryApiKey = typeof request.query?.api_key === 'string'
        ? request.query.api_key
        : typeof request.query?.apiKey === 'string'
            ? request.query.apiKey
            : typeof request.query?.x_api_key === 'string'
                ? request.query.x_api_key
                : null;
    return (
        bearer
        || (typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null)
        || (typeof request.headers['api-key'] === 'string' ? request.headers['api-key'] : null)
        || queryApiKey
    );
}

export async function buildModelsPayload(request: any): Promise<PreparedModelsPayload> {
    const [modelsSnapshot, providersData] = await Promise.all([
        dataManager.load<ModelsFileStructure>('models'),
        dataManager.load<LoadedProviders>('providers'),
    ]);
    if (!modelsSnapshot || !Array.isArray(modelsSnapshot.data)) {
        throw new Error('Failed to load models data.');
    }

    const modelsData = applyLiveProviderCountsToModelsData(
        modelsSnapshot,
        providersData || [],
        Date.now()
    );
    const nativeRouteFamily = inferNativeModelsRouteFamily(request);
    const nativeRouteFilter = nativeRouteFamily
        ? filterModelsForNativeRouteFamily(modelsData, providersData || [], nativeRouteFamily)
        : null;
    const routeFamilyModelsData = nativeRouteFilter?.models || modelsData;
    const routeModelsFiltered = Boolean(nativeRouteFilter && nativeRouteFilter.filteredOutCount > 0);
    const liveCountsUpdatedAt = getStableLiveCountsUpdatedAt(modelsData);
    const apiKey = extractRequestApiKey(request);
    const includePlan = request.query?.include_plan === '1' || request.query?.includePlan === '1';

    if (!apiKey) {
        const publicNativeRouteTruncation = nativeRouteFamily
            ? truncateNativeRouteModels(routeFamilyModelsData, request)
            : null;
        const routeScopedModelsData = publicNativeRouteTruncation?.models || routeFamilyModelsData;
        const routeModelsTruncated = Boolean(publicNativeRouteTruncation?.truncated);
        const routeModelsLimit = publicNativeRouteTruncation?.appliedLimit ?? null;
        const routeModelsTotalBeforeTruncation = publicNativeRouteTruncation?.totalBeforeTruncation
            ?? (Array.isArray(routeScopedModelsData?.data) ? routeScopedModelsData.data.length : 0);
        const body = {
            ...routeScopedModelsData,
            provider_counts_live: true,
            provider_counts_updated_at: liveCountsUpdatedAt,
        };
        const headers: Record<string, string> = {
            'Cache-Control': 'private, no-store',
            'X-AnyGPT-Provider-Counts-Live': '1',
            'X-AnyGPT-Provider-Counts-Updated-At': liveCountsUpdatedAt,
            'X-AnyGPT-Models-Filtered': routeModelsFiltered ? '1' : '0',
            'X-AnyGPT-Models-Truncated': routeModelsTruncated ? '1' : '0',
        };
        if (nativeRouteFamily) {
            headers['X-AnyGPT-Routed-Family'] = nativeRouteFamily;
        }
        if (routeModelsLimit) {
            headers['X-AnyGPT-Models-Limit'] = String(routeModelsLimit);
        }
        if (routeModelsTruncated) {
            headers['X-AnyGPT-Models-Total-Before-Truncation'] = String(routeModelsTotalBeforeTruncation);
        }
        return {
            ok: true,
            body,
            serialized: JSON.stringify(body),
            headers,
        };
    }

    const validation = await validateApiKeyAndUsage(apiKey);
    if (!validation.valid || !validation.userData || !validation.tierLimits) {
        const statusCode = validation.error?.includes('limit reached') ? 429 : 401;
        return {
            ok: false,
            statusCode,
            body: {
                error: statusCode === 429 ? 'Rate limit exceeded' : 'Unauthorized',
                message: validation.error || 'Invalid API key.',
                timestamp: new Date().toISOString(),
            },
        };
    }

    const tierId = validation.userData.tier;
    const tier = validation.tierLimits;
    const filteredUntruncated = filterModelsForTier(routeFamilyModelsData, tier);
    const authenticatedNativeRouteTruncation = nativeRouteFamily
        ? truncateNativeRouteModels(filteredUntruncated, request)
        : null;
    const filtered = authenticatedNativeRouteTruncation?.models || filteredUntruncated;
    const routeModelsTruncated = Boolean(authenticatedNativeRouteTruncation?.truncated);
    const routeModelsLimit = authenticatedNativeRouteTruncation?.appliedLimit ?? null;
    const routeModelsTotalBeforeTruncation = authenticatedNativeRouteTruncation?.totalBeforeTruncation
        ?? (Array.isArray(filtered?.data) ? filtered.data.length : 0);
    const visibleModelCount = Array.isArray(filtered.data) ? filtered.data.length : 0;
    const totalModelCount = Array.isArray(filteredUntruncated?.data) ? filteredUntruncated.data.length : visibleModelCount;
    const catalogUpdatedAt = typeof (filtered as any)?.updated_at === 'string'
        ? (filtered as any).updated_at
        : '';
    const visibleProviderCount = filtered.data.reduce((sum, model) => sum + (typeof model.providers === 'number' ? model.providers : 0), 0);
    const totalProviderCount = filteredUntruncated.data.reduce((sum, model) => sum + (typeof model.providers === 'number' ? model.providers : 0), 0);
    const constrainedVisibleModelCount = filtered.data.reduce((sum, model) => {
        const availability = (model as any)?.availability;
        const blocked = Array.isArray(availability?.capability_blocked) ? availability.capability_blocked.length : 0;
        const skips = availability?.capability_skips && typeof availability.capability_skips === 'object'
            ? Object.keys(availability.capability_skips).length
            : 0;
        return sum + (blocked > 0 || skips > 0 ? 1 : 0);
    }, 0);
    const constrainedTotalModelCount = filteredUntruncated.data.reduce((sum, model) => {
        const availability = (model as any)?.availability;
        const blocked = Array.isArray(availability?.capability_blocked) ? availability.capability_blocked.length : 0;
        const skips = availability?.capability_skips && typeof availability.capability_skips === 'object'
            ? Object.keys(availability.capability_skips).length
            : 0;
        return sum + (blocked > 0 || skips > 0 ? 1 : 0);
    }, 0);

    const headers: Record<string, string> = {
        'Cache-Control': 'private, no-store',
        'X-AnyGPT-Provider-Counts-Live': '1',
        'X-AnyGPT-Provider-Counts-Updated-At': liveCountsUpdatedAt,
        'X-AnyGPT-Plan': tierId,
        'X-AnyGPT-Visible-Models': String(visibleModelCount),
        'X-AnyGPT-Total-Models': String(totalModelCount),
        'X-AnyGPT-Visible-Providers': String(visibleProviderCount),
        'X-AnyGPT-Total-Providers': String(totalProviderCount),
        'X-AnyGPT-Visible-Constrained-Models': String(constrainedVisibleModelCount),
        'X-AnyGPT-Total-Constrained-Models': String(constrainedTotalModelCount),
        'X-AnyGPT-Models-Filtered': (visibleModelCount === totalModelCount && !routeModelsFiltered) ? '0' : '1',
        'X-AnyGPT-Models-Truncated': routeModelsTruncated ? '1' : '0',
        'X-AnyGPT-Providers-Filtered': visibleProviderCount === totalProviderCount ? '0' : '1',
        'X-AnyGPT-Availability-Constrained': constrainedVisibleModelCount > 0 ? '1' : '0',
        'X-AnyGPT-Availability-Constrained-Only': visibleModelCount > 0 && visibleModelCount === constrainedVisibleModelCount ? '1' : '0',
        'X-AnyGPT-Availability-Unconstrained-Models': String(Math.max(visibleModelCount - constrainedVisibleModelCount, 0)),
        'X-AnyGPT-Plan-Included': includePlan ? '1' : '0',
    };
    if (nativeRouteFamily) {
        headers['X-AnyGPT-Routed-Family'] = nativeRouteFamily;
    }
    if (routeModelsLimit) {
        headers['X-AnyGPT-Models-Limit'] = String(routeModelsLimit);
    }
    if (routeModelsTruncated) {
        headers['X-AnyGPT-Models-Total-Before-Truncation'] = String(routeModelsTotalBeforeTruncation);
    }
    if (catalogUpdatedAt) {
        headers['X-AnyGPT-Models-Updated-At'] = catalogUpdatedAt;
    }
    const catalogState = !catalogUpdatedAt
        ? 'missing-updated-at'
        : visibleModelCount === 0
            ? 'empty'
            : constrainedVisibleModelCount > 0
                ? 'availability-constrained'
                : routeModelsFiltered || visibleModelCount < totalModelCount || visibleProviderCount < totalProviderCount
                    ? 'filtered'
                    : 'fresh';
    headers['X-AnyGPT-Models-Catalog-State'] = catalogState;

    const baseBody: any = {
        ...filtered,
        provider_counts_live: true,
        provider_counts_updated_at: liveCountsUpdatedAt,
    };
    if (includePlan) {
        baseBody.plan = buildPublicPlanPayload(tierId, tier, {
            visibleModelCount,
        });
    }
    return {
        ok: true,
        body: baseBody,
        serialized: JSON.stringify(baseBody),
        headers,
    };
}

async function publicModelsRateLimitMiddleware(request: Request, response: Response, next: () => void) {
    return runIpRateLimitMiddleware(request, response, next, publicModelsRequestStore, publicModelsRateLimits, {
        onDenied: async (_req, details) => ({
            status: 429,
            body: {
                error: 'Rate limit exceeded',
                message: `Public models route limit exceeded (${details.limit} ${details.window.toUpperCase()}).`,
                retry_after_seconds: details.retryAfterSeconds,
                timestamp: new Date().toISOString(),
            }
        }),
    });
}

async function adminRouteSecurityMiddleware(request: Request, response: Response, next: () => void) {
    await runAuthMiddleware(request, response, () => {}, {
        callNext: false,
        extractApiKey: (req) => {
            const authHeader = req.headers['authorization'] || req.headers['Authorization'];
            const bearer = extractBearerToken(typeof authHeader === 'string' ? authHeader : null);
            if (bearer) return bearer;
            if (typeof req.headers['x-api-key'] === 'string') return req.headers['x-api-key'];
            if (typeof req.headers['api-key'] === 'string') return req.headers['api-key'];
            return null;
        },
        onMissingApiKey: async (req) => {
            await logError({ message: 'Unauthorized: Missing admin API key for models admin route', requestPath: req.path }, req);
            return { status: 401, body: { error: 'Unauthorized', message: 'Admin API key required.', timestamp: new Date().toISOString() } };
        },
        onInvalidApiKey: async (req, details) => {
            await logError({ message: `Unauthorized: ${details.error || 'Invalid API key'} for models admin route`, requestPath: req.path }, req);
            return { status: details.statusCode, body: { error: 'Unauthorized', message: details.error || 'Invalid API key.', timestamp: new Date().toISOString() } };
        },
        onInternalError: async (req, error) => {
            await logError(error, req);
            return { status: 500, body: { error: 'Internal Server Error', reference: 'Authentication failed for models admin route.', timestamp: new Date().toISOString() } };
        },
    });

    if (!request.apiKey || request.userRole !== 'admin') {
        if (request.apiKey) {
            await logError({ message: 'Forbidden: Admin access required for models admin route', requestPath: request.path, userRole: request.userRole }, request);
        }
        if (!response.completed) {
            return response.status(403).json({ error: 'Forbidden', message: 'Admin access required.', timestamp: new Date().toISOString() });
        }
        return;
    }

    const rateKey = request.apiKey || request.userId || 'admin-route';
    const decision = enforceInMemoryRateLimit(adminModelsRequestStore, rateKey, adminRouteRateLimits);
    if (!decision.allowed && decision.window) {
        const retryAfterSeconds = decision.retryAfterSeconds ?? 1;
        response.setHeader('Retry-After', String(retryAfterSeconds));
        await logError({
            message: `Rate limit exceeded for protected models route (${decision.window.toUpperCase()}).`,
            requestPath: request.path,
            rateLimitWindow: decision.window,
            rateLimitLimit: decision.limit ?? adminRouteRateLimits[decision.window],
            retryAfterSeconds,
        }, request);
        if (!response.completed) {
            return response.status(429).json({
                error: 'Rate limit exceeded',
                message: `Admin route limit exceeded (${decision.limit ?? adminRouteRateLimits[decision.window]} ${decision.window.toUpperCase()}).`,
                retry_after_seconds: retryAfterSeconds,
                timestamp: new Date().toISOString(),
            });
        }
        return;
    }

    next();
}

if (debugIpRouteEnabled) {
    // Debug route is disabled by default and admin-only when enabled.
    modelsRouter.get('/debug/ip', adminRouteSecurityMiddleware, (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.json({
            ip: (request as any).ip,
            xForwardedFor: request.headers['x-forwarded-for'],
            xRealIp: request.headers['x-real-ip'],
            cfConnectingIp: request.headers['cf-connecting-ip'],
            forwarded: request.headers['forwarded'],
            timestamp: new Date().toISOString(),
        });
    });
}

async function sendModelsResponse(request: any, response: any) {
    try {
        const payload = await buildModelsPayload(request);
        applyResponseHeaders(response, payload.headers);
        if (!payload.ok) {
            return response.status(payload.statusCode).json(payload.body);
        }
        response.json(payload.body);
    } catch (error) {
        await logError(error, request);
        console.error('Error serving models.json:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to load models data.',
                timestamp: new Date().toISOString()
            });
        } else {
             console.warn('[GET /models] Response already completed, could not send 500 JSON error.');
        }
    }
}

async function sendModelsLiveSseResponse(request: any, response: any) {
    try {
        const initialPayload = await buildModelsPayload(request);
        applyResponseHeaders(response, initialPayload.headers);
        if (!initialPayload.ok) {
            return response.status(initialPayload.statusCode).json(initialPayload.body);
        }

        response.status(200);
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store, no-transform');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('X-Accel-Buffering', 'no');

        let lastSerialized = initialPayload.serialized;
        let lastHeartbeatAt = Date.now();

        response.write(`event: models\n`);
        response.write(`data: ${initialPayload.serialized}\n\n`);

        void (async () => {
            try {
                while (!response.completed) {
                    await sleep(MODELS_LIVE_POLL_MS);
                    if (response.completed) break;

                    const nextPayload = await buildModelsPayload(request);
                    if (!nextPayload.ok) {
                        response.write('event: error\n');
                        response.write(`data: ${JSON.stringify(nextPayload.body)}\n\n`);
                        response.end();
                        break;
                    }

                    if (nextPayload.serialized !== lastSerialized) {
                        lastSerialized = nextPayload.serialized;
                        lastHeartbeatAt = Date.now();
                        response.write('event: models\n');
                        response.write(`data: ${nextPayload.serialized}\n\n`);
                        continue;
                    }

                    if (Date.now() - lastHeartbeatAt >= MODELS_LIVE_HEARTBEAT_MS) {
                        lastHeartbeatAt = Date.now();
                        response.write(`: heartbeat ${new Date(lastHeartbeatAt).toISOString()}\n\n`);
                    }
                }
            } catch (streamError) {
                await logError(streamError, request);
                if (!response.completed) {
                    response.write('event: error\n');
                    response.write(`data: ${JSON.stringify({
                        error: 'Internal Server Error',
                        reference: 'Failed to stream live models data.',
                        timestamp: new Date().toISOString(),
                    })}\n\n`);
                    response.end();
                }
            }
        })();
    } catch (error) {
        await logError(error, request);
        console.error('Error serving live models SSE:', error);
        if (!response.completed) {
            response.status(500).json({
                error: 'Internal Server Error',
                reference: 'Failed to stream live models data.',
                timestamp: new Date().toISOString(),
            });
        }
    }
}

// Route to serve the main models.json (models.json in current directory)
modelsRouter.options('/v1/models', sendModelsPreflightResponse);
modelsRouter.options('/v1/models/live', sendModelsPreflightResponse);
modelsRouter.options('/v1/chat/completions/models', sendModelsPreflightResponse);
modelsRouter.options('/v1/chat/completion/models', sendModelsPreflightResponse);
modelsRouter.options('/v1/chat/completions/models/live', sendModelsPreflightResponse);
modelsRouter.options('/v1/chat/completion/models/live', sendModelsPreflightResponse);

modelsRouter.get('/v1/models', modelsCorsMiddleware, publicModelsRateLimitMiddleware, sendModelsResponse);
modelsRouter.get('/v1/models/live', modelsCorsMiddleware, publicModelsRateLimitMiddleware, sendModelsLiveSseResponse);

// OpenAI-compatible aliases so clients can hit chat completion model discovery
modelsRouter.get('/v1/chat/completions/models', modelsCorsMiddleware, publicModelsRateLimitMiddleware, sendModelsResponse);
modelsRouter.get('/v1/chat/completion/models', modelsCorsMiddleware, publicModelsRateLimitMiddleware, sendModelsResponse);
modelsRouter.get('/v1/chat/completions/models/live', modelsCorsMiddleware, publicModelsRateLimitMiddleware, sendModelsLiveSseResponse);
modelsRouter.get('/v1/chat/completion/models/live', modelsCorsMiddleware, publicModelsRateLimitMiddleware, sendModelsLiveSseResponse);

export { modelsRouter };
