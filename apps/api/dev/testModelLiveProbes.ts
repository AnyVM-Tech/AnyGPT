import { dataManager, LoadedProviders, LoadedProviderData, ModelsFileStructure } from '../modules/dataManager.js';
import { ModelCapability, IMessage } from '../providers/interfaces.js';
import { OpenAI } from '../providers/openai.js';
import { GeminiAI } from '../providers/gemini.js';
import { ImagenAI } from '../providers/imagen.js';
import { DeepseekAI } from '../providers/deepseek.js';
import { OpenRouterAI } from '../providers/openrouter.js';

// Simple live probe for a representative request per capability for each model.
// It picks the first available provider for the model (disabled providers are skipped) and
// attempts minimal payloads: text, image input, image output, audio input, audio output,
// streaming, realtime. Results are written back into models.json under `tested_capabilities`.
//
// Run (prefer Node 20/22 per engines):
//   cd apps/api && pnpm tsx ./dev/testModelLiveProbes.ts
//
// This will issue real API calls using keys from providers.json. Use cautiously to avoid quota use.

// Tunables (override via env):
//   CAP_TEST_TIMEOUT_MS: per-call timeout
//   CAP_TEST_MAX_MODELS: limit how many models to probe
//   CAP_TEST_STOP_ON_FAIL: if "1", stop entire run on first failure
const REQUEST_TIMEOUT_MS = Number(process.env.CAP_TEST_TIMEOUT_MS ?? 15000);
const MAX_MODELS = Number.isFinite(Number(process.env.CAP_TEST_MAX_MODELS))
  ? Number(process.env.CAP_TEST_MAX_MODELS)
  : Infinity;
const STOP_ON_FAIL = process.env.CAP_TEST_STOP_ON_FAIL === '1';

const SAMPLE_IMAGE_URL = 'https://dummyimage.com/1x1/000/fff';
// 1 second of silence WAV (8k mono 16-bit)
const SAMPLE_AUDIO_BASE64 =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

// Map provider id to class resolver
function buildProviderInstance(p: LoadedProviderData) {
  const key = p.apiKey || '';
  const url = p.provider_url || '';
  if (p.id.includes('openai')) return new OpenAI(key, url);
  if (p.id.includes('openrouter')) return new OpenRouterAI(key, url);
  if (p.id.includes('deepseek')) return new DeepseekAI(key, url);
  if (p.id.includes('imagen')) return new ImagenAI(key);
  if (p.id.includes('gemini') || p.id === 'google') return new GeminiAI(key);
  return new OpenAI(key, url);
}

function pickProvider(providers: LoadedProviders, modelId: string): LoadedProviderData | null {
  for (const p of providers) {
    if (p.disabled) continue;
    if (p.models && p.models[modelId]) return p;
  }
  return null;
}

function buildMessage(modelId: string, caps: Set<ModelCapability>, mode: 'stream' | 'normal'): IMessage {
  const content: any[] = [];
  // Text baseline
  content.push({ type: 'text', text: `probe for ${modelId}${caps.has('image_output') ? ' [image_output]' : ''}` });
  if (caps.has('image_input')) {
    content.push({ type: 'image_url', image_url: { url: SAMPLE_IMAGE_URL, detail: 'low' } });
  }
  if (caps.has('audio_input')) {
    content.push({ type: 'input_audio', input_audio: { data: SAMPLE_AUDIO_BASE64, format: 'wav' } });
  }
  return { content, model: { id: modelId } } as IMessage;
}

async function runWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms (${label})`)), REQUEST_TIMEOUT_MS);
    fn()
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function testCapability(
  providerData: LoadedProviderData,
  modelId: string,
  caps: Set<ModelCapability>,
  mode: 'stream' | 'normal'
): Promise<string> {
  const provider = buildProviderInstance(providerData);
  const message = buildMessage(modelId, caps, mode);

  try {
    if (mode === 'stream' && typeof (provider as any).sendMessageStream === 'function') {
      const stream = await runWithTimeout(async () => (provider as any).sendMessageStream(message), `${modelId}:${mode}:open-stream`);
      const first = await runWithTimeout(() => stream.next(), `${modelId}:${mode}:first-chunk`);
      if ((first as any).done) return 'fail: empty stream';
      return 'ok';
    }
    const res = await runWithTimeout(() => provider.sendMessage(message), `${modelId}:${mode}:request`);
    return res && typeof res.response === 'string' ? 'ok' : 'fail: empty response';
  } catch (err: any) {
    return `fail: ${err?.message || 'unknown error'}`;
  }
}

function inferTestModes(modelId: string, modelCaps: ModelCapability[]): Array<{ name: string; caps: Set<ModelCapability>; mode: 'stream' | 'normal' }> {
  const capsSet = new Set<ModelCapability>(modelCaps.length ? modelCaps : ['text']);
  const tests: Array<{ name: string; caps: Set<ModelCapability>; mode: 'stream' | 'normal' }> = [];

  // Text baseline always
  tests.push({ name: 'text', caps: new Set<ModelCapability>(['text']), mode: 'normal' });

  if (capsSet.has('image_input')) tests.push({ name: 'image_input', caps: new Set<ModelCapability>(['text', 'image_input']), mode: 'normal' });
  if (capsSet.has('image_output')) tests.push({ name: 'image_output', caps: new Set<ModelCapability>(['text', 'image_output']), mode: 'normal' });
  if (capsSet.has('audio_input')) tests.push({ name: 'audio_input', caps: new Set<ModelCapability>(['text', 'audio_input']), mode: 'normal' });
  if (capsSet.has('audio_output')) tests.push({ name: 'audio_output', caps: new Set<ModelCapability>(['text', 'audio_output']), mode: 'normal' });

  // Streaming probe for any model (uses same payload as text)
  tests.push({ name: 'streaming', caps: new Set<ModelCapability>(['text']), mode: 'stream' });

  // Heuristic realtime: name contains 'realtime'
  if (modelId.toLowerCase().includes('realtime')) {
    tests.push({ name: 'realtime', caps: new Set<ModelCapability>(['text']), mode: 'stream' });
  }

  return tests;
}

async function main() {
  const modelsRaw = await dataManager.load<ModelsFileStructure>('models');
  const models = modelsRaw.data as Array<{ id: string; capabilities?: ModelCapability[]; tested_capabilities?: Record<string, string> }>;
  const providers = await dataManager.load<LoadedProviders>('providers');

  console.log(`Loaded ${models.length} models and ${providers.length} providers.`);

  let processed = 0;
  for (const model of models) {
    if (processed >= MAX_MODELS) {
      console.log(`Reached CAP_TEST_MAX_MODELS (${MAX_MODELS}); stopping.`);
      break;
    }
    const provider = pickProvider(providers, model.id);
    if (!provider) {
      model.tested_capabilities = { ...(model.tested_capabilities || {}), _status: 'skipped: no provider' };
      continue;
    }

    const caps = Array.isArray(model.capabilities) && model.capabilities.length ? (model.capabilities as ModelCapability[]) : (['text'] as ModelCapability[]);
    const tests = inferTestModes(model.id, caps);
    const results: Record<string, string> = { ...(model.tested_capabilities || {}) };

    for (const test of tests) {
      const key = test.name;
      // Avoid retesting if already marked ok
      if (results[key] && results[key].startsWith('ok')) continue;
      const outcome = await testCapability(provider, model.id, test.caps, test.mode);
      results[key] = outcome;
      console.log(`${model.id} [${key}] -> ${outcome}`);
      if (STOP_ON_FAIL && outcome.startsWith('fail')) {
        model.tested_capabilities = results;
        await dataManager.save('models', modelsRaw);
        console.log(`Stopping early due to failure (CAP_TEST_STOP_ON_FAIL=1).`);
        return;
      }
    }

    model.tested_capabilities = results;
    processed += 1;
  }

  await dataManager.save('models', modelsRaw);
  console.log('models.json updated with tested_capabilities results.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
