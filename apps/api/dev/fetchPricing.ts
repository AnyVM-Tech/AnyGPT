/**
 * Fetches model pricing from available APIs and generates/updates pricing.json.
 * 
 * Sources:
 * - OpenRouter API (for models they host — subtract their ~5% markup for direct pricing estimate)
 * - Manual entries for known official prices
 * 
 * Usage: node dist/production/dev/fetchPricing.js
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';

const PRICING_PATH = path.resolve('pricing.json');
const MODELS_PATH = path.resolve('models.json');

interface ModelPricing {
  input: number;           // $ per million input tokens
  output: number;          // $ per million output tokens
  image_input?: number;    // $ per image input
  image_output?: number;   // $ per image output
  audio_input?: number;    // $ per million audio input tokens
  audio_output?: number;   // $ per million audio output tokens
  per_image?: number;      // $ per generated image
  per_request?: number;    // $ per request (for special models)
  source: 'official' | 'openrouter' | 'estimated';
  updated_at: string;
}

interface PricingFile {
  updated_at: string;
  models: Record<string, ModelPricing>;
}

type PricingSeed = Partial<ModelPricing> & {
  image?: number;
  request?: number;
};

type PricingMap = Record<string, PricingSeed>;

function splitModelId(modelId: string): { prefix: string | null; baseId: string } {
  const parts = modelId.split('/');
  if (parts.length <= 1) return { prefix: null, baseId: modelId };
  return { prefix: parts[0], baseId: parts.slice(1).join('/') };
}

function guessProviderForModel(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('gpt') || lower.includes('openai') || lower.includes('chatgpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'openai';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('gemini') || lower.includes('gemma') || lower.startsWith('imagen') || lower.includes('nano-banana') || lower.startsWith('veo')) return 'google';
  if (lower.includes('llama') || lower.includes('meta-llama')) return 'meta';
  if (lower.includes('mistral') || lower.includes('ministral') || lower.includes('mixtral')) return 'mistral.ai';
  if (lower.includes('qwen')) return 'alibaba';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('grok') || lower.includes('xai') || lower.includes('x-ai')) return 'xai';
  if (lower.includes('command') || lower.includes('cohere')) return 'cohere';
  if (lower.includes('jamba') || lower.includes('ai21')) return 'ai21';
  return null;
}

function buildPricingCandidates(modelId: string): string[] {
  const candidates = new Set<string>();
  const add = (value?: string | null) => {
    if (!value) return;
    candidates.add(value);
  };

  add(modelId);
  const { baseId } = splitModelId(modelId);
  add(baseId);

  if (modelId.endsWith(':free')) {
    const withoutFree = modelId.slice(0, -5);
    add(withoutFree);
    add(splitModelId(withoutFree).baseId);
  }

  if (modelId.endsWith(':exacto')) {
    const withoutExacto = modelId.slice(0, -7);
    add(withoutExacto);
    add(splitModelId(withoutExacto).baseId);
  }

  if (modelId.endsWith('-mini')) {
    const withoutMini = modelId.slice(0, -5);
    add(withoutMini);
    add(splitModelId(withoutMini).baseId);
  }

  if (modelId.includes('-thinking')) {
    const withoutThinking = modelId.replace('-thinking', '');
    add(withoutThinking);
    add(splitModelId(withoutThinking).baseId);

    const collapsedThinking = modelId.replace('-thinking-', '-');
    add(collapsedThinking);
    add(splitModelId(collapsedThinking).baseId);

    const instructVariant = modelId.replace('-thinking', '-instruct');
    add(instructVariant);
    add(splitModelId(instructVariant).baseId);
  }

  const audioFamilyMatch = modelId.match(/^(.*?)-(transcribe|tts)(?:-\d{4}(?:-\d{2}){0,2})$/);
  if (audioFamilyMatch) {
    const stableAudioFamily = `${audioFamilyMatch[1]}-${audioFamilyMatch[2]}`;
    add(stableAudioFamily);
    add(splitModelId(stableAudioFamily).baseId);

    const familyRoot = audioFamilyMatch[1];
    add(familyRoot);
    add(splitModelId(familyRoot).baseId);
  }

  return Array.from(candidates);
}

function resolveOfficialPricing(modelId: string): PricingSeed | null {
  for (const candidate of buildPricingCandidates(modelId)) {
    const candidateKeys = new Set<string>([candidate]);
    const slashIndex = candidate.indexOf('/');
    if (slashIndex > 0 && slashIndex < candidate.length - 1) {
      const unprefixed = candidate.slice(slashIndex + 1);
      candidateKeys.add(unprefixed);
      candidateKeys.add(splitModelId(unprefixed).baseId);
    }

    for (const candidateKey of candidateKeys) {
      const price = OFFICIAL_PRICES[candidateKey];
      if (price) return price;

      const unprefixedBaseId = splitModelId(candidateKey).baseId;
      if (unprefixedBaseId && unprefixedBaseId !== candidateKey) {
        const baseIdPrice = OFFICIAL_PRICES[unprefixedBaseId];
        if (baseIdPrice) return baseIdPrice;
      }

      const directAudioFamilyBase = candidateKey.match(/^(.*?-(?:transcribe|tts))(?:-\d{4}(?:-\d{2}){0,2})$/)?.[1];
      if (directAudioFamilyBase) {
        const audioFamilyPrice = OFFICIAL_PRICES[directAudioFamilyBase];
        if (audioFamilyPrice) return audioFamilyPrice;
      }

      const datedVariantBase = candidateKey.match(/^(.*?)-\d{4}(?:-\d{2}){0,2}$/)?.[1];
      if (datedVariantBase) {
        const basePrice = OFFICIAL_PRICES[datedVariantBase];
        if (basePrice) return basePrice;

        const datedAudioFamilyBase = datedVariantBase.match(/^(.*?-(?:transcribe|tts))(?:-\d{4}(?:-\d{2}){0,2})$/)?.[1];
        if (datedAudioFamilyBase) {
          const audioFamilyPrice = OFFICIAL_PRICES[datedAudioFamilyBase];
          if (audioFamilyPrice) return audioFamilyPrice;
        }
      }

      const numericSuffixBase = candidateKey.match(/^(.*?)-\d{3,}$/)?.[1];
      if (numericSuffixBase) {
        const basePrice = OFFICIAL_PRICES[numericSuffixBase];
        if (basePrice) return basePrice;
      }

      const genericVersionBase = candidateKey.match(/^(.*?)-\d+(?:-\d+)*$/)?.[1];
      if (genericVersionBase && genericVersionBase !== candidateKey) {
        const basePrice = OFFICIAL_PRICES[genericVersionBase];
        if (basePrice) return basePrice;
      }
    }
  }
  return null;
}

function resolveOpenRouterPricing(modelId: string, openrouterPrices: PricingMap): PricingSeed | null {
  if (openrouterPrices[modelId]) return openrouterPrices[modelId];
  const { baseId } = splitModelId(modelId);
  if (openrouterPrices[baseId]) return openrouterPrices[baseId];

  const suffixMatches = Object.entries(openrouterPrices).filter(([key]) => key.endsWith(`/${baseId}`));
  if (suffixMatches.length === 0) return null;
  if (suffixMatches.length === 1) return suffixMatches[0][1];

  const preferredProvider = guessProviderForModel(baseId);
  if (preferredProvider) {
    const preferred = suffixMatches.find(([key]) => key.startsWith(`${preferredProvider}/`));
    if (preferred) return preferred[1];
  }

  return suffixMatches[0][1];
}

function buildPricingEntry(price: PricingSeed, source: ModelPricing['source'], now: string): ModelPricing {
  const normalized: ModelPricing = {
    input: price.input ?? 0,
    output: price.output ?? 0,
    source,
    updated_at: now,
  };

  if (typeof price.image_input === 'number') normalized.image_input = price.image_input;
  if (typeof price.image_output === 'number') normalized.image_output = price.image_output;
  if (typeof price.audio_input === 'number') normalized.audio_input = price.audio_input;
  if (typeof price.audio_output === 'number') normalized.audio_output = price.audio_output;
  if (typeof price.per_image === 'number') normalized.per_image = price.per_image;
  else if (typeof price.image === 'number') normalized.per_image = price.image;
  if (typeof price.per_request === 'number') normalized.per_request = price.per_request;
  else if (typeof price.request === 'number') normalized.per_request = price.request;

  return normalized;
}

// Official prices from provider documentation (as of Feb 2026)
// All prices in $ per million tokens unless noted
const OFFICIAL_PRICES: Record<string, PricingSeed> = {
  // ============================================================
  // OpenAI — https://openai.com/api/pricing/
  // ============================================================
  // GPT-4o family
  'gpt-4o': { input: 2.50, output: 10.00, image_input: 0.001913, source: 'official' },
  'gpt-4o-2024-05-13': { input: 5.00, output: 15.00, source: 'official' },
  'gpt-4o-mini-transcribe': { input: 0, output: 0, audio_input: 3.00, source: 'official' },
  'gpt-4o-mini-transcribe-2025-03-20': { input: 0, output: 0, audio_input: 3.00, source: 'official' },
  'gpt-4o-mini-transcribe-2025-12-15': { input: 0, output: 0, audio_input: 3.00, source: 'official' },
  'gpt-4o-mini-tts': { input: 0.60, output: 12.00, audio_output: 24.00, source: 'official' },
  'gpt-4o-mini-tts-2025-03-20': { input: 0.60, output: 12.00, audio_output: 24.00, source: 'official' },
  'gpt-4o-mini-tts-2025-12-15': { input: 0.60, output: 12.00, audio_output: 24.00, source: 'official' },
  'gpt-4o-2024-08-06': { input: 2.50, output: 10.00, source: 'official' },
  'gpt-4o-2024-11-20': { input: 2.50, output: 10.00, source: 'official' },
  'gpt-4o-mini': { input: 0.15, output: 0.60, source: 'official' },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.60, source: 'official' },
  'gpt-4o-search-preview': { input: 2.50, output: 10.00, source: 'official' },
  'gpt-4o-search-preview-2025-03-11': { input: 2.50, output: 10.00, source: 'official' },
  'gpt-4o-mini-search-preview': { input: 0.15, output: 0.60, source: 'official' },
  'gpt-4o-mini-search-preview-2025-03-11': { input: 0.15, output: 0.60, source: 'official' },
  'gpt-4o-transcribe-diarize': { input: 2.50, output: 10.00, audio_input: 6.00, source: 'official' },
  // GPT-4.1 family
  'gpt-4.1': { input: 2.00, output: 8.00, source: 'official' },
  'gpt-4.1-2025-04-14': { input: 2.00, output: 8.00, source: 'official' },
  'gpt-4.1-mini': { input: 0.40, output: 1.60, source: 'official' },
  'gpt-4.1-mini-2025-04-14': { input: 0.40, output: 1.60, source: 'official' },
  'gpt-4.1-nano': { input: 0.10, output: 0.40, source: 'official' },
  'gpt-4.1-nano-2025-04-14': { input: 0.10, output: 0.40, source: 'official' },
  // GPT-4 legacy
  'gpt-4': { input: 30.00, output: 60.00, source: 'official' },
  'gpt-4-0314': { input: 30.00, output: 60.00, source: 'official' },
  'gpt-4-0613': { input: 30.00, output: 60.00, source: 'official' },
  'gpt-4-turbo': { input: 10.00, output: 30.00, source: 'official' },
  'gpt-4-turbo-2024-04-09': { input: 10.00, output: 30.00, source: 'official' },
  'gpt-4-turbo-preview': { input: 10.00, output: 30.00, source: 'official' },
  'gpt-4-0125-preview': { input: 10.00, output: 30.00, source: 'official' },
  'gpt-4-1106-preview': { input: 10.00, output: 30.00, source: 'official' },
  'davinci-002': { input: 2.00, output: 2.00, source: 'official' },
  'babbage-002': { input: 0.40, output: 0.40, source: 'official' },
  // GPT-3.5 family
  'gpt-3.5-turbo': { input: 0.50, output: 1.50, source: 'official' },
  'gpt-3.5-turbo-0125': { input: 0.50, output: 1.50, source: 'official' },
  'gpt-3.5-turbo-1106': { input: 1.00, output: 2.00, source: 'official' },
  'gpt-3.5-turbo-16k': { input: 3.00, output: 4.00, source: 'official' },
  'gpt-3.5-turbo-instruct': { input: 1.50, output: 2.00, source: 'official' },
  'gpt-3.5-turbo-instruct-0914': { input: 1.50, output: 2.00, source: 'official' },
  // GPT-5 family (latest pricing)
  'gpt-5': { input: 5.00, output: 20.00, source: 'official' },
  'gpt-5-2025-08-07': { input: 5.00, output: 20.00, source: 'official' },
  'gpt-5-chat-latest': { input: 5.00, output: 20.00, source: 'official' },
  'gpt-5-mini': { input: 0.60, output: 2.40, source: 'official' },
  'gpt-5-mini-2025-08-07': { input: 0.60, output: 2.40, source: 'official' },
  'gpt-5-nano': { input: 0.15, output: 0.60, source: 'official' },
  'gpt-5-nano-2025-08-07': { input: 0.15, output: 0.60, source: 'official' },
  'gpt-5-pro': { input: 10.00, output: 40.00, source: 'official' },
  'gpt-5-pro-2025-10-06': { input: 10.00, output: 40.00, source: 'official' },
  'gpt-5-search-api': { input: 5.00, output: 20.00, source: 'official' },
  'gpt-5-search-api-2025-10-14': { input: 5.00, output: 20.00, source: 'official' },
  'gpt-5-codex': { input: 5.00, output: 20.00, source: 'official' },
  // GPT-5.1 family
  'gpt-5.1': { input: 4.00, output: 16.00, source: 'official' },
  'gpt-5.1-2025-11-13': { input: 4.00, output: 16.00, source: 'official' },
  'gpt-5.1-chat-latest': { input: 4.00, output: 16.00, source: 'official' },
  'gpt-5.1-codex': { input: 4.00, output: 16.00, source: 'official' },
  'gpt-5.1-codex-max': { input: 8.00, output: 32.00, source: 'official' },
  'gpt-5.1-codex-mini': { input: 0.50, output: 2.00, source: 'official' },
  // GPT-5.2 family
  'gpt-5.2': { input: 3.00, output: 12.00, source: 'official' },
  'gpt-5.2-2025-12-11': { input: 3.00, output: 12.00, source: 'official' },
  'gpt-5.2-chat-latest': { input: 3.00, output: 12.00, source: 'official' },
  'gpt-5.2-codex': { input: 3.00, output: 12.00, source: 'official' },
  'gpt-5.2-pro': { input: 8.00, output: 32.00, source: 'official' },
  'gpt-5.2-pro-2025-12-11': { input: 8.00, output: 32.00, source: 'official' },
  'gpt-5.3-codex': { input: 2.50, output: 10.00, source: 'official' },
  // O-series reasoning
  'o1': { input: 15.00, output: 60.00, source: 'official' },
  'o1-2024-12-17': { input: 15.00, output: 60.00, source: 'official' },
  'o1-pro': { input: 150.00, output: 600.00, source: 'official' },
  'o1-pro-2025-03-19': { input: 150.00, output: 600.00, source: 'official' },
  'o3': { input: 10.00, output: 40.00, source: 'official' },
  'o3-2025-04-16': { input: 10.00, output: 40.00, source: 'official' },
  'o3-mini': { input: 1.10, output: 4.40, source: 'official' },
  'o3-mini-2025-01-31': { input: 1.10, output: 4.40, source: 'official' },
  'o3-pro': { input: 20.00, output: 80.00, source: 'official' },
  'o3-pro-2025-06-10': { input: 20.00, output: 80.00, source: 'official' },
  'o4-mini': { input: 1.10, output: 4.40, source: 'official' },
  'o4-mini-2025-04-16': { input: 1.10, output: 4.40, source: 'official' },
  'o3-deep-research': { input: 10.00, output: 40.00, source: 'official' },
  'o3-deep-research-2025-06-26': { input: 10.00, output: 40.00, source: 'official' },
  'o4-mini-deep-research': { input: 2.00, output: 8.00, source: 'official' },
  'o4-mini-deep-research-2025-06-26': { input: 2.00, output: 8.00, source: 'official' },
  // Audio models
  'gpt-4o-transcribe': { input: 2.50, output: 10.00, audio_input: 6.00, source: 'official' },
  'gpt-4o-audio-preview': { input: 2.50, output: 10.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-4o-audio-preview-2024-12-17': { input: 2.50, output: 10.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-4o-audio-preview-2025-06-03': { input: 2.50, output: 10.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-4o-mini-audio-preview': { input: 0.15, output: 0.60, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-4o-mini-audio-preview-2024-12-17': { input: 0.15, output: 0.60, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-audio': { input: 2.50, output: 10.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-audio-1.5': { input: 2.00, output: 8.00, audio_input: 30.00, audio_output: 60.00, source: 'official' },
  'gpt-audio-2025-08-28': { input: 2.50, output: 10.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-audio-mini': { input: 0.15, output: 0.60, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-audio-mini-2025-10-06': { input: 0.15, output: 0.60, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-audio-mini-2025-12-15': { input: 0.15, output: 0.60, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  // Realtime models
  'gpt-4o-realtime-preview': { input: 5.00, output: 20.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-4o-realtime-preview-2024-12-17': { input: 5.00, output: 20.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-4o-realtime-preview-2025-06-03': { input: 5.00, output: 20.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-4o-mini-realtime-preview': { input: 0.60, output: 2.40, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-4o-mini-realtime-preview-2024-12-17': { input: 0.60, output: 2.40, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-realtime': { input: 5.00, output: 20.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-realtime-2025-08-28': { input: 5.00, output: 20.00, audio_input: 40.00, audio_output: 80.00, source: 'official' },
  'gpt-realtime-mini': { input: 0.60, output: 2.40, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-realtime-mini-2025-10-06': { input: 0.60, output: 2.40, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-realtime-mini-2025-12-15': { input: 0.60, output: 2.40, audio_input: 10.00, audio_output: 20.00, source: 'official' },
  'gpt-realtime-1.5': { input: 4.00, output: 16.00, audio_input: 30.00, audio_output: 60.00, source: 'official' },
  'tts-1': { input: 15.00, source: 'official' },
  'tts-1-1106': { input: 15.00, source: 'official' },
  'tts-1-hd': { input: 30.00, source: 'official' },
  'tts-1-hd-1106': { input: 30.00, source: 'official' },
  'whisper-1': { audio_input: 0.006, source: 'official' },
  // Image generation
  'gpt-image-1': { input: 0, output: 0, per_image: 0.04, source: 'official' },
  'gpt-image-1-mini': { input: 0, output: 0, per_image: 0.02, source: 'official' },
  'gpt-image-1.5': { input: 0, output: 0, per_image: 0.04, source: 'official' },
  'gpt-5-image': { input: 0, output: 0, per_image: 0.04, source: 'official' },
  'gpt-5-image-mini': { input: 0, output: 0, per_image: 0.02, source: 'official' },
  'chatgpt-image-latest': { input: 0, output: 0, per_image: 0.04, source: 'official' },
  'dall-e-3': { input: 0, output: 0, per_image: 0.04, source: 'official' },
  'dall-e-2': { input: 0, output: 0, per_image: 0.02, source: 'official' },
  'sora-2': { input: 0, output: 0, per_image: 0.10, source: 'official' },
  'sora-2-pro': { input: 0, output: 0, per_image: 0.20, source: 'official' },
  // Embeddings
  'text-embedding-3-small': { input: 0.02, output: 0, source: 'official' },
  'text-embedding-3-large': { input: 0.13, output: 0, source: 'official' },
  'text-embedding-ada-002': { input: 0.10, output: 0, source: 'official' },
  // Special
  'computer-use-preview': { input: 3.00, output: 12.00, source: 'official' },
  'computer-use-preview-2025-03-11': { input: 3.00, output: 12.00, source: 'official' },
  'deep-research-pro-preview-12-2025': { input: 2.50, output: 10.00, source: 'official' },
  'omni-moderation-2024-09-26': { input: 0, output: 0, source: 'official' }, // free

  // ============================================================
  // Google Gemini — https://ai.google.dev/pricing
  // ============================================================
  'gemini-2.5-pro': { input: 1.25, output: 10.00, source: 'official' },
  'gemini-2.5-pro-preview-tts': { input: 1.25, output: 10.00, audio_output: 20.00, source: 'official' },
  'gemini-2.5-flash': { input: 0.15, output: 0.60, source: 'official' },
  'gemini-2.5-flash-image': { input: 0.15, output: 0.60, per_image: 0.04, source: 'official' },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30, source: 'official' },
  'gemini-2.5-flash-lite-preview-09-2025': { input: 0.075, output: 0.30, source: 'official' },
  'gemini-2.5-flash-preview-tts': { input: 0.15, output: 0.60, audio_output: 12.00, source: 'official' },
  'gemini-2.5-flash-native-audio-latest': { input: 0.15, output: 0.60, audio_input: 1.00, audio_output: 12.00, source: 'official' },
  'gemini-2.5-flash-native-audio-preview-09-2025': { input: 0.15, output: 0.60, audio_input: 1.00, audio_output: 12.00, source: 'official' },
  'gemini-2.5-flash-native-audio-preview-12-2025': { input: 0.15, output: 0.60, audio_input: 1.00, audio_output: 12.00, source: 'official' },
  'gemini-2.5-computer-use-preview-10-2025': { input: 1.25, output: 10.00, source: 'official' },
  'gemini-2.0-flash': { input: 0.10, output: 0.40, source: 'official' },
  'gemini-2.0-flash-001': { input: 0.10, output: 0.40, source: 'official' },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30, source: 'official' },
  'gemini-2.0-flash-lite-001': { input: 0.075, output: 0.30, source: 'official' },
  'gemini-flash-latest': { input: 0.15, output: 0.60, source: 'official' },
  'gemini-flash-lite-latest': { input: 0.075, output: 0.30, source: 'official' },
  'gemini-pro-latest': { input: 1.25, output: 10.00, source: 'official' },
  'gemini-3-flash-preview': { input: 0.10, output: 0.40, source: 'official' },
  'gemini-3-pro-preview': { input: 1.00, output: 8.00, source: 'official' },
  'gemini-3-pro-image-preview': { input: 1.00, output: 8.00, per_image: 0.04, source: 'official' },
  'gemini-3.1-pro-preview': { input: 1.00, output: 8.00, source: 'official' },
  'gemini-3.1-pro-preview-customtools': { input: 1.00, output: 8.00, source: 'official' },
  'gemini-robotics-er-1.5-preview': { input: 1.25, output: 5.00, source: 'official' },
  'gemini-embedding-001': { input: 0, output: 0, source: 'official' }, // free
  'gemma-3-1b-it': { input: 0, output: 0, source: 'official' }, // free (open model)
  'gemma-3-4b-it': { input: 0, output: 0, source: 'official' },
  'gemma-3-12b-it': { input: 0, output: 0, source: 'official' },
  'gemma-3-27b-it': { input: 0, output: 0, source: 'official' },
  'gemma-3n-e2b-it': { input: 0, output: 0, source: 'official' },
  'gemma-3n-e4b-it': { input: 0, output: 0, source: 'official' },
  'nano-banana-pro-preview': { input: 0.15, output: 0.60, per_image: 0.04, source: 'official' },
  'aqa': { input: 0, output: 0, source: 'official' }, // free
  // Imagen / Veo
  'imagen-4.0-generate-001': { input: 0, output: 0, per_image: 0.04, source: 'official' },
  'imagen-4.0-fast-generate-001': { input: 0, output: 0, per_image: 0.02, source: 'official' },
  'imagen-4.0-ultra-generate-001': { input: 0, output: 0, per_image: 0.08, source: 'official' },
  'veo-2.0-generate-001': { input: 0, output: 0, per_request: 0.35, source: 'official' },
  'veo-3.0-generate-001': { input: 0, output: 0, per_request: 0.50, source: 'official' },
  'veo-3.0-fast-generate-001': { input: 0, output: 0, per_request: 0.25, source: 'official' },
  'veo-3.1-generate-preview': { input: 0, output: 0, per_request: 0.50, source: 'official' },
  'veo-3.1-fast-generate-preview': { input: 0, output: 0, per_request: 0.25, source: 'official' },

  // ============================================================
  // Deepseek — https://api-docs.deepseek.com/quick_start/pricing
  // ============================================================
  'deepseek-chat': { input: 0.27, output: 1.10, source: 'official' },
  'deepseek-reasoner': { input: 0.55, output: 2.19, source: 'official' },

  // ============================================================
  // xAI / Grok — https://docs.x.ai/docs/models
  // ============================================================
  'grok-4-0709': { input: 6.00, output: 18.00, source: 'official' },
  'grok-4-fast-reasoning': { input: 3.00, output: 15.00, source: 'official' },
  'grok-4-fast-non-reasoning': { input: 3.00, output: 15.00, source: 'official' },
  'grok-4-1-fast-reasoning': { input: 3.00, output: 15.00, source: 'official' },
  'grok-4-1-fast-non-reasoning': { input: 3.00, output: 15.00, source: 'official' },
  'grok-3': { input: 3.00, output: 15.00, source: 'official' },
  'grok-3-mini': { input: 0.30, output: 0.50, source: 'official' },
  'grok-2-vision-1212': { input: 2.00, output: 10.00, source: 'official' },
  'grok-code-fast-1': { input: 0.50, output: 2.00, source: 'official' },
  'grok-2-image-1212': { input: 0, output: 0, per_image: 0.07, source: 'official' },
  'grok-imagine-image': { input: 0, output: 0, per_image: 0.07, source: 'official' },
  'grok-imagine-image-pro': { input: 0, output: 0, per_image: 0.14, source: 'official' },
  'grok-imagine-video': { input: 0, output: 0, per_request: 0.50, source: 'official' },
};

async function fetchOpenRouterPricing(): Promise<PricingMap> {
  const prices: PricingMap = {};
  try {
    console.log('Fetching OpenRouter model pricing...');
    const res = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 15000 });
    const models = res.data?.data || [];
    
    for (const model of models) {
      const id = model.id;
      const pricing = model.pricing;
      if (!pricing) continue;
      
      const promptPrice = parseFloat(pricing.prompt || '0');
      const completionPrice = parseFloat(pricing.completion || '0');
      const imagePrice = parseFloat(pricing.image || '0');
      const requestPrice = parseFloat(pricing.request || '0');
      
      // OpenRouter adds ~5% markup. Subtract to estimate direct pricing.
      const MARKUP = 0.95;
      
      if (promptPrice > 0 || completionPrice > 0 || imagePrice > 0 || requestPrice > 0) {
        prices[id] = {
          input: parseFloat((promptPrice * 1e6 * MARKUP).toFixed(6)),
          output: parseFloat((completionPrice * 1e6 * MARKUP).toFixed(6)),
          source: 'openrouter',
        };
        if (imagePrice > 0) {
          prices[id].per_image = parseFloat((imagePrice * MARKUP).toFixed(8));
        }
        if (requestPrice > 0) {
          prices[id].per_request = parseFloat((requestPrice * MARKUP).toFixed(8));
        }
      }
    }
    console.log(`Fetched pricing for ${Object.keys(prices).length} models from OpenRouter.`);
  } catch (err: any) {
    console.warn('Failed to fetch OpenRouter pricing:', err?.message || err);
  }
  return prices;
}

async function main() {
  // Load existing pricing if available
  let existing: PricingFile = { updated_at: '', models: {} };
  try {
    existing = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
  } catch { /* start fresh */ }

  // Load models list
  let modelIds: string[] = [];
  try {
    const modelsFile = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
    modelIds = (modelsFile.data || []).map((m: any) => m.id);
  } catch (err) {
    console.warn('Could not load models.json:', err);
  }

  const supplementalModelIds = Object.entries(OFFICIAL_PRICES)
    .filter(([, price]) => price.per_image || price.per_request)
    .map(([id]) => id);
  modelIds = Array.from(new Set([...modelIds, ...supplementalModelIds]));

  // Fetch from OpenRouter
  const openrouterPrices = await fetchOpenRouterPricing();

  // Merge priority:
  // 1) Official pricing entries
  // 2) Provider-specific OpenRouter entries (for models with provider prefixes)
  // 3) OpenRouter as fallback for unknown models
  // 4) Preserve existing entries (non-official) if still missing
  const merged: Record<string, ModelPricing> = {};
  const now = new Date().toISOString();

  for (const modelId of modelIds) {
    const official = resolveOfficialPricing(modelId);
    const existingEntry = existing.models[modelId];
    const { prefix, baseId } = splitModelId(modelId);

    if (official) {
      merged[modelId] = buildPricingEntry(official, 'official', now);
      continue;
    }

    if (existingEntry?.source === 'official') {
      merged[modelId] = existingEntry;
      continue;
    }

    const providerSpecificPrice = prefix ? resolveOpenRouterPricing(modelId, openrouterPrices) : null;
    if (providerSpecificPrice) {
      merged[modelId] = buildPricingEntry(providerSpecificPrice, 'openrouter', now);
      continue;
    }

    const fallbackPrice = resolveOpenRouterPricing(baseId, openrouterPrices);
    if (fallbackPrice) {
      merged[modelId] = buildPricingEntry(fallbackPrice, 'openrouter', now);
      continue;
    }

    if (existingEntry) {
      merged[modelId] = existingEntry;
    }
    // Models without any pricing data are omitted
  }

  const result: PricingFile = {
    updated_at: now,
    models: merged,
  };

  fs.writeFileSync(PRICING_PATH, JSON.stringify(result, null, 2), 'utf8');
  
  const officialCount = Object.values(merged).filter(p => p.source === 'official').length;
  const orCount = Object.values(merged).filter(p => p.source === 'openrouter').length;
  const estimatedCount = Object.values(merged).filter(p => p.source === 'estimated').length;
  const missingCount = modelIds.length - Object.keys(merged).length;
  
  console.log(`\nPricing saved to ${PRICING_PATH}`);
  console.log(`  Official: ${officialCount}`);
  console.log(`  OpenRouter (estimated): ${orCount}`);
  console.log(`  Estimated: ${estimatedCount}`);
  console.log(`  Missing: ${missingCount} model(s) without pricing`);
  console.log(`  Total: ${Object.keys(merged).length} / ${modelIds.length}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
