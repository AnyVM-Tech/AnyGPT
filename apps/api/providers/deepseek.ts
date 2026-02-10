import axios from 'axios';
import { IAIProvider, IMessage } from './interfaces.js';

/**
 * DeepSeek provider (OpenAI-compatible chat completions).
 */
export class DeepseekAI implements IAIProvider {
  private apiKey: string;
  private endpointUrl: string;

  constructor(apiKey: string, endpointUrl?: string) {
    if (!apiKey) throw new Error('DeepSeek API key is required');
    this.apiKey = apiKey;
    this.endpointUrl = endpointUrl || 'https://api.deepseek.com/chat/completions';
  }

  private buildHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    } as Record<string, string>;
  }

  async sendMessage(message: IMessage): Promise<{ response: string; latency: number }> {
    const start = Date.now();
    const payload = {
      model: message.model.id,
      messages: [{ role: 'user', content: message.content }],
    };

    try {
      const res = await axios.post(this.endpointUrl, payload, { headers: this.buildHeaders() });
      const latency = Date.now() - start;
      const raw = res.data?.choices?.[0]?.message?.content;

      const normalize = (val: any): string => {
        if (typeof val === 'string') return val;
        if (Array.isArray(val)) {
          for (const part of val) {
            if (part?.type === 'image_url' && part.image_url?.url) return part.image_url.url;
            if (part?.type === 'text' && typeof part.text === 'string') return part.text;
          }
        }
        return typeof val === 'object' ? JSON.stringify(val) : String(val);
      };

      const text = normalize(raw);
      return { response: text, latency };
    } catch (error: any) {
      const latency = Date.now() - start;
      const msg = error?.response?.data?.error?.message || error.message || 'Unknown DeepSeek error';
      throw new Error(`DeepSeek API call failed: ${msg} (latency ${latency}ms)`);
    }
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<{ chunk: string; latency: number; response: string; anystream: any }, void, unknown> {
    const start = Date.now();
    const payload = {
      model: message.model.id,
      messages: [{ role: 'user', content: message.content }],
      stream: true,
    };

    try {
      const res = await axios.post(this.endpointUrl, payload, { headers: this.buildHeaders(), responseType: 'stream' });
      let full = '';
      for await (const value of res.data) {
        const lines = value.toString('utf8').split('\n').filter((line: string) => line.trim().startsWith('data: '));
        for (const line of lines) {
          const payloadLine = line.replace(/^data: /, '');
          if (payloadLine === '[DONE]') {
            const latency = Date.now() - start;
            yield { chunk: '', latency, response: full, anystream: res.data };
            return;
          }
          try {
            const parsed = JSON.parse(payloadLine);
            const chunk = parsed.choices?.[0]?.delta?.content || '';
            full += chunk;
            const latency = Date.now() - start;
            yield { chunk, latency, response: full, anystream: res.data };
          } catch {
            // skip malformed chunk
          }
        }
      }
    } catch (error: any) {
      const latency = Date.now() - start;
      const msg = error?.response?.data?.error?.message || error.message || 'Unknown DeepSeek stream error';
      throw new Error(`DeepSeek API stream call failed: ${msg} (latency ${latency}ms)`);
    }
  }
}
