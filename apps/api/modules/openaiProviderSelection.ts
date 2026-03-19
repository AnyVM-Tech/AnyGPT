import crypto from 'node:crypto';
import type { Response } from '../lib/uws-compat.js';
import { dataManager, type LoadedProviders, type LoadedProviderData, type ModelsFileStructure } from './dataManager.js';
import type { ModelCapability } from '../providers/interfaces.js';
import { isGptImageModelId, isSoraVideoModelId, resolveSoraVideoModelId } from './openaiRouteUtils.js';

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
  kind: 'openai' | 'xai';
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
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    p.id.includes('openai') &&
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
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    (p.id.includes('openai') || p.id.includes('xai') || isGeminiLikeProviderId(p.id) || p.id.includes('imagen')) &&
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

  const pickFrom = candidates.length > 0 ? candidates : matches;
  if (pickFrom.length === 0) return [];
  return shuffleArray(pickFrom).map(mapImageGenerationProviderSelection);
}

export async function pickVideoGenProviderKey(
  modelId: string
): Promise<VideoGenerationProviderSelection | null> {
  const providers = await listVideoGenProviders(modelId);
  return providers[0] ?? null;
}

export async function listVideoGenProviders(
  modelId: string
): Promise<VideoGenerationProviderSelection[]> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const modelIdVariants = normalizeModelIdVariants(modelId);
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    (p.id.includes('xai') || p.id.includes('openai')) &&
    p.apiKey &&
    p.models &&
    modelIdVariants.some((variant) => variant in p.models)
  );
  if (matches.length === 0) return [];
  return shuffleArray(matches).map(mapVideoGenerationProviderSelection);
}

export async function listAnyVideoProviders(): Promise<VideoGenerationProviderSelection[]> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    (p.id.includes('xai') || p.id.includes('openai')) &&
    p.apiKey
  );
  if (matches.length === 0) return [];
  return shuffleArray(matches).map(mapVideoGenerationProviderSelection);
}

export async function pickAnyXaiProviderKey(): Promise<{ apiKey: string; baseUrl: string } | null> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const pick = providers.find((p: LoadedProviderData) => !p.disabled && p.id.includes('xai') && p.apiKey);
  if (!pick) return null;
  return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || 'https://api.x.ai') };
}
