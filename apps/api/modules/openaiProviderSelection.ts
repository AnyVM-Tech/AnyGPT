import crypto from 'node:crypto';
import type { Response } from '../lib/uws-compat.js';
import { dataManager, type LoadedProviders, type LoadedProviderData, type ModelsFileStructure } from './dataManager.js';
import type { ModelCapability } from '../providers/interfaces.js';
import { isGptImageModelId, isSoraVideoModelId, resolveSoraVideoModelId } from './openaiRouteUtils.js';
import { containsOpenAiApiKeyHelpLink, urlHasExpectedHostname } from './urlGuards.js';

const MODEL_CAPS_CACHE_MS = Math.max(1000, Number(process.env.MODEL_CAPS_CACHE_MS ?? 5000));
const XAI_PROVIDER_KEY_CACHE_MS = Math.max(1000, Number(process.env.XAI_PROVIDER_KEY_CACHE_MS ?? 5000));
let modelCapsCache: { expiresAt: number; map: Map<string, ModelCapability[]> } | null = null;
let xaiProviderKeyCache:
  | { expiresAt: number; value: { apiKey: string; baseUrl: string } | null }
  | null = null;

export function extractOrigin(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.origin;
  } catch {
    return 'https://api.openai.com';
  }
}

export function extractApiBase(urlStr: string, fallback: string): string {
  try {
    const url = new URL(urlStr);
    const fallbackUrl = new URL(fallback);
    let pathname = url.pathname || fallbackUrl.pathname;
    if (!pathname || pathname === '/') pathname = fallbackUrl.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return `${url.origin}${pathname}`;
  } catch {
    return fallback;
  }
}

function isGeminiLikeProviderId(providerId: string): boolean {
  const normalized = String(providerId || '').toLowerCase();
  return normalized.includes('gemini') || normalized.includes('google');
}

function hasRecentRateLimitOrTimeoutSignal(provider: LoadedProviderData): boolean {
  const lastError = String((provider as any)?.lastError || (provider as any)?.last_error || '').toLowerCase();
  const status = Number((provider as any)?.lastStatus || (provider as any)?.last_status || 0);
  const code = String((provider as any)?.lastErrorCode || (provider as any)?.last_error_code || '').toLowerCase();
  const memoryPressureLike =
    code === 'memory_pressure' ||
    lastError.includes('memory pressure') ||
    lastError.includes('rejected under memory pressure') ||
    lastError.includes('swap_used_mb=') ||
    lastError.includes('rss_mb=') ||
    lastError.includes('active_runtime_mb=') ||
    lastError.includes('external_mb=') ||
    lastError.includes('heap_used_mb=');
  const upstreamServerInstabilityLike =
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 'ecconnreset' ||
    code === 'econnreset' ||
    code === 'etimedout' ||
    code === 'econnaborted' ||
    lastError.includes('timeout') ||
    lastError.includes('timed out') ||
    lastError.includes('econnaborted') ||
    lastError.includes('server error') ||
    lastError.includes('server_error') ||
    lastError.includes('temporarily unavailable') ||
    lastError.includes('bad gateway') ||
    lastError.includes('gateway timeout') ||
    lastError.includes('service unavailable') ||
    lastError.includes('overloaded') ||
    lastError.includes('overload');
  const providerCapabilityBlockedLike =
    code === 'provider_cap_blocked' ||
    code === 'provider_model_removed' ||
    lastError.includes('provider_cap_blocked') ||
    lastError.includes('provider_model_removed') ||
    lastError.includes('image generation unavailable in country') ||
    lastError.includes('image generation unavailable in provider region') ||
    lastError.includes('image generation unavailable in country') ||
    lastError.includes('image generation unavailable in provider region') ||
    lastError.includes('image generation unavailable in country') ||
    lastError.includes('image generation unavailable in provider region') ||
    lastError.includes('generation is unavailable in your country') ||
    lastError.includes('generation is unavailable in your region') ||
    lastError.includes('image generation unavailable in country') ||
    lastError.includes('image generation unavailable in provider region');
  return (
    memoryPressureLike ||
    upstreamServerInstabilityLike ||
    providerCapabilityBlockedLike ||
    code === 'econnaborted' ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    lastError.includes('timeout') ||
    lastError.includes('timed out') ||
    lastError.includes('rate limit') ||
    lastError.includes('rate_limit') ||
    lastError.includes('too many requests') ||
    lastError.includes('resource_exhausted') ||
    lastError.includes('quota exceeded') ||
    lastError.includes('quota exhausted') ||
    lastError.includes('timed out') ||
    lastError.includes('timeout')
  );
}

function hasOpenRouterBillingFailureSignal(provider: LoadedProviderData): boolean {
  const providerId = String(provider?.id || '').toLowerCase();
  const providerType = String((provider as any)?.provider || (provider as any)?.type || '').toLowerCase();
  const isOpenRouter =
    providerId.includes('openrouter') ||
    providerType.includes('openrouter') ||
    urlHasExpectedHostname((provider as any)?.provider_url, 'openrouter.ai');
  if (!isOpenRouter) return false;

  const lastError = String((provider as any)?.lastError || (provider as any)?.last_error || '').toLowerCase();
  const disabledReason = String((provider as any)?.disabled_reason || '').toLowerCase();
  const combined = `${lastError} ${disabledReason}`;

  return (
    combined.includes('payment required') ||
    combined.includes('insufficient credits') ||
    combined.includes('insufficient credit') ||
    combined.includes('billing') ||
    combined.includes('credits') ||
    combined.includes('402')
  );
}

function hasInvalidOpenAiKeySignal(provider: LoadedProviderData): boolean {
  const providerId = String(provider?.id || '').toLowerCase();
  const providerType = String((provider as any)?.provider || (provider as any)?.type || '').toLowerCase();
  if (!providerId.includes('openai') && !providerType.includes('openai')) return false;
  const lastError = String((provider as any)?.lastError || (provider as any)?.last_error || '').toLowerCase();
  if (!lastError) return false;
  return (
    lastError.includes('invalid api key') ||
    lastError.includes('incorrect api key provided') ||
    lastError.includes('invalid_api_key') ||
    lastError.includes('api key provided is invalid') ||
    lastError.includes('api key not found') ||
    containsOpenAiApiKeyHelpLink(lastError)
  );
}

export type EmbeddingProviderSelection = {
  apiKey: string;
  baseUrl: string;
  kind: 'openai' | 'gemini';
};

export type ImageGenerationProviderSelection = {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  kind: 'openai' | 'xai' | 'gemini';
};

export type VideoGenerationProviderSelection = {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  kind: 'openai' | 'xai' | 'gemini';
};

export type VideoGenerationProviderKind = VideoGenerationProviderSelection['kind'] | 'other';

export type VideoGenerationProviderAvailability = {
  providers: VideoGenerationProviderSelection[];
  totalMatches: number;
  kindCounts: Partial<Record<VideoGenerationProviderKind, number>>;
};

function shuffleArray<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function mapImageGenerationProviderSelection(provider: LoadedProviderData): ImageGenerationProviderSelection {
  if (isGeminiLikeProviderId(provider.id) || provider.id.includes('imagen')) {
    return {
      providerId: provider.id,
      apiKey: provider.apiKey!,
      baseUrl: extractApiBase(
        provider.provider_url || 'https://generativelanguage.googleapis.com/v1beta',
        'https://generativelanguage.googleapis.com/v1beta',
      ),
      kind: 'gemini',
    };
  }
  if (provider.id.includes('xai')) {
    return {
      providerId: provider.id,
      apiKey: provider.apiKey!,
      baseUrl: extractOrigin(provider.provider_url || 'https://api.x.ai'),
      kind: 'xai',
    };
  }
  return {
    providerId: provider.id,
    apiKey: provider.apiKey!,
    baseUrl: extractOrigin(provider.provider_url || 'https://api.openai.com'),
    kind: 'openai',
  };
}

function mapVideoGenerationProviderSelection(provider: LoadedProviderData): VideoGenerationProviderSelection {
  if (isGeminiLikeProviderId(provider.id)) {
    return {
      providerId: provider.id,
      apiKey: provider.apiKey!,
      baseUrl: extractApiBase(
        provider.provider_url || 'https://generativelanguage.googleapis.com/v1beta',
        'https://generativelanguage.googleapis.com/v1beta',
      ),
      kind: 'gemini',
    };
  }
  if (provider.id.includes('xai')) {
    return {
      providerId: provider.id,
      apiKey: provider.apiKey!,
      baseUrl: extractOrigin(provider.provider_url || 'https://api.x.ai'),
      kind: 'xai',
    };
  }
  return {
    providerId: provider.id,
    apiKey: provider.apiKey!,
    baseUrl: extractOrigin(provider.provider_url || 'https://api.openai.com'),
    kind: 'openai',
  };
}

function shouldIgnoreCapabilitySkip(modelId: string, capability: ModelCapability): boolean {
  if (capability === 'image_input' && isGptImageModelId(modelId)) {
    return true;
  }
  return false;
}

function providerSupportsRequiredCaps(
  modelId: string,
  modelData: any,
  requiredCaps: ModelCapability[]
): boolean {
  if (!Array.isArray(requiredCaps) || requiredCaps.length === 0) return true;
  const skips = modelData?.capability_skips as Partial<Record<ModelCapability, string>> | undefined;
  if (!skips) return true;
  return !requiredCaps.some((cap) => {
    if (shouldIgnoreCapabilitySkip(modelId, cap)) return false;
    return Boolean(skips[cap]);
  });
}

function augmentKnownCapabilities(modelId: string, capabilities: ModelCapability[]): ModelCapability[] {
  const set = new Set<ModelCapability>(capabilities);
  if (isGptImageModelId(modelId)) {
    set.add('image_input');
    set.add('image_output');
  }
  if (isSoraVideoModelId(modelId)) {
    set.add('image_input');
  }
  return Array.from(set);
}

export function normalizeModelIdVariants(modelId: string): string[] {
  const raw = String(modelId || '').trim();
  if (!raw) return [];
  const variants = new Set<string>([raw]);
  const slashIndex = raw.indexOf('/');
  if (slashIndex > 0 && slashIndex + 1 < raw.length) {
    variants.add(raw.slice(slashIndex + 1));
  }
  const soraVideo = resolveSoraVideoModelId(raw);
  if (soraVideo?.providerModelId) {
    variants.add(soraVideo.providerModelId);
  }
  return Array.from(variants);
}

export async function getModelCapabilities(modelId: string): Promise<ModelCapability[] | null> {
  const now = Date.now();
  if (!modelCapsCache || now > modelCapsCache.expiresAt) {
    const modelsFile = await dataManager.load<ModelsFileStructure>('models');
    const map = new Map<string, ModelCapability[]>();
    for (const model of modelsFile.data || []) {
      const caps = Array.isArray(model.capabilities) ? model.capabilities as ModelCapability[] : [];
      if (model.id) {
        const augmentedCaps = augmentKnownCapabilities(model.id, caps);
        if (augmentedCaps.length > 0) {
          map.set(model.id, augmentedCaps);
        }
      }
    }
    modelCapsCache = { map, expiresAt: now + MODEL_CAPS_CACHE_MS };
  }

  for (const variant of normalizeModelIdVariants(modelId)) {
    const caps = modelCapsCache.map.get(variant);
    if (caps) return caps;
  }
  return null;
}

export async function enforceModelCapabilities(
  modelId: string,
  requiredCaps: ModelCapability[],
  response: Response
): Promise<boolean> {
  if (!requiredCaps || requiredCaps.length === 0) return true;
  const caps = await getModelCapabilities(modelId);
  if (!caps || caps.length === 0) return true;
  const missing = requiredCaps.filter((cap) => !caps.includes(cap));
  if (missing.length === 0) return true;
  if (!(response as any).completed) {
    response.status(400).json({
      error: `Model ${modelId} missing required capabilities: ${missing.join(', ')}`,
      timestamp: new Date().toISOString()
    });
  }
  return false;
}

export async function pickOpenAIProviderKey(
  modelId: string,
  requiredCaps: ModelCapability[] = []
): Promise<{ apiKey: string; baseUrl: string } | null> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const requiresCaps = Array.isArray(requiredCaps) && requiredCaps.length > 0;
  const requiresToolCalling = requiredCaps.includes('tool_calling');
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    p.id.includes('openai') &&
    !hasInvalidOpenAiKeySignal(p) &&
    !hasOpenRouterBillingFailureSignal(p) &&
    (!requiresToolCalling || !hasRecentRateLimitOrTimeoutSignal(p)) &&
    p.apiKey &&
    p.models &&
    modelId in p.models
  );
  const candidates = requiresCaps
    ? matches.filter((p: LoadedProviderData) => {
      const modelData = p.models?.[modelId];
      return providerSupportsRequiredCaps(modelId, modelData, requiredCaps);
    })
    : matches;

  if (candidates.length === 0) {
    if (matches.length > 0) return null;
    const fallback = providers.find((p: LoadedProviderData) => !p.disabled && p.id.includes('openai') && p.apiKey);
    if (!fallback) return null;
    return { apiKey: fallback.apiKey!, baseUrl: extractOrigin(fallback.provider_url || 'https://api.openai.com') };
  }
  const pick = candidates[crypto.randomInt(candidates.length)];
  return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || 'https://api.openai.com') };
}

export async function pickEmbeddingProviderKey(
  modelId: string,
): Promise<EmbeddingProviderSelection | null> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    p.apiKey &&
    p.models &&
    modelId in p.models
  );
  if (matches.length === 0) return null;

  const openaiMatches = matches.filter((p: LoadedProviderData) => p.id.includes('openai'));
  const geminiMatches = matches.filter((p: LoadedProviderData) => isGeminiLikeProviderId(p.id));
  const pickFrom = openaiMatches.length > 0
    ? openaiMatches
    : (geminiMatches.length > 0 ? geminiMatches : matches);
  const pick = pickFrom[crypto.randomInt(pickFrom.length)];

  if (isGeminiLikeProviderId(pick.id)) {
    return {
      apiKey: pick.apiKey!,
      baseUrl: extractApiBase(
        pick.provider_url || 'https://generativelanguage.googleapis.com/v1beta',
        'https://generativelanguage.googleapis.com/v1beta',
      ),
      kind: 'gemini',
    };
  }

  return {
    apiKey: pick.apiKey!,
    baseUrl: extractOrigin(pick.provider_url || 'https://api.openai.com'),
    kind: 'openai',
  };
}

export async function pickImageGenProviderKey(
  modelId: string,
  requiredCaps: ModelCapability[] = []
): Promise<ImageGenerationProviderSelection | null> {
  const providers = await listImageGenProviders(modelId, requiredCaps);
  return providers[0] ?? null;
}

export async function listImageGenProviders(
  modelId: string,
  requiredCaps: ModelCapability[] = []
): Promise<ImageGenerationProviderSelection[]> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const requiresCaps = Array.isArray(requiredCaps) && requiredCaps.length > 0;
  const modelIdVariants = normalizeModelIdVariants(modelId);
  const matches = providers.filter((p: LoadedProviderData) =>
    (p.id.includes('openai') || p.id.includes('xai') || isGeminiLikeProviderId(p.id) || p.id.includes('imagen')) &&
    p.apiKey &&
    p.models &&
    modelIdVariants.some((variant) => variant in p.models)
  );
  const capabilityMatches = requiresCaps
    ? matches.filter((p: LoadedProviderData) => {
      const modelData = modelIdVariants
        .map((variant) => p.models?.[variant])
        .find((entry) => entry !== undefined);
      return providerSupportsRequiredCaps(modelId, modelData, requiredCaps);
    })
    : matches;

  const supportedMatches = capabilityMatches.filter((provider) => {
    if (isGeminiLikeProviderId(provider.id) || provider.id.includes('imagen')) {
      return !hasRecentGeminiCatalogAuthFailureSignal(provider);
    }
    return (
      !provider.disabled &&
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasOpenRouterBillingFailureSignal(provider)
    );
  });

  const stableSupportedMatches = supportedMatches.filter((provider) => {
    if (isGeminiLikeProviderId(provider.id) || provider.id.includes('imagen')) {
      return true;
    }
    return !hasRecentRateLimitOrTimeoutSignal(provider);
  });

  const pickFrom =
    stableSupportedMatches.length > 0
      ? stableSupportedMatches
      : supportedMatches.length > 0
        ? supportedMatches
        : capabilityMatches.length > 0
          ? capabilityMatches
          : matches;
  if (pickFrom.length === 0) return [];
  return shuffleArray(pickFrom).map(mapImageGenerationProviderSelection);
}

export async function pickVideoGenProviderKey(
  modelId: string
): Promise<VideoGenerationProviderSelection | null> {
  const providers = await listVideoGenProviders(modelId);
  return providers[0] ?? null;
}

function classifyVideoGenerationProviderKind(provider: LoadedProviderData): VideoGenerationProviderKind {
  if (String(provider.id || '').includes('openai')) return 'openai';
  if (String(provider.id || '').includes('xai')) return 'xai';
  if (
    isGeminiLikeProviderId(String(provider.id || ''))
    || String((provider as any)?.provider || '').includes('gemini')
    || String((provider as any)?.type || '').includes('gemini')
  ) {
    return 'gemini';
  }
  return 'other';
}

export async function inspectVideoGenProviderAvailability(
  modelId: string
): Promise<VideoGenerationProviderAvailability> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const modelIdVariants = normalizeModelIdVariants(modelId);
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    p.apiKey &&
    p.models &&
    modelIdVariants.some((variant) => variant in p.models)
  );
  const kindCounts = matches.reduce<Partial<Record<VideoGenerationProviderKind, number>>>((acc, provider) => {
    const kind = classifyVideoGenerationProviderKind(provider);
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  const supportedMatches = matches.filter((provider) =>
    (
      provider.id.includes('xai') ||
      provider.id.includes('openai') ||
      isGeminiLikeProviderId(provider.id)
    ) &&
    !hasInvalidOpenAiKeySignal(provider) &&
    !hasRecentGeminiCatalogAuthFailureSignal(provider)
  );
  if (supportedMatches.length === 0) {
    return {
      providers: [],
      totalMatches: matches.length,
      kindCounts,
    };
  }
  const authHealthyMatches = supportedMatches.filter(
    (provider) =>
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasOpenRouterBillingFailureSignal(provider) &&
      !hasRecentGeminiCatalogAuthFailureSignal(provider)
  );
  const stableAuthHealthyMatches = authHealthyMatches.filter(
    (provider) => !hasRecentRateLimitOrTimeoutSignal(provider)
  );
  const timeoutStableSupportedMatches = supportedMatches.filter(
    (provider) =>
      !hasRecentRateLimitOrTimeoutSignal(provider) &&
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasOpenRouterBillingFailureSignal(provider) &&
      !hasRecentGeminiCatalogAuthFailureSignal(provider)
  );  const preferredAuthHealthyMatches =
    stableAuthHealthyMatches.length > 0
      ? stableAuthHealthyMatches
      : timeoutStableSupportedMatches.length > 0
        ? timeoutStableSupportedMatches
      : authHealthyMatches;
  const nonOpenRouterAuthHealthyMatches = preferredAuthHealthyMatches.filter(
    (provider) => !provider.id.includes('openrouter')
  );
  const openRouterAuthHealthyMatches = preferredAuthHealthyMatches.filter(
    (provider) => provider.id.includes('openrouter')
  );
  const degradedOpenRouterMatches = supportedMatches.filter(
    (provider) =>
      provider.id.includes('openrouter') &&
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasRecentGeminiCatalogAuthFailureSignal(provider) &&
      hasOpenRouterBillingFailureSignal(provider)
  );
  if (nonOpenRouterAuthHealthyMatches.length > 0) {
    return {
      providers: shuffleArray([
        ...nonOpenRouterAuthHealthyMatches,
        ...openRouterAuthHealthyMatches,
        ...degradedOpenRouterMatches,
      ]).map(mapVideoGenerationProviderSelection),
      totalMatches: matches.length,
      kindCounts,
    };
  }
  const prioritizedAuthHealthyMatches = [
    ...nonOpenRouterAuthHealthyMatches,
    ...openRouterAuthHealthyMatches,
  ];
  const openRouterHealthyMatches = prioritizedAuthHealthyMatches.filter(
    (provider) =>
      !(
        provider.id.includes('openrouter') &&
        (
          hasRecentRateLimitOrTimeoutSignal(provider) ||
          hasInvalidOpenAiKeySignal(provider) ||
          hasOpenRouterBillingFailureSignal(provider) ||
          hasOpenRouterBillingFailureSignal(provider) ||
          hasOpenRouterBillingFailureSignal(provider) ||
          hasOpenRouterBillingFailureSignal(provider) ||
          hasOpenRouterBillingFailureSignal(provider) ||
          hasOpenRouterBillingFailureSignal(provider)
        )
      )
  );
  const quotaAndAuthHealthyMatches = openRouterHealthyMatches.filter(
    (provider) =>
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasOpenRouterBillingFailureSignal(provider)
  );
  const healthyMatches = quotaAndAuthHealthyMatches.filter(
    (provider) => !hasRecentRateLimitOrTimeoutSignal(provider)
  );
  if (healthyMatches.length > 0) {
    return {
      providers: shuffleArray(healthyMatches).map(mapVideoGenerationProviderSelection),
      totalMatches: matches.length,
      kindCounts,
    };
  }
  const nonExhaustedMatches = authHealthyMatches.filter(
    (provider) =>
      !hasRecentRateLimitOrTimeoutSignal(provider) &&
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasRecentGeminiCatalogAuthFailureSignal(provider)
  );
  const nonRateLimitedMatches = nonExhaustedMatches.filter(
    (provider) =>
      !hasRecentRateLimitOrTimeoutSignal(provider) &&
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasRecentGeminiCatalogAuthFailureSignal(provider) &&
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasRecentGeminiCatalogAuthFailureSignal(provider)
  );
  const nonAuthBrokenMatches = supportedMatches.filter(
    (provider) =>
      !hasInvalidOpenAiKeySignal(provider) &&
      !hasRecentGeminiCatalogAuthFailureSignal(provider)
  );
  const cleanSupportedMatches = healthyMatches.length > 0
    ? healthyMatches
    : nonRateLimitedMatches.length > 0
      ? nonRateLimitedMatches
      : nonAuthBrokenMatches;
  const pickFrom = cleanSupportedMatches.length > 0
    ? cleanSupportedMatches
    : supportedMatches;
  return {
    providers: shuffleArray(pickFrom).map(mapVideoGenerationProviderSelection),
    totalMatches: matches.length,
    kindCounts,
  };
}

export async function listVideoGenProviders(
  modelId: string
): Promise<VideoGenerationProviderSelection[]> {
  const availability = await inspectVideoGenProviderAvailability(modelId);
  return availability.providers;
}

function hasRecentGeminiCatalogAuthFailureSignal(provider: LoadedProviderData): boolean {
  if (!isGeminiLikeProviderId(String(provider?.id || ''))) return false;
  const lastError = String((provider as any)?.lastError || (provider as any)?.last_error || '').toLowerCase();
  const code = String((provider as any)?.lastErrorCode || (provider as any)?.error_code || '').toLowerCase();
  return (
    code === 'api_key_invalid' ||
    code === 'gemini_project_auth_failure' ||
    code === 'service_disabled' ||
    lastError.includes('gemini listmodels failed') ||
    lastError.includes('api key not found') ||
    lastError.includes('api key not valid') ||
    lastError.includes('invalid api key') ||
    lastError.includes('api_key_invalid') ||
    lastError.includes('generative language api has not been used in project') ||
    lastError.includes('generative language api is disabled') ||
    lastError.includes('your project has been denied access') ||
    lastError.includes('project has been denied access') ||
    lastError.includes('accessnotconfigured') ||
    lastError.includes('service_disabled') ||
    lastError.includes('gemini_project_auth_failure')
  );
}

export async function listAnyVideoProviders(): Promise<VideoGenerationProviderSelection[]> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    (p.id.includes('xai') || p.id.includes('openai')) &&
    !hasInvalidOpenAiKeySignal(p) &&
    !hasOpenRouterBillingFailureSignal(p) &&
    p.apiKey
  );
  if (matches.length === 0) return [];
  return shuffleArray(matches).map(mapVideoGenerationProviderSelection);
}

export async function pickAnyXaiProviderKey(): Promise<{ apiKey: string; baseUrl: string } | null> {
  const now = Date.now();
  if (xaiProviderKeyCache && now <= xaiProviderKeyCache.expiresAt) {
    return xaiProviderKeyCache.value;
  }

  const providers = await dataManager.load<LoadedProviders>('providers');
  const pick = providers.find((p: LoadedProviderData) => !p.disabled && p.id.includes('xai') && p.apiKey);
  const value = pick
    ? { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || 'https://api.x.ai') }
    : null;
  xaiProviderKeyCache = {
    expiresAt: now + XAI_PROVIDER_KEY_CACHE_MS,
    value,
  };
  return value;
}
