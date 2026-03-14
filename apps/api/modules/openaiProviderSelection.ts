import crypto from 'node:crypto';
import type { Response } from '../lib/uws-compat.js';
import { dataManager, type LoadedProviders, type LoadedProviderData, type ModelsFileStructure } from './dataManager.js';
import type { ModelCapability } from '../providers/interfaces.js';

const MODEL_CAPS_CACHE_MS = Math.max(1000, Number(process.env.MODEL_CAPS_CACHE_MS ?? 5000));
let modelCapsCache: { expiresAt: number; map: Map<string, ModelCapability[]> } | null = null;

export function extractOrigin(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.origin;
  } catch {
    return 'https://api.openai.com';
  }
}

export function normalizeModelIdVariants(modelId: string): string[] {
  const raw = String(modelId || '').trim();
  if (!raw) return [];
  const variants = new Set<string>([raw]);
  const slashIndex = raw.indexOf('/');
  if (slashIndex > 0 && slashIndex + 1 < raw.length) {
    variants.add(raw.slice(slashIndex + 1));
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
      if (caps.length > 0 && model.id) {
        map.set(model.id, caps);
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
      const skips = (modelData as any)?.capability_skips as Partial<Record<ModelCapability, string>> | undefined;
      if (!skips) return true;
      return !requiredCaps.some((cap) => Boolean(skips[cap]));
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

export async function pickImageGenProviderKey(
  modelId: string,
  requiredCaps: ModelCapability[] = []
): Promise<{ apiKey: string; baseUrl: string } | null> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const requiresCaps = Array.isArray(requiredCaps) && requiredCaps.length > 0;
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    (p.id.includes('openai') || p.id.includes('xai')) &&
    p.apiKey &&
    p.models &&
    modelId in p.models
  );
  const candidates = requiresCaps
    ? matches.filter((p: LoadedProviderData) => {
      const modelData = p.models?.[modelId];
      const skips = (modelData as any)?.capability_skips as Partial<Record<ModelCapability, string>> | undefined;
      if (!skips) return true;
      return !requiredCaps.some((cap) => Boolean(skips[cap]));
    })
    : matches;

  const pickFrom = candidates.length > 0 ? candidates : matches;
  if (pickFrom.length === 0) return null;
  const pick = pickFrom[crypto.randomInt(pickFrom.length)];
  const defaultBase = pick.id.includes('xai') ? 'https://api.x.ai' : 'https://api.openai.com';
  return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || defaultBase) };
}

export async function pickVideoGenProviderKey(
  modelId: string
): Promise<{ apiKey: string; baseUrl: string } | null> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const matches = providers.filter((p: LoadedProviderData) =>
    !p.disabled &&
    p.id.includes('xai') &&
    p.apiKey &&
    p.models &&
    modelId in p.models
  );
  if (matches.length === 0) return null;
  const pick = matches[crypto.randomInt(matches.length)];
  return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || 'https://api.x.ai') };
}

export async function pickAnyXaiProviderKey(): Promise<{ apiKey: string; baseUrl: string } | null> {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const pick = providers.find((p: LoadedProviderData) => !p.disabled && p.id.includes('xai') && p.apiKey);
  if (!pick) return null;
  return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || 'https://api.x.ai') };
}
