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
  if (modelId.startsWith('gpt')) return 'openai';
  if (modelId.includes('claude')) return 'anthropic';
  if (modelId.includes('gemini') || modelId.includes('gemma')) return 'google';
  if (modelId.includes('llama')) return 'meta';
  if (modelId.includes('mistral') || modelId.includes('ministral') || modelId.includes('mixtral')) return 'mistral.ai';
  if (modelId.includes('qwen')) return 'alibaba';
  if (modelId.includes('o1') || modelId.includes('chatgpt')) return 'openai';
  if (modelId.includes('command')) return 'cohere';
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