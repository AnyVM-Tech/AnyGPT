import dotenv from 'dotenv';
import { IAIProvider, IMessage, ResponseEntry, Provider, Model, DevModels } from './interfaces';
import { GeminiAI } from './gemini';
import { OpenAI } from './openai';
import { computeEMA, computeProviderStatsWithEMA, updateProviderData, computeProviderScore } from '../modules/compute';
import redis from '../modules/db';
import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import { isDevModels, isModelsData } from '../modules/typeguards';

dotenv.config();

const ajv = new Ajv();

const providersSchema = JSON.parse(fs.readFileSync(path.resolve('../api/providers.schema.json'), 'utf8'));
const modelsSchema = JSON.parse(fs.readFileSync(path.resolve('../api/models.schema.json'), 'utf8'));

const validateProviders = ajv.compile(providersSchema);
const validateModels = ajv.compile(modelsSchema);

async function getModelsData(): Promise<{ devModels: DevModels; modelData: Model[] }> {
  if (redis) {
    try {
      const [devModelsData, modelsData] = await Promise.all([
        redis.get('providers'),
        redis.get('models'),
      ]);

      if (devModelsData && modelsData) {
        const parsedDevModels = JSON.parse(devModelsData);
        const parsedModels = JSON.parse(modelsData);

        if (!validateProviders(parsedDevModels)) {
          console.error('providers.json validation errors:', validateProviders.errors);
          throw new Error('Invalid providers.json format');
        }

        if (!validateModels(parsedModels)) {
          console.error('models.json validation errors:', validateModels.errors);
          throw new Error('Invalid models.json format');
        }

        if (!isDevModels(parsedDevModels)) {
          console.error('providers.json does not match DevModels interface');
          throw new Error('providers.json does not match DevModels interface');
        }

        if (!isModelsData(parsedModels)) {
          console.error('models.json does not match expected structure');
          throw new Error('models.json does not match expected structure');
        }

        return {
          devModels: parsedDevModels,
          modelData: parsedModels.data,
        };
      }
    } catch (err) {
      console.error('Error reading from Redis:', err);
    }
  }

  // Fallback 
  const devModelsPath = path.resolve('../api/providers.json');
  const modelsPath = path.resolve('../api/models.json');

  try {
    const rawDevModels = fs.readFileSync(devModelsPath, 'utf8');
    const rawModels = fs.readFileSync(modelsPath, 'utf8');

    const parsedDevModels = JSON.parse(rawDevModels);
    const parsedModels = JSON.parse(rawModels);

    if (!validateProviders(parsedDevModels)) {
      console.error('providers.json validation errors:', validateProviders.errors);
      throw new Error('Invalid providers.json format');
    }

    if (!validateModels(parsedModels)) {
      console.error('models.json validation errors:', validateModels.errors);
      throw new Error('Invalid models.json format');
    }

    if (!isDevModels(parsedDevModels)) {
      console.error('providers.json does not match DevModels interface');
      throw new Error('providers.json does not match DevModels interface');
    }

    if (!isModelsData(parsedModels)) {
      console.error('models.json does not match expected structure');
      throw new Error('models.json does not match expected structure');
    }

    return {
      devModels: parsedDevModels,
      modelData: parsedModels.data,
    };
  } catch (err) {
    console.error('Error reading JSON files:', err);
    throw err;
  }
}

async function initializeData(): Promise<DevModels> {
  const { devModels, modelData } = await getModelsData();
  const modelThroughputMap = new Map<string, number>();

  modelData.forEach((model: Model) => {
    if (model.id && model.throughput && !isNaN(model.throughput)) {
      modelThroughputMap.set(model.id, model.throughput);
    }
  });
  console.log(JSON.stringify(devModels, null, 2));

  return devModels;
}

const devModels: DevModels = await initializeData();

interface ProviderConfig {
  class: new (...args: any[]) => IAIProvider;
  args?: any[];
}

// Dynamically initialize providerConfigs with apiKey and provider_url from devModels
const providerConfigs: { [provider: string]: ProviderConfig } = {};
for (const providerEntry of devModels) {
  const providerId = providerEntry.id;
  const providerUrl = providerEntry.provider_url || '';
  const apiKey = providerEntry.apiKey || '';
// class's used for message handling, openai json schema or google json schema
  if (providerId.startsWith('openai')) { // tied to providers.json ID name
    providerConfigs[providerId] = {
      class: OpenAI,
      args: [apiKey, providerUrl],
    };
  } else if (providerId === 'google') {
    providerConfigs[providerId] = {
      class: GeminiAI,
      args: [apiKey || process.env.GEMINI_API_KEY || ''],
    };
  }
}

function getProviderConfig(modelId: string): { provider: string; config: ProviderConfig } {
  for (const providerEntry of devModels) {
    const providerId = providerEntry.id;
    if (providerEntry.models && Object.keys(providerEntry.models).includes(modelId)) {
      const config = providerConfigs[providerId];
      if (config) return { provider: providerId, config };
      throw new Error(`Provider configuration not found for provider: ${providerId}`);
    }
  }
  throw new Error(`Unsupported model: ${modelId}`);
}

export class MessageHandler {
  private providerDataMap: { [providerId: string]: Provider } = {};
  private alpha: number = 0.3;
  private modelThroughputMap: Map<string, number> = new Map();
  private readonly DEFAULT_GENERATION_SPEED = 500;

  constructor() {
    // provider data
    for (const providerEntry of devModels) {
      const providerId = providerEntry.id;
      this.providerDataMap[providerId] = {
        id: providerId,
        apiKey: providerEntry.apiKey,
        provider_url: providerEntry.provider_url,
        models: providerEntry.models,
        avg_response_time: providerEntry.avg_response_time,
        avg_provider_latency: providerEntry.avg_provider_latency,
        errors: providerEntry.errors,
        provider_score: providerEntry.provider_score,
      };
    }

    this.initializeThroughputMap().then(() => {
      console.log('Throughput map initialized.');
    }).catch(error => {
      console.error('Error initializing throughput map:', error);
    });
  }

  private async initializeThroughputMap(): Promise<void> {
    try {
      const { modelData } = await getModelsData();
      modelData.forEach((model: Model) => {
        if (model.id && model.throughput && !isNaN(model.throughput)) {
          this.modelThroughputMap.set(model.id, model.throughput);
        }
      });
    } catch (error) {
      console.error('Error initializing throughput map:', error);
    }
  }

  private getTokenGenerationSpeed(modelId: string): number {
    return this.modelThroughputMap.get(modelId) || this.DEFAULT_GENERATION_SPEED;
  }

  private updateProviderData(
    providerId: string,
    modelId: string,
    responseEntry: ResponseEntry | null,
    isError: boolean
  ): void {
    const providerData = this.providerDataMap[providerId];
    updateProviderData(providerData, modelId, responseEntry, isError, this.modelThroughputMap);
  }
  private async saveDevModels(): Promise<void> {
    if (redis) {
      try {
        await redis.set('devModels', JSON.stringify(devModels));
      } catch (err) {
        console.error('Error writing to Redis:', err);
      }
    } else {
      const devModelsPath = path.resolve('providers.json');
      fs.writeFileSync(devModelsPath, JSON.stringify(devModels, null, 2), 'utf8');
    }
  }
  private async selectBestProvider(
    modelId: string
  ): Promise<{ providerId: string; providerConfig: ProviderConfig }> {
    let bestProviderId: string | null = null;
    let highestScore = -Infinity;
    const eligibleProviders: string[] = [];
  
    console.log(`Selecting best provider for model: ${modelId}`);
  
    // Debug: List all available models 
    console.log('Available models under each provider:');
for (const providerEntry of devModels) {
  const providerId = providerEntry.id;
  const providerData = this.providerDataMap[providerId];
  if (!providerData) {
    console.warn(`No entries found for provider: ${providerId}`);
    continue;
  }

  const providerModelIds = Object.keys(providerEntry.models)
  console.log(`Provider: ${providerId}, Models: ${providerModelIds.join(', ')}`);

  if (providerModelIds.includes(modelId)) {
    eligibleProviders.push(providerId);
        computeProviderStatsWithEMA(providerData, this.alpha);
        computeProviderScore(providerData, 0.7, 0.3);
  console.log(providerData.provider_score, "previousEMA");
        const previousEMA = providerData.provider_score || 0;
        const newEMA = computeEMA(
          previousEMA,
          providerData.provider_score || 0,
          this.alpha
        );
        providerData.provider_score = newEMA;
  
        if (providerEntry.models[modelId]) {
          providerEntry.models[modelId].provider_score = newEMA;
        }
  
        if (newEMA > highestScore) {
          highestScore = newEMA;
          bestProviderId = providerId;
        }
      }
    }
  
    console.log(`Eligible Providers: ${eligibleProviders.join(', ')}`);
    console.log(`Best Provider Selected: ${bestProviderId} with Score: ${highestScore}`);
  
    if (!bestProviderId || highestScore === -Infinity) {
      if (eligibleProviders.length === 0) {
        throw new Error(`No provider found for model ${modelId}`);
      }
      const randomIndex = Math.floor(Math.random() * eligibleProviders.length);
      bestProviderId = eligibleProviders[randomIndex];
      highestScore = 0;
  
      this.providerDataMap[bestProviderId].provider_score = 0;
      const providerEntry = devModels.find(p => p.id === bestProviderId);
      if (providerEntry) {
        providerEntry.models[modelId].provider_score = 0;
      }

      console.log(`Randomly selected provider: ${bestProviderId} with initial score of 0`);
    }
  
    await this.saveDevModels();
  
    return {
      providerId: bestProviderId,
      providerConfig: providerConfigs[bestProviderId],
    };
  }  async handleMessages(messages: IMessage[], modelId: string): Promise<any> {
    const { providerId, providerConfig } = await this.selectBestProvider(modelId);
    

    if (!providerConfig) {
      throw new Error(`Provider configuration not found for ${providerId}. Check that the provider's name is tied to its class's function.`);
    }
    
    const providerInstance = new providerConfig.class(...(providerConfig.args || []));
    const tokenGenerationSpeed = this.getTokenGenerationSpeed(modelId);

    try {
      const result = await providerInstance.sendMessage({
        content: messages[messages.length - 1].content,
        model: { id: modelId },
      });

      const inputContent = messages[messages.length - 1].content;
      const inputTokens = Math.ceil(inputContent.length / 4);
      const outputTokens = Math.ceil(result.response.length / 4);
      const totalTokens = inputTokens + outputTokens;

      const responseEntry: ResponseEntry = {
        timestamp: new Date(),
        response_time: result.latency,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tokens_generated: totalTokens,
        provider_latency: Math.max(
          result.latency - (totalTokens / tokenGenerationSpeed) * 1000,
          0
        )
      };

      this.updateProviderData(providerId, modelId, responseEntry, false);

      return {
        response: result.response,
        latency: result.latency,
        tokenUsage: totalTokens,
      };
    } catch (error: any) {
      console.error(`Error in ${providerConfig.class.name} sendMessage:`, error);
      this.updateProviderData(providerId, modelId, null, true);
      throw new Error(`Error handling message: ${error.message}`);
    }
  }
}