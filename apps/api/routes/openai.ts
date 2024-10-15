import axios from 'axios';
import { IAIProvider, IMessage } from '../providers/interfaces';

export class OpenAI implements IAIProvider {
  private busy = false;
  private lastLatency = 0;
  private apiKey: string;
  private endpointUrl: string;

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
  }

  isBusy(): boolean {
    return this.busy;
  }

  getLatency(): number {
    return this.lastLatency;
  }

  async sendMessage(message: IMessage): Promise<{ response: string; latency: number }> {
    this.busy = true;
    const startTime = Date.now();
    const url = this.endpointUrl;

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
      const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
      throw new Error(`Error sending message: ${errorMessage}`);
    }
  }
}