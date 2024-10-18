// handler.ts

import { readFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { IAIProvider, IMessage, ResponseEntry, ModelData, Provider } from './interfaces';
import { GeminiAI } from './gemini';
import { OpenAI } from './openai';
import { computeEMA, computeProviderStatsWithEMA, updateProviderData, computeProviderScore } from 'modules/compute';

dotenv.config();

interface Model {
  id: string;
}

interface Models {
  [provider: string]: Model[];
}

const modelsFilePath = path.resolve('devmodels.json');
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
    args: [process.env.GEMINI_API_KEY || ''],
  },
  // Add other providers here
};

function getProviderConfig(modelId: string): { provider: string; config: ProviderConfig } {
  for (const [provider, modelEntries] of Object.entries(models)) {
    const found = modelEntries.some((entry) => entry.id === modelId);
    if (found) {
      const providerConfig = providerConfigs[provider];
      if (providerConfig) {
        return { provider, config: providerConfig };
      }
      throw new Error(`Provider configuration not found for provider: ${provider}`);
    }
  }
  throw new Error(`Unsupported model: ${modelId}`);
}

export class MessageHandler {
  private providerDataMap: { [providerId: string]: Provider } = {};

  private alpha: number = 0.3;

  constructor() {
    for (const providerId in providerConfigs) {
      this.providerDataMap[providerId] = {
        id: providerId,
        apiKey: null,
        provider_url: '',
        models: [],
        avg_response_time: undefined,
        avg_provider_latency: undefined,
        errors: 0,
        provider_score: undefined,
      };
    }
  }

  private updateProviderData(
    providerId: string,
    modelId: string,
    responseEntry: ResponseEntry | null,
    isError: boolean,
    tokenGenerationSpeed: number
  ): void {
    const providerData = this.providerDataMap[providerId];
    updateProviderData(providerData, modelId, responseEntry, isError, tokenGenerationSpeed);
  }

  private computeProviderStatsWithEMA(providerData: Provider): void {
    computeProviderStatsWithEMA(providerData, this.alpha);
  }

  private computeProviderScore(providerData: Provider): void {
    const latencyWeight = 0.7; 
    const errorWeight = 0.3;
    computeProviderScore(providerData, latencyWeight, errorWeight);
  }

  private selectBestProvider(modelId: string): { providerId: string; providerConfig: ProviderConfig } {
    let bestProviderId: string | null = null;
    let highestScore = -Infinity;

    for (const [providerId, providerData] of Object.entries(this.providerDataMap)) {
      const providerModelIds = models[providerId]?.map((entry) => entry.id);
      if (providerModelIds?.includes(modelId)) {
        this.computeProviderStatsWithEMA(providerData);
        this.computeProviderScore(providerData);

        if (providerData.provider_score != null && providerData.provider_score > highestScore) {
          highestScore = providerData.provider_score;
          bestProviderId = providerId;
        }
      }
    }

    if (bestProviderId) {
      const providerConfig = providerConfigs[bestProviderId];
      return { providerId: bestProviderId, providerConfig };
    } else {
      throw new Error(`No provider found for model ${modelId}`);
    }
  }

  async handleMessages(messages: IMessage[], modelId: string): Promise<any> {

    const { providerId, providerConfig } = this.selectBestProvider(modelId);
    const providerInstance = new providerConfig.class(...(providerConfig.args || []));

    const tokenGenerationSpeed = this.getTokenGenerationSpeed(modelId);

    try {
      const result = await providerInstance.sendMessage({
        content: messages[messages.length - 1].content,
        model: { id: modelId },
      });

      const inputContent = messages[messages.length - 1].content;
      const inputTokens = Math.ceil(inputContent.length / 4);

      const outputContent = result.response;
      const outputTokens = Math.ceil(outputContent.length / 4);

      const totalTokens = inputTokens + outputTokens;

      const responseEntry: ResponseEntry = {
        timestamp: new Date(),
        response_time: result.latency,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tokens_generated: totalTokens,
        provider_latency: 0, 
        latency_per_token: 0, 
      };

      const expectedTokenTime = (totalTokens / tokenGenerationSpeed) * 1000;

      responseEntry.provider_latency = Math.max(
        result.latency - expectedTokenTime,
        0
      );

      responseEntry.latency_per_token = result.latency / totalTokens;

      this.updateProviderData(
        providerId,
        modelId,
        responseEntry,
        false, 
        tokenGenerationSpeed
      );

      return {
        response: result.response,
        latency: result.latency,
        tokenUsage: totalTokens, 
      };
    } catch (error: any) {
      this.updateProviderData(
        providerId,
        modelId,
        null,
        true,
        tokenGenerationSpeed
      );

      throw new Error(`Error handling message: ${error.message}`);
    }
  }

  private getTokenGenerationSpeed(modelId: string): number {
    const tokenGenerationSpeeds: { [modelId: string]: number } = {
      'gpt-3.5-turbo': 50,
      'gemini-pro': 60,
    };

    return tokenGenerationSpeeds[modelId] || 50; 
  }
}