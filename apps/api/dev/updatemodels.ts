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
  }>;
};

type ProviderFile = Array<{
  id: string;
  disabled?: boolean;
  models?: Record<string, unknown>;
}>;

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

  for (const provider of providers) {
    if (provider.disabled) continue;
    if (!provider.models) continue;
    for (const modelId of Object.keys(provider.models)) {
      availableModels.add(modelId);
      activeProviderCounts[modelId] = (activeProviderCounts[modelId] || 0) + 1;
    }
  }

  const updatedModels: ModelsFile['data'] = [];
  let changes = false;

  for (const model of modelsFile.data) {
    const count = activeProviderCounts[model.id] || 0;
    if (count === 0) {
      console.log(`Removing ${model.id}: no active providers`);
      changes = true;
      continue;
    }

    if (model.providers !== count) {
      model.providers = count;
      changes = true;
      console.log(`Updated ${model.id} providers -> ${count}`);
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

  const existingIds = new Set(updatedModels.map((m) => m.id));
  for (const modelId of availableModels) {
    if (existingIds.has(modelId)) continue;
    const newModel = {
      id: modelId,
      object: 'model',
      created: Date.now(),
      owned_by: guessOwnedBy(modelId),
      providers: activeProviderCounts[modelId],
    };
    updatedModels.push(newModel);
    changes = true;
    console.log(`Added ${modelId} (${activeProviderCounts[modelId]} provider(s))`);
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
