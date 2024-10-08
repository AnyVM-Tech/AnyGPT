import { readFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { IAIProvider, IMessage } from './interfaces';
import { GeminiAI } from 'providers/gemini';
import { OpenAI } from 'providers/openai';
dotenv.config();

interface ModelEntry {
  id: string;
}

interface Models {
  [provider: string]: ModelEntry[];
}

const modelsFilePath = path.resolve('models.json');
const models: Models = JSON.parse(readFileSync(modelsFilePath, 'utf8'));

interface ProviderConfig {
  class: new (...args: any[]) => IAIProvider;
  args?: any[];
}

const providerConfigs: { [provider: string]: ProviderConfig } = {
  openai: {
    class: OpenAI,
    args: [process.env.OPENAI_API_KEY || ''],
  },
  google: {
    class: GeminiAI,
    args: [],
  },
  // Add other providers here
};

function getProviderConfig(modelId: string): ProviderConfig {
  for (const [provider, modelEntries] of Object.entries(models)) {
    const found = modelEntries.some((entry) => entry.id === modelId);
    if (found) {
      const providerConfig = providerConfigs[provider];
      if (providerConfig) {
        return providerConfig;
      }
      throw new Error(`Provider configuration not found for provider: ${provider}`);
    }
  }
  throw new Error(`Unsupported model: ${modelId}`);
}

export class MessageHandler {
  private aiModelInstances: IAIProvider[] = [];

  constructor(private modelId: string, instanceCount: number = 3) {
    const providerConfig = getProviderConfig(modelId);
    this.initializeModelInstances(providerConfig, instanceCount);
  }

  private initializeModelInstances(providerConfig: ProviderConfig, instanceCount: number) {
    for (let i = 0; i < instanceCount; i++) {
      const instance = new providerConfig.class(...(providerConfig.args || []));
      this.aiModelInstances.push(instance);
    }
  }

  static async handleMessages(messages: any[], model: string): Promise<any> {
//logic needed
    return { messages, model };
  }
}