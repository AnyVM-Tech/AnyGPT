import { dataManager, LoadedProviders, LoadedProviderData } from '../modules/dataManager.js';
import redis from '../modules/db.js';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);

const modelArg = args.find((arg) => arg.startsWith('--model='));
const MODEL_ID = modelArg ? modelArg.split('=')[1].trim() : '';
const liveCheck = args.includes('--live');
const dryRun = args.includes('--dry-run');
const includeDisabled = args.includes('--include-disabled');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const delayArg = args.find((arg) => arg.startsWith('--delay-ms='));
const delayMs = delayArg ? Number(delayArg.split('=')[1]) : 250;
const providerFilterArg = args.find((arg) => arg.startsWith('--provider='));
const providerFilter = providerFilterArg ? providerFilterArg.split('=')[1].trim().toLowerCase() : '';
const waitRedis = !args.includes('--no-wait-redis');
const timeoutArg = args.find((arg) => arg.startsWith('--timeout-ms='));
const timeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) : 60000;

const IMAGE_PROMPT = 'Generate a simple image of a blue square on a white background.';

const providerDefaults = {
  openai: {
    modelsUrl: 'https://api.openai.com/v1/models',
  },
  xai: {
    modelsUrl: 'https://api.x.ai/v1/models',
  },
  gemini: {
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  },
} as const;

type TargetKind = 'image' | 'video';
type ProviderFamily = 'openai' | 'xai' | 'google' | '';

type PricingFile = {
  models?: Record<string, { per_image?: number; per_request?: number }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isImageGenerationModel(modelId: string): boolean {
  return getTargetKind(modelId) === 'image';
}

function getTargetKind(modelId: string): TargetKind | null {
  const lower = String(modelId || '').toLowerCase();
  if (!lower) return null;
  if (lower.includes('grok-imagine-video') || lower.includes('imagine-video') || lower.startsWith('sora') || lower.startsWith('veo-')) {
    return 'video';
  }
  if (
    lower.startsWith('dall-e')
    || lower.startsWith('gpt-image')
    || lower.includes('gpt-image')
    || lower.includes('chatgpt-image')
    || lower.includes('image-gen')
    || lower.includes('imagegen')
    || lower.includes('grok-imagine')
    || lower.includes('grok-2-image')
  ) {
    return 'image';
  }
  return null;
}

function isOpenAIStyleImageProvider(providerId: string): boolean {
  const id = String(providerId || '').toLowerCase();
  return id.includes('openai') || id.includes('xai') || id.includes('gemini') || id === 'google' || id.includes('imagen');
}

function getProviderFamily(providerId: string): ProviderFamily {
  const id = String(providerId || '').toLowerCase();
  if (id.includes('openai')) return 'openai';
  if (id.includes('xai')) return 'xai';
  if (id.includes('gemini') || id === 'google' || id.includes('imagen')) return 'google';
  return '';
}

function getModelFamily(modelId: string): ProviderFamily {
  const lower = String(modelId || '').toLowerCase();
  if (lower.startsWith('imagen') || lower.includes('nano-banana') || lower.startsWith('veo-')) return 'google';
  if (lower.includes('grok-')) return 'xai';
  if (lower.includes('grok-imagine')) return 'xai';
  if (lower.startsWith('dall-e') || lower.startsWith('gpt-image') || lower.includes('chatgpt-image') || lower.startsWith('sora')) {
    return 'openai';
  }
  return '';
}

function providerCanServeModel(providerId: string, modelId: string): boolean {
  const providerFamily = getProviderFamily(providerId);
  const modelFamily = getModelFamily(modelId);
  return Boolean(providerFamily && modelFamily && providerFamily === modelFamily);
}

function loadTargetModelsFromPricing(): string[] {
  const pricingPath = path.resolve('pricing.json');
  const raw = fs.readFileSync(pricingPath, 'utf8');
  const parsed = JSON.parse(raw) as PricingFile;
  const modelIds = Object.keys(parsed.models || {});
  return modelIds.filter((modelId) => {
    const kind = getTargetKind(modelId);
    if (!kind) return false;
    return getModelFamily(modelId) !== '';
  });
}

function extractOrigin(url: string, fallback: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
}

function defaultModelEntry(modelId: string) {
  return {
    id: modelId,
    token_generation_speed: 50,
    response_times: [],
    errors: 0,
    consecutive_errors: 0,
    avg_response_time: null,
    avg_provider_latency: null,
    avg_token_speed: null,
    disabled: false,
  };
}

async function fetchListedModels(provider: LoadedProviderData): Promise<Set<string>> {
  const providerFamily = getProviderFamily(provider.id);
  if (!providerFamily) {
    throw new Error(`Unsupported provider family for ${provider.id}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  try {
    if (providerFamily === 'google') {
      const url = `${providerDefaults.gemini.modelsUrl}?key=${encodeURIComponent(provider.apiKey || '')}`;
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      const bodyText = await response.text().catch(() => '');
      if (!response.ok) {
        throw new Error(`${response.status} ${bodyText || response.statusText}`);
      }
      const json = bodyText ? JSON.parse(bodyText) : {};
      const ids = Array.isArray(json?.models)
        ? json.models
            .map((item: any) => {
              if (typeof item?.name === 'string') return item.name.split('/').pop();
              if (typeof item?.id === 'string') return item.id;
              return null;
            })
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      return new Set(ids);
    }

    const defaultBase = providerFamily === 'xai' ? 'https://api.x.ai' : 'https://api.openai.com';
    const baseUrl = extractOrigin(provider.provider_url || defaultBase, defaultBase);
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      signal: controller.signal,
    });
    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`${response.status} ${bodyText || response.statusText}`);
    }
    const json = bodyText ? JSON.parse(bodyText) : {};
    const ids = Array.isArray(json?.data)
      ? json.data.map((item: any) => item?.id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    return new Set(ids);
  } finally {
    clearTimeout(timer);
  }
}

async function testImageGeneration(provider: LoadedProviderData): Promise<{ ok: boolean; reason?: string }> {
  if (!provider.apiKey) {
    return { ok: false, reason: 'missing api key' };
  }
  if (!isOpenAIStyleImageProvider(provider.id)) {
    return { ok: false, reason: 'unsupported provider family' };
  }

  if (getProviderFamily(provider.id) === 'google') {
    return { ok: false, reason: 'live generation is not implemented for google in this script; use models-list mode' };
  }

  const defaultBase = provider.id.toLowerCase().includes('xai') ? 'https://api.x.ai' : 'https://api.openai.com';
  const baseUrl = extractOrigin(provider.provider_url || defaultBase, defaultBase);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  try {
    const response = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL_ID,
        prompt: IMAGE_PROMPT,
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      const detail = bodyText ? bodyText.slice(0, 300) : response.statusText;
      return { ok: false, reason: `${response.status} ${detail}` };
    }

    let json: any = {};
    try {
      json = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return { ok: false, reason: 'invalid json response' };
    }

    const first = Array.isArray(json?.data) ? json.data[0] : undefined;
    if (typeof first?.b64_json === 'string' && first.b64_json.length > 0) {
      return { ok: true };
    }
    if (typeof first?.url === 'string' && first.url.length > 0) {
      return { ok: true };
    }

    return { ok: false, reason: 'empty image response' };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, reason: `timeout after ${timeoutMs}ms` };
    }
    return { ok: false, reason: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const targetModels = MODEL_ID ? [MODEL_ID] : loadTargetModelsFromPricing();
  if (targetModels.length === 0) {
    throw new Error('No target image/video models selected. Use --model=<model-id> or ensure pricing.json contains priced image/video models.');
  }
  const invalidTargets = targetModels.filter((modelId) => !getTargetKind(modelId));
  if (invalidTargets.length > 0) {
    throw new Error(`Unsupported model target(s): ${invalidTargets.join(', ')}`);
  }

  if (waitRedis) {
    await dataManager.waitForRedisReadyAndBackfill();
  }

  const providers = await dataManager.load<LoadedProviders>('providers');
  let candidates = providers.filter((provider) => isOpenAIStyleImageProvider(provider.id));

  if (!includeDisabled) {
    candidates = candidates.filter((provider) => !provider.disabled);
  }
  if (providerFilter) {
    candidates = candidates.filter((provider) => provider.id.toLowerCase().includes(providerFilter));
  }
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    candidates = candidates.slice(0, limit);
  }

  const modeLabel = liveCheck ? 'live-generation' : 'models-list';
  console.log(`Testing ${candidates.length} provider(s) for ${targetModels.length} model(s) via ${modeLabel}...`);

  const kept: string[] = [];
  const removed: string[] = [];

  for (const provider of candidates) {
    if (!provider.apiKey) {
      console.warn(`skip: ${provider.id} missing api key`);
      continue;
    }

    let listedModels: Set<string> | null = null;
    if (!liveCheck) {
      try {
        listedModels = await fetchListedModels(provider);
      } catch (err: any) {
        console.warn(`error: ${provider.id} -> models list ${err?.message || String(err)}`);
        continue;
      }
    }

    for (const modelId of targetModels) {
      if (!providerCanServeModel(provider.id, modelId)) {
        continue;
      }

      let result: { ok: boolean; reason?: string };
      if (liveCheck) {
        if (modelId !== MODEL_ID) {
          result = { ok: false, reason: 'live mode only supports a single --model target' };
        } else {
          result = await testImageGeneration(provider);
        }
      } else {
        result = { ok: Boolean(listedModels?.has(modelId)), reason: 'not listed in /v1/models' };
      }

      if (result.ok) {
        provider.models = provider.models || {};
        provider.models[modelId] = {
          ...defaultModelEntry(modelId),
          ...(provider.models[modelId] || {}),
          id: modelId,
          disabled: false,
        };
        kept.push(`${provider.id}:${modelId}`);
        console.log(`ok: ${provider.id} -> ${modelId}`);
      } else {
        if (provider.models && provider.models[modelId]) {
          delete provider.models[modelId];
        }
        removed.push(`${provider.id}:${modelId}`);
        console.warn(`removed: ${provider.id} -> ${modelId} (${result.reason || 'unknown'})`);
      }
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  if (dryRun) {
    console.log(`[dry-run] Would keep ${kept.length} provider-model mapping(s), remove ${removed.length} mapping(s).`);
    return;
  }

  await dataManager.save<LoadedProviders>('providers', providers);
  console.log(`Saved providers.json. Kept ${kept.length}, removed ${removed.length}.`);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
}).finally(async () => {
  if (redis) {
    try { await redis.quit(); } catch {}
  }
});
