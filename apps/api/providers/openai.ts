import axios from 'axios';
import { IAIProvider, IMessage } from '../providers/interfaces';
import {
  Provider,
  updateProviderData,
  computeProviderStatsWithEMA,
  computeProviderScore,
  ResponseEntry,
} from '../modules/compute.ts'; 

export class OpenAI implements IAIProvider {
  private busy = false;
  private lastLatency = 0;
  private apiKey: string;
  private endpointUrl: string;
  private providerId: string = 'openai';

  private providerData: Provider;

  // EMA smoothing factor
  private alpha: number = 0.3; 

  /**
   * Constructor for the OpenAI provider.
   * @param apiKey - The API key to use. If it starts with 'sk-', it's considered an OpenAI key.
   * @param endpointUrl - Optional custom endpoint URL. If provided, it replaces the default endpoint.
   */
  constructor(apiKey: string, endpointUrl?: string) {
    if (!apiKey && !endpointUrl) {
      throw new Error('Either an OpenAI API key or an endpoint URL must be provided');
    }

    if (apiKey && apiKey.startsWith('sk-')) {
      this.apiKey = apiKey;
      this.endpointUrl = endpointUrl || 'https://api.openai.com/v1/chat/completions';
    } else {
      this.apiKey = apiKey || '';
      if (endpointUrl) {
        this.endpointUrl = endpointUrl;
      } else {
        throw new Error('Endpoint URL must be provided if API key is not an OpenAI API key');
      }
    }

    this.providerData = {
      id: this.providerId,
      models: {},
      avg_response_time: null,
      avg_provider_latency: null,
      errors: 0,
      provider_score: null,
      apiKey: this.apiKey,
      provider_url: this.endpointUrl,
    };
  }

  isBusy(): boolean {
    return this.busy;
  }

  getLatency(): number {
    return this.lastLatency;
  }

  /**
   * Sends a message to the OpenAI API and updates the provider statistics.
   * @param message - The message to send, including the model details.
   * @returns A promise containing the API response content and latency.
   */
  async sendMessage(message: IMessage): Promise<{ response: string; latency: number }> {
    this.busy = true;
    const startTime = Date.now();
    const url = this.endpointUrl;
console.log(this.apiKey)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const data = {
      model: message.model.id,
      messages: [{ role: 'user', content: message.content }],
    };

    try {
      const response = await axios.post(url, data, { headers });
      const endTime = Date.now();
      this.lastLatency = endTime - startTime;
      this.busy = false;

      const inputTokens = Math.ceil(message.content.length / 4);
      const outputContent = response.data.choices[0].message.content;
      const outputTokens = Math.ceil(outputContent.length / 4);
      const totalTokens = inputTokens + outputTokens;


      const responseEntry: ResponseEntry = {
        timestamp: new Date(),
        response_time: this.lastLatency,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tokens_generated: totalTokens,
        provider_latency: 0,
      };

      updateProviderData(
        this.providerData,
        message.model.id,
        responseEntry,
        false
      );

      const modelData = this.providerData.models[message.model.id];

      // Ensure that token_generation_speed is defined; otherwise, assign a default value.
      if (!modelData.token_generation_speed) {
        modelData.token_generation_speed = 50; // default tokens per second
      }

      const expectedTokenTime =
        (responseEntry.tokens_generated / modelData.token_generation_speed) * 1000;

      responseEntry.provider_latency = Math.max(
        responseEntry.response_time - expectedTokenTime,
        0
      );

      computeProviderStatsWithEMA(this.providerData, this.alpha);

      computeProviderScore(this.providerData, 0.7, 0.3); 
      Object.keys(this.providerData.models).forEach(modelId => {
        if ('provider_score' in this.providerData.models[modelId]) {
          delete (this.providerData.models[modelId] as any).provider_score;
        }
      });
      if (response.data.choices && response.data.choices.length > 0) {
        return {
          response: response.data.choices[0].message.content,
          latency: this.lastLatency,
        };
      } else {
        throw new Error('Unexpected response structure from the API');
      }
    } catch (error: any) {
      this.busy = false;

      updateProviderData(
        this.providerData,
        message.model.id,
        null,
        true
      );

      const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
      throw new Error(`Error sending message: ${errorMessage}`);
    }
  }

  getProviderData(): Provider {
    return this.providerData;
  }
}