import axios from 'axios';
import { IAIProvider, IMessage } from './interfaces.js';

interface OpenRouterOptions {
  referer?: string;
  title?: string;
}

/**
 * OpenRouter provider: OpenAI-compatible but requires Referer and X-Title headers.
 */
export class OpenRouterAI implements IAIProvider {
  private apiKey: string;
  private endpointUrl: string;
  private referer?: string;
  private title?: string;

  constructor(apiKey: string, endpointUrl?: string, options: OpenRouterOptions = {}) {
    if (!apiKey) throw new Error('OpenRouter API key is required');
    this.apiKey = apiKey;
    this.endpointUrl = endpointUrl || 'https://openrouter.ai/api/v1/chat/completions';
    this.referer = options.referer || process.env.OPENROUTER_REFERRER;
    this.title = options.title || process.env.OPENROUTER_TITLE;
  }

  private buildHeaders() {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.referer) headers['HTTP-Referer'] = this.referer;
    if (this.title) headers['X-Title'] = this.title;
    return headers;
  }

  async sendMessage(message: IMessage): Promise<{ response: string; latency: number }> {
    const start = Date.now();
    const data = {
      model: message.model.id,
      messages: [{ role: 'user', content: message.content }],
    };

    try {
      const res = await axios.post(this.endpointUrl, data, { headers: this.buildHeaders() });
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
      const msg = error?.response?.data?.error?.message || error.message || 'Unknown OpenRouter error';
      throw new Error(`OpenRouter API call failed: ${msg} (latency ${latency}ms)`);
    }
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<{ chunk: string; latency: number; response: string; anystream: any }, void, unknown> {
    const start = Date.now();
    const data = {
      model: message.model.id,
      messages: [{ role: 'user', content: message.content }],
      stream: true,
    };

    try {
      const res = await axios.post(this.endpointUrl, data, { headers: this.buildHeaders(), responseType: 'stream' });
      let full = '';
      for await (const value of res.data) {
        const lines = value.toString('utf8').split('\n').filter((line: string) => line.trim().startsWith('data: '));
        for (const line of lines) {
          const payload = line.replace(/^data: /, '');
          if (payload === '[DONE]') {
            const latency = Date.now() - start;
            yield { chunk: '', latency, response: full, anystream: res.data };
            return;
          }
          try {
            const parsed = JSON.parse(payload);
            const chunk = parsed.choices?.[0]?.delta?.content || '';
            full += chunk;
            const latency = Date.now() - start;
            yield { chunk, latency, response: full, anystream: res.data };
          } catch (e) {
            // Skip malformed chunk
          }
        }
      }
    } catch (error: any) {
      const latency = Date.now() - start;
      const msg = error?.response?.data?.error?.message || error.message || 'Unknown OpenRouter stream error';
      throw new Error(`OpenRouter API stream call failed: ${msg} (latency ${latency}ms)`);
    }
  }
}
