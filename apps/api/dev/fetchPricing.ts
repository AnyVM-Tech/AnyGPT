/**
 * Fetches model pricing from available APIs and generates/updates pricing.json.
 * 
 * Sources:
 * - OpenRouter API (for models they host — subtract their ~5% markup for direct pricing estimate)
 * - Manual entries for known official prices
 * 
 * Usage: node dist/dev/fetchPricing.js
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

// Official prices from provider documentation (as of Feb 2026)
// All prices in $ per million tokens unless noted
const OFFICIAL_PRICES: Record<string, Partial<ModelPricing>> = {
  // ============================================================
  // OpenAI — https://openai.com/api/pricing/
  // ============================================================
  // GPT-4o family
  'gpt-4o': { input: 2.50, output: 10.00, image_input: 0.001913, source: 'official' },
  'gpt-4o-2024-05-13': { input: 5.00, output: 15.00, source: 'official' },
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
  // GPT-3.5 family
  'gpt-3.5-turbo': { input: 0.50, output: 1.50, source: 'official' },
  'gpt-3.5-turbo-0125': { input: 0.50, output: 1.50, source: 'official' },
  'gpt-3.5-turbo-1106': { input: 1.00, output: 2.00, source: 'official' },
  'gpt-3.5-turbo-16k': { input: 3.00, output: 4.00, source: 'official' },
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
  // Audio models
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
  // Image generation
  'gpt-image-1': { input: 0, output: 0, per_image: 0.04, source: 'official' },
  'gpt-image-1-mini': { input: 0, output: 0, per_image: 0.02, source: 'official' },
  'gpt-image-1.5': { input: 0, output: 0, per_image: 0.04, source: 'official' },
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

async function fetchOpenRouterPricing(): Promise<Record<string, Partial<ModelPricing>>> {
  const prices: Record<string, Partial<ModelPricing>> = {};
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
      
      // OpenRouter adds ~5% markup. Subtract to estimate direct pricing.
      const MARKUP = 0.95;
      
      if (promptPrice > 0 || completionPrice > 0) {
        prices[id] = {
          input: parseFloat((promptPrice * 1e6 * MARKUP).toFixed(4)),
          output: parseFloat((completionPrice * 1e6 * MARKUP).toFixed(4)),
          source: 'openrouter',
        };
        if (imagePrice > 0) {
          prices[id].per_image = parseFloat((imagePrice * MARKUP).toFixed(6));
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

  // Fetch from OpenRouter
  const openrouterPrices = await fetchOpenRouterPricing();

  // Merge: official > existing > openrouter
  const merged: Record<string, ModelPricing> = {};
  const now = new Date().toISOString();

  for (const modelId of modelIds) {
    const official = OFFICIAL_PRICES[modelId];
    const existingEntry = existing.models[modelId];
    const orPrice = openrouterPrices[modelId];
    // Also check with/without prefix
    const strippedId = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
    const orPriceStripped = openrouterPrices[strippedId] || Object.entries(openrouterPrices).find(([k]) => k.endsWith('/' + modelId))?.[1];

    if (official) {
      merged[modelId] = {
        input: official.input ?? 0,
        output: official.output ?? 0,
        ...official,
        source: 'official',
        updated_at: now,
      } as ModelPricing;
    } else if (existingEntry?.source === 'official') {
      merged[modelId] = existingEntry;
    } else if (orPrice) {
      merged[modelId] = {
        input: orPrice.input ?? 0,
        output: orPrice.output ?? 0,
        ...orPrice,
        source: 'openrouter',
        updated_at: now,
      } as ModelPricing;
    } else if (orPriceStripped) {
      merged[modelId] = {
        input: orPriceStripped.input ?? 0,
        output: orPriceStripped.output ?? 0,
        ...orPriceStripped,
        source: 'openrouter',
        updated_at: now,
      } as ModelPricing;
    } else if (existingEntry) {
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
