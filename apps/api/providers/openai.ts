import axios from 'axios';
import { IAIProvider, IMessage } from './interfaces';

export class OpenAI implements IAIProvider {
  private busy = false;
  private lastLatency = 0;
  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }
    this.apiKey = apiKey;
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
    const url = 'https://api.openai.com/v1/chat/completions';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

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
        throw new Error('Unexpected response structure from OpenAI API');
      }
    } catch (error: any) {
      this.busy = false;
      throw new Error(`Error sending message to OpenAI: ${error.message}`);
    }
  }
}