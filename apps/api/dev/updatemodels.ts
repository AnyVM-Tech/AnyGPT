import fs from 'fs';
import path from 'path';

type ModelsFile = {
  data: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
    providers?: number;
    throughput?: number;
    capabilities?: string[];
    availability?: {
      reason?: string;
      unavailable_reason?: string;
      removal_reason?: string;
      capability_blocked?: string[];
      capability_skips?: Record<string, string>;
    };
  }>;
};

type ProviderModelMeta = {
  removed?: boolean;
  unavailable?: boolean;
  disabled?: boolean;
  capabilities?: string[];
  capability_blocked?: string[];
  capability_skips?: Record<string, string>;
  availability?: {
    reason?: string;
    unavailable_reason?: string;
    removal_reason?: string;
    capability_blocked?: string[];
    capability_skips?: Record<string, string>;
  };
  reason?: string;
  unavailable_reason?: string;
  removal_reason?: string;
};

type AvailabilityMetadata = {
  reason?: string;
  unavailable_reason?: string;
  removal_reason?: string;
  capability_blocked?: string[];
  capability_skips?: Record<string, string>;
};

type ProviderFile = Array<{
  id: string;
  disabled?: boolean;
  models?: Record<string, ProviderModelMeta | null>;
}>;

function isNonChatModel(modelId: string): 'tts' | 'stt' | 'image-gen' | 'video-gen' | 'embedding' | false {
  const normalized = String(modelId || '').toLowerCase();
  if (normalized.startsWith('tts-') || normalized.includes('-tts')) return 'tts';
  if (normalized.startsWith('whisper') || normalized.includes('transcribe')) return 'stt';
  if (
    normalized.startsWith('sora')
    || normalized.startsWith('veo-')
    || normalized.includes('grok-imagine-video')
    || normalized.includes('imagine-video')
  ) return 'video-gen';
  if (
    normalized.startsWith('dall-e')
    || normalized.includes('gpt-image')
    || normalized.includes('chatgpt-image')
    || normalized.includes('image-gen')
    || normalized.includes('imagegen')
    || normalized.startsWith('imagen')
    || normalized.includes('imagen')
    || normalized.includes('nano-banana')
    || normalized.includes('grok-imagine')
    || normalized.includes('grok-2-image')
  ) return 'image-gen';
  if (normalized.includes('embedding')) return 'embedding';
  return false;
}

function isAvailabilityConstraintReason(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return /provider[_ -]?model[_ -]?removed|provider[_ -]?cap[_ -]?blocked|image generation unavailable|image generation unavailable in (?:provider )?(?:region|country|location)|generation unavailable|generation unavailable in (?:provider )?(?:region|country|location)|unavailable in provider region|unavailable in country|blocked in provider region|blocked in country|country-blocked|country blocked|regional availability|region(?:al)? availability|region-locked|region locked|geo(?:graph(?:ic)?)? restriction|geo(?:graph(?:ic)?)? restricted|geo-restricted|georestricted|country availability|unsupported image output|\bno access\b|access denied|not entitled|not enabled for (?:this )?(?:account|project)|permission denied|forbidden|not available to your account|not available for your account|not available in (?:your |this )?(?:region|country|location)|not available for (?:your |this )?(?:region|country|location)|not supported in (?:your |this )?(?:region|country|location)|blocked in (?:your |this )?(?:region|country|location)|unavailable in (?:your |this )?(?:region|country|location)|unavailable for (?:your |this )?(?:region|country|location)|(?:region|country|location) is unavailable|unavailable due to (?:region|country|location)|not available in the selected model|no allowed providers are available|model is not available|model unavailable|provider unavailable|provider not available|not available for this provider|not available from this provider|not accessible|access restricted|account restricted|project restricted|not provisioned|not whitelisted|not authorized|unauthorized|unsupported in your region|insufficient permissions?|missing permissions?|permission\s+required|requires? (?:billing|verification|organization verification|org verification)|billing (?:required|disabled|not enabled)|organization verification required|org verification required|account not verified|project not verified|service not enabled|api not enabled|feature not enabled|disabled for your account|disabled for this account|disabled for your project|not available on your current plan|plan upgrade required|upgrade required/.test(normalized);
}

function collectAvailabilityConstraintMetadata(meta: ProviderModelMeta | null | undefined): {
  blockedCapabilities: string[];
  capabilitySkips: Record<string, string>;
  reasonTexts: string[];
} {
  if (!meta || typeof meta !== 'object') {
    return {
      blockedCapabilities: [],
      capabilitySkips: {},
      reasonTexts: [],
    };
  }

  const normalizeCapabilityConstraintKey = (value: unknown): string => {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized) return '';
    if (
      normalized === 'image'
      || normalized === 'image_output'
      || normalized === 'image_generation'
      || normalized === 'image_gen'
      || normalized === 'image_creation'
    ) return 'image_output';
    if (normalized === 'image_input' || normalized === 'vision') return 'image_input';
    if (normalized === 'audio' || normalized === 'audio_output' || normalized === 'speech' || normalized === 'tts') return 'audio_output';
    if (normalized === 'audio_input' || normalized === 'stt' || normalized === 'transcription') return 'audio_input';
    if (normalized === 'tool' || normalized === 'tools' || normalized === 'tool_calling' || normalized === 'function_calling') return 'tool_calling';
    if (normalized === 'text' || normalized === 'chat' || normalized === 'completion' || normalized === 'completions') return 'text';
    return normalized;
  };

  const blockedCapabilities = Array.from(new Set([
    ...(Array.isArray(meta.capability_blocked) ? meta.capability_blocked : []),
    ...(Array.isArray(meta.availability?.capability_blocked) ? meta.availability.capability_blocked : []),
  ]
    .map((entry) => normalizeCapabilityConstraintKey(entry))
    .filter(Boolean)));

  const capabilitySkips: Record<string, string> = {};
  for (const source of [meta.availability?.capability_skips, meta.capability_skips]) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      capabilitySkips[key] = value;
    }
  }

  const reasonTexts = [
    meta.reason,
    meta.unavailable_reason,
    meta.removal_reason,
    meta.availability?.reason,
    meta.availability?.unavailable_reason,
    meta.availability?.removal_reason,
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

  return { blockedCapabilities, capabilitySkips, reasonTexts };
}

function hasAvailabilityConstraint(modelId: string, meta: ProviderModelMeta | null | undefined): boolean {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.removed || meta.unavailable || meta.disabled) return true;

  const { blockedCapabilities, capabilitySkips, reasonTexts } = collectAvailabilityConstraintMetadata(meta);
  const nonChatType = isNonChatModel(modelId);

  if ((nonChatType === 'image-gen' || nonChatType === 'video-gen') && (
    blockedCapabilities.includes('image_output')
    || typeof capabilitySkips.image_output === 'string'
    || reasonTexts.some((reason) => isAvailabilityConstraintReason(reason))
  )) {
    return true;
  }

  if (nonChatType === 'tts' && (
    blockedCapabilities.includes('audio_output')
    || typeof capabilitySkips.audio_output === 'string'
  )) {
    return true;
  }

  if (nonChatType === 'stt' && (
    blockedCapabilities.includes('audio_input')
    || typeof capabilitySkips.audio_input === 'string'
  )) {
    return true;
  }

  return false;
}

function shouldCountProviderModel(modelId: string, meta: ProviderModelMeta | null | undefined): boolean {
  if (!meta || typeof meta !== 'object') return true;
  if (meta.removed || meta.unavailable || meta.disabled) return false;
  return !hasAvailabilityConstraint(modelId, meta);
}

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
    baidu: 'baidu',
    'z-ai': 'z.ai',
    together: 'together',
    groq: 'groq',
    azure: 'microsoft',
    microsoft: 'microsoft',
    amazon: 'amazon',
    bedrock: 'amazon',
  };
  if (prefix && prefixMap[prefix]) return prefixMap[prefix];
  if (lower.startsWith('gpt')) return 'openai';
  if (lower.includes('claude')) return 'anthropic';
  if (lower.includes('gemini') || lower.includes('gemma')) return 'google';
  if (lower.includes('llama')) return 'meta';
  if (lower.includes('mistral') || lower.includes('ministral') || lower.includes('mixtral')) return 'mistral.ai';
  if (lower.includes('qwen')) return 'alibaba';
  if (lower.includes('o1') || lower.includes('chatgpt')) return 'openai';
  if (lower.includes('command')) return 'cohere';
  return 'unknown';
}

function loadJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`Failed to read ${filePath}:`, error);
    return null;
  }
}

function saveJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function main() {
  const modelsPath = path.resolve('models.json');
  const providersPath = path.resolve('providers.json');

  const providers = loadJson<ProviderFile>(providersPath) || [];
  const modelsFile = loadJson<ModelsFile>(modelsPath);

  if (!modelsFile || !Array.isArray(modelsFile.data)) {
    console.error('Invalid models.json format.');
    return;
  }

  const activeProviderCounts: Record<string, number> = {};
  const availableModels = new Set<string>();
  const providerSeenModels = new Set<string>();
  const constrainedCatalogModelIds = new Set<string>();

  const constrainedModelIds = new Set<string>();

  for (const provider of providers) {
    if (!provider.models) continue;
    for (const [modelId, modelMeta] of Object.entries(provider.models)) {
      const meta = modelMeta as ProviderModelMeta | null;
      const constrained = hasAvailabilityConstraint(modelId, meta);
      providerSeenModels.add(modelId);
      if (constrained) {
        constrainedModelIds.add(modelId);
        constrainedCatalogModelIds.add(modelId);
        if (
          meta
          && (
            !provider.disabled
            || meta.removed === true
            || meta.unavailable === true
            || meta.disabled === true
          )
        ) {
          constrainedCatalogModelIds.add(modelId);
        }
      }

      if (provider.disabled || !shouldCountProviderModel(modelId, meta)) continue;
      availableModels.add(modelId);
      activeProviderCounts[modelId] = (activeProviderCounts[modelId] || 0) + 1;
    }
  }

  const updatedModels: ModelsFile['data'] = [];
  let changes = false;
  const existingIds = new Set(modelsFile.data.map((m) => m.id));

  for (const model of modelsFile.data) {
    const count = activeProviderCounts[model.id] || 0;
    const isConstrained = constrainedModelIds.has(model.id);
    const isStillCatalogPresent = providerSeenModels.has(model.id);
    const shouldRetainAsConstrained = count === 0 && isConstrained && isStillCatalogPresent;
    const shouldRetainExistingModel = count > 0 || shouldRetainAsConstrained;

    if (!shouldRetainExistingModel) {
      changes = true;
      console.log(`Removed ${model.id} because it has 0 active providers and no availability constraint`);
      continue;
    }

    if (model.providers !== count) {
      model.providers = count;
      changes = true;
      if (shouldRetainAsConstrained) {
        console.log(`Retained ${model.id} with 0 active providers (availability constrained)`);
      } else {
        console.log(`Updated ${model.id} providers -> ${count}`);
      }
    } else if (shouldRetainAsConstrained) {
      console.log(`Retained ${model.id} with 0 active providers (availability constrained)`);
    }
    if (!model.owned_by || model.owned_by === 'unknown') {
      const guessed = guessOwnedBy(model.id);
      if (guessed !== model.owned_by) {
        model.owned_by = guessed;
        changes = true;
        console.log(`Updated ${model.id} owner -> ${guessed}`);
      }
    }
    updatedModels.push(model);
  }

  for (const modelId of availableModels) {
    if (existingIds.has(modelId)) continue;
    const isConstrained = constrainedModelIds.has(modelId);
    const providerCount = activeProviderCounts[modelId] ?? 0;

    if (isConstrained) {
      console.log(`Skipped adding ${modelId} because it is marked as availability-constrained during provider sync`);
      continue;
    }

    const newModel = {
      id: modelId,
      object: 'model',
      created: Date.now(),
      owned_by: guessOwnedBy(modelId),
      providers: providerCount,
    };
    updatedModels.push(newModel);
    changes = true;
    console.log(`Added ${modelId} (${providerCount} provider(s))`);
  }

  if (!changes) {
    console.log('models.json already up to date.');
    return;
  }

  modelsFile.data = updatedModels;
  saveJson(modelsPath, modelsFile);
  console.log(`models.json updated with ${updatedModels.length} entries.`);
}

main();
