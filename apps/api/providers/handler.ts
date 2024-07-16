import { readFileSync } from 'fs';
import { GeminiAI } from 'providers/gemini';
import { OpenAI } from 'providers/openai';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

interface IAIProvider {
  sendMessage(message: string): Promise<{response: string, latency: number}>;
  isBusy(): boolean;
  getLatency(): number;
}

interface ModelEntry {
  id: string;
}

interface Models {
  [provider: string]: ModelEntry[];
}

const models: Models = JSON.parse(readFileSync('models.json', 'utf8'));

const providerClassMap: { [provider: string]: { [modelType: string]: new (...args: any[]) => IAIProvider } } = {
  google: {
    default: GeminiAI,
    // Add other Google model types here
  },
  openai: {
    default: OpenAI,
  },
  // Add other providers here
};
export async function updateModelLatency(modelId: string, provider: string, latency: number): Promise<void> {
  const modelsFilePath = path.join(__dirname, 'models.json');
  try {
    const modelsData = await fs.readFile(modelsFilePath, 'utf8');
    const models = JSON.parse(modelsData);
    if (!models[provider]) {
      models[provider] = [];
    }
    const modelIndex = models[provider].findIndex((m: any) => m.id === modelId);
    if (modelIndex !== -1) {
      if (!models[provider][modelIndex].latency) {
        models[provider][modelIndex].latency = [];
      }
      models[provider][modelIndex].latency.push(latency);
    } else {
      models[provider].push({ id: modelId, latency: [latency] });
    }
    await fs.writeFile(modelsFilePath, JSON.stringify(models, null, 2), 'utf8');
  } catch (error) {
    console.error('Error updating models.json with latency:', error);
  }
}
function getModelClass(model: string, modelType: string = 'default'): new (...args: any[]) => IAIProvider {
  for (const [provider, modelEntries] of Object.entries(models)) {
    const found = modelEntries.some(entry => entry.id === model);
    if (found) {
      const ModelClasses = providerClassMap[provider];
      if (ModelClasses) {
        const ModelClass = ModelClasses[modelType];
        if (ModelClass) return ModelClass;
        throw new Error(`Unsupported model type: ${modelType} for provider: ${provider}`);
      }
      throw new Error(`Unsupported model group: ${provider}`);
    }
  }
  throw new Error(`Unsupported model: ${model}`);
}

export class MessageHandler {
  private static aiModelInstances: IAIProvider[] = []; 

  static initializeModelInstances(modelClass: new () => IAIProvider, count: number = 3) {
    this.aiModelInstances = Array.from({ length: count }, () => new modelClass());
  }
  private static selectAIModelInstance(): IAIProvider {
    const availableInstances = this.aiModelInstances.filter(instance => !instance.isBusy());
    
    const selectedInstance = availableInstances.reduce((prev, curr) => 
      (prev.getLatency() < curr.getLatency() ? prev : curr), availableInstances[0]);

    return selectedInstance;
  }

  static async handleMessages(
    messages: { role: string; content: string }[],
    modelId: string
  ): Promise<any[]> {
    const ModelClass = getModelClass(modelId);
    const aiProvider = new ModelClass();

    const responses = [];
    for (const message of messages) {
      if (!aiProvider.isBusy()) {
        const response = await aiProvider.sendMessage(message.content);
        responses.push(response);
      } else {
        // make handler when AI provider is busy
        responses.push({ error: 'AI provider is busy' });
      }
    }

    return responses;
  }

}