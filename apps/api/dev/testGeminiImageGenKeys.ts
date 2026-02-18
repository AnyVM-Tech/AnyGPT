import { dataManager, LoadedProviders, ModelsFileStructure } from '../modules/dataManager.js';
import { GeminiAI } from '../providers/gemini.js';
import type { IMessage, ModelCapability } from '../providers/interfaces.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const includeDisabled = args.includes('--include-disabled');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const maxModelsArg = args.find((arg) => arg.startsWith('--max-models='));
const maxModels = maxModelsArg ? Number(maxModelsArg.split('=')[1]) : 2;
const delayArg = args.find((arg) => arg.startsWith('--delay-ms='));
const delayMs = delayArg ? Number(delayArg.split('=')[1]) : 250;
const providerFilterArg = args.find((arg) => arg.startsWith('--provider='));
const providerFilter = providerFilterArg ? providerFilterArg.split('=')[1].trim().toLowerCase() : '';

const IMAGE_PROMPT = 'Generate a simple image of a blue square on a white background.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeModelId(id: string): string {
  return id.startsWith('google/') ? id.slice('google/'.length) : id;
}

function isLikelyImageModel(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes('imagen')
    || lower.includes('image')
    || lower.includes('nano-banana')
  );
}

function buildImageOutputSet(models: ModelsFileStructure): Set<string> {
  const set = new Set<string>();
  for (const model of models.data || []) {
    const caps = Array.isArray(model.capabilities) ? model.capabilities as ModelCapability[] : [];
    if (!caps.includes('image_output')) continue;
    const id = String(model.id || '');
    if (!id) continue;
    set.add(id);
    set.add(normalizeModelId(id));
  }
  return set;
}

function pickCandidateModels(
  providerModels: string[],
  imageOutputSet: Set<string>,
  maxCount: number
): string[] {
  const normalized = providerModels.map((id) => normalizeModelId(id));
  const supported = providerModels.filter((id, idx) => imageOutputSet.has(id) || imageOutputSet.has(normalized[idx]));
  const fallback = providerModels.filter((id) => isLikelyImageModel(id));
  const candidates = supported.length > 0 ? supported : fallback;
  return candidates.slice(0, Math.max(1, maxCount));
}

function classifyImageOutputFailure(message: string): { kind: 'unsupported' | 'quota' | 'no_access' | 'other'; reason: string } {
  const lower = message.toLowerCase();
  if (
    lower.includes('quota')
    || lower.includes('insufficient')
    || lower.includes('resource exhausted')
    || lower.includes('status 429')
    || lower.includes('rate limit')
  ) {
    return { kind: 'quota', reason: message };
  }
  if (
    lower.includes('permission')
    || lower.includes('not allowed')
    || lower.includes('no access')
    || lower.includes('does not have access')
    || lower.includes('unauthorized')
  ) {
    return { kind: 'no_access', reason: message };
  }
  if (
    lower.includes('response modalities')
    || lower.includes('does not support image')
    || lower.includes('image generation')
    || lower.includes('image output')
    || lower.includes('image modality')
  ) {
    return { kind: 'unsupported', reason: message };
  }
  return { kind: 'other', reason: message };
}

async function testImageOutput(apiKey: string, modelId: string): Promise<boolean> {
  const provider = new GeminiAI(apiKey);
  const message: IMessage = {
    model: { id: modelId },
    content: [{ type: 'text', text: IMAGE_PROMPT }],
    modalities: ['image'],
    max_output_tokens: 128,
  };
  const res = await provider.sendMessage(message);
  return typeof res.response === 'string' && res.response.length > 0;
}

async function main() {
  const providers = await dataManager.load<LoadedProviders>('providers');
  const models = await dataManager.load<ModelsFileStructure>('models');
  const imageOutputSet = buildImageOutputSet(models);

  let candidates = providers.filter((p) => p.id.includes('gemini') || p.id === 'google');
  if (!includeDisabled) {
    candidates = candidates.filter((p) => !p.disabled);
  }
  if (providerFilter) {
    candidates = candidates.filter((p) => p.id.toLowerCase().includes(providerFilter));
  }
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    candidates = candidates.slice(0, limit);
  }

  console.log(`Testing ${candidates.length} Gemini provider key(s) for image output...`);

  let updated = 0;
  for (const provider of candidates) {
    const apiKey = provider.apiKey || '';
    if (!apiKey) {
      console.warn(`Skipping ${provider.id}: missing api key.`);
      continue;
    }
    const modelIds = Object.keys(provider.models || {});
    const testModels = pickCandidateModels(modelIds, imageOutputSet, maxModels);
    if (testModels.length === 0) {
      console.warn(`Skipping ${provider.id}: no candidate image models.`);
      continue;
    }

    for (const modelId of testModels) {
      try {
        const ok = await testImageOutput(apiKey, modelId);
        if (ok) {
          const model = provider.models[modelId];
          if (model?.capability_skips?.image_output) {
            delete model.capability_skips.image_output;
          }
          if (model?.capability_skips && Object.keys(model.capability_skips).length === 0) {
            delete model.capability_skips;
          }
          console.log(`ok: ${provider.id} -> ${modelId} image_output`);
        } else {
          console.warn(`fail: ${provider.id} -> ${modelId} empty response`);
        }
        updated += 1;
      } catch (err: any) {
        const message = err?.message || String(err);
        const classification = classifyImageOutputFailure(message);
        if (classification.kind === 'unsupported') {
          const model = provider.models[modelId];
          if (model) {
            model.capability_skips = model.capability_skips || {};
            model.capability_skips.image_output = 'unsupported image output';
          }
          console.warn(`skip: ${provider.id} -> ${modelId} unsupported image output`);
          updated += 1;
        } else if (classification.kind === 'quota') {
          provider.disabled = true;
          console.warn(`disabled: ${provider.id} quota exceeded`);
        } else if (classification.kind === 'no_access') {
          provider.disabled = true;
          console.warn(`disabled: ${provider.id} no access`);
        } else {
          console.warn(`error: ${provider.id} -> ${modelId} ${classification.reason}`);
        }
      }
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  if (dryRun) {
    console.log(`[dry-run] Completed. Would update ${updated} model probe result(s).`);
    return;
  }

  await dataManager.save<LoadedProviders>('providers', providers);
  console.log(`Saved providers.json with ${updated} updated model probe result(s).`);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
