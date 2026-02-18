import axios from 'axios';
import { IAIProvider, IMessage, ProviderResponse, ProviderStreamChunk, ProviderStreamPassthrough } from './interfaces.js';

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

  private normalizeMimeType(raw: any, kind: 'image' | 'audio', fallbackSubtype: string): string {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return `${kind}/${fallbackSubtype}`;
    if (value.includes('/')) return value;
    return `${kind}/${value}`;
  }

  private toDataUrl(data: string, mimeType: string): string {
    return `data:${mimeType};base64,${data}`;
  }

  private extractImageFromPart(part: any): string | null {
    if (!part || typeof part !== 'object') return null;
    const directUrl = part?.image_url?.url ?? part?.image_url ?? part?.url ?? part?.image?.url;
    if (typeof directUrl === 'string' && directUrl.length > 0) return directUrl;

    const imageObj = part?.image ?? part?.output_image ?? null;
    const b64 =
      part?.b64_json
      || part?.image_base64
      || imageObj?.b64_json
      || imageObj?.data
      || imageObj?.base64;
    if (typeof b64 === 'string' && b64.length > 0) {
      const mimeRaw = part?.mime_type || part?.mimeType || part?.format || imageObj?.mime_type || imageObj?.mimeType || imageObj?.format;
      const mime = this.normalizeMimeType(mimeRaw, 'image', 'png');
      return this.toDataUrl(b64, mime);
    }

    const fallbackUrl = imageObj?.image_url?.url ?? imageObj?.url;
    if (typeof fallbackUrl === 'string' && fallbackUrl.length > 0) return fallbackUrl;

    return null;
  }

  private extractAudioFromPart(part: any): string | null {
    if (!part || typeof part !== 'object') return null;
    const audioObj = part?.audio ?? part?.output_audio ?? part?.audio_output ?? null;
    const data =
      audioObj?.data
      || audioObj?.b64_json
      || audioObj?.base64
      || part?.audio_data
      || part?.audio_base64;
    if (typeof data === 'string' && data.length > 0) {
      const mimeRaw = audioObj?.mime_type || audioObj?.mimeType || audioObj?.format || part?.mime_type || part?.mimeType || part?.format;
      const mime = this.normalizeMimeType(mimeRaw, 'audio', 'wav');
      return this.toDataUrl(data, mime);
    }

    const directUrl = audioObj?.url ?? audioObj?.audio_url?.url ?? part?.audio_url;
    if (typeof directUrl === 'string' && directUrl.length > 0) return directUrl;

    return null;
  }

  private extractMediaFromMessage(message: any): string | null {
    if (!message || typeof message !== 'object') return null;

    const audio = this.extractAudioFromPart(message?.audio ?? message);
    if (audio) return audio;

    const content = message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const image = this.extractImageFromPart(part);
        if (image) return image;
        const audioPart = this.extractAudioFromPart(part);
        if (audioPart) return audioPart;
      }
    } else if (content && typeof content === 'object') {
      const image = this.extractImageFromPart(content);
      if (image) return image;
      const audioPart = this.extractAudioFromPart(content);
      if (audioPart) return audioPart;
    }

    return null;
  }

  private normalizeContent(val: any): string {
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
      for (const part of val) {
        if (part?.type === 'image_url' && part.image_url?.url) return part.image_url.url;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'output_text' && typeof part.output_text === 'string') return part.output_text;
      }
    }
    if (val && typeof val === 'object') {
      if (typeof val.text === 'string') return val.text;
      if (typeof val.transcript === 'string') return val.transcript;
      if (typeof val.output_text === 'string') return val.output_text;
      return JSON.stringify(val);
    }
    return val == null ? '' : String(val);
  }

  private extractErrorMessage(error: any, fallback: string): string {
    const status = error?.response?.status;
    const data = error?.response?.data;
    let message = '';

    if (data) {
      if (typeof data === 'string') {
        message = data;
      } else if (typeof data?.error === 'string') {
        message = data.error;
      } else if (data?.error && typeof data.error === 'object') {
        message = data.error?.message || data.error?.error || JSON.stringify(data.error);
      } else if (typeof data?.message === 'string') {
        message = data.message;
      }
    }

    if (!message) message = error?.message || fallback;

    if (data && typeof data === 'object' && message.toLowerCase().includes('provider returned error')) {
      const metadata = data?.error?.metadata;
      if (metadata && typeof metadata === 'object') {
        const provider = metadata?.provider || metadata?.provider_name || metadata?.provider_id;
        const raw = metadata?.raw || metadata?.response || metadata?.body || metadata?.provider_response;
        const rawText = raw
          ? (typeof raw === 'string' ? raw : JSON.stringify(raw))
          : '';
        const trimmed = rawText && rawText.length > 500 ? `${rawText.slice(0, 500)}...` : rawText;
        const parts: string[] = [];
        if (provider) parts.push(`provider=${provider}`);
        if (trimmed) parts.push(`detail=${trimmed}`);
        if (parts.length > 0) {
          message = `${message} (${parts.join(', ')})`;
        }
      }
    }

    if (status) message = `${message} (status ${status})`;
    return message;
  }

  private buildRequestData(message: IMessage, stream: boolean = false) {
    const normalizedContent = (() => {
      if (!Array.isArray(message.content)) return message.content;
      const textParts: string[] = [];
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text);
          continue;
        }
        if (part?.type === 'input_text' && typeof part.text === 'string') {
          textParts.push(part.text);
          continue;
        }
        return message.content;
      }
      return textParts.length > 0 ? textParts.join('\n') : message.content;
    })();

    const data: any = {
      model: message.model.id,
      messages: [{ role: message.role || 'user', content: normalizedContent }],
      stream,
    };
    if (message.modalities) data.modalities = message.modalities;
    if (message.audio) data.audio = message.audio;
    return data;
  }

  async sendMessage(message: IMessage): Promise<ProviderResponse> {
    const start = Date.now();
    const data = this.buildRequestData(message);

    try {
      const res = await axios.post(this.endpointUrl, data, { headers: this.buildHeaders() });
      const latency = Date.now() - start;
      const messagePayload = res.data?.choices?.[0]?.message;
      const media = this.extractMediaFromMessage(messagePayload);
      const raw = messagePayload?.content;

      const text = media || this.normalizeContent(raw);
      return {
        response: text,
        latency,
        usage: {
          prompt_tokens: typeof res.data?.usage?.prompt_tokens === 'number' ? res.data.usage.prompt_tokens : undefined,
          completion_tokens: typeof res.data?.usage?.completion_tokens === 'number' ? res.data.usage.completion_tokens : undefined,
          total_tokens: typeof res.data?.usage?.total_tokens === 'number' ? res.data.usage.total_tokens : undefined,
        }
      };
    } catch (error: any) {
      const latency = Date.now() - start;
      const msg = this.extractErrorMessage(error, 'Unknown OpenRouter error');
      throw new Error(`OpenRouter API call failed: ${msg} (latency ${latency}ms)`);
    }
  }

  async createPassthroughStream(message: IMessage): Promise<ProviderStreamPassthrough | null> {
    const data = this.buildRequestData(message, true);
    const res = await axios.post(this.endpointUrl, data, { headers: this.buildHeaders(), responseType: 'stream' });
    return {
      upstream: res.data,
      mode: 'openai-chat-sse',
    };
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const start = Date.now();
    const data = this.buildRequestData(message, true);

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
            const delta = parsed?.choices?.[0]?.delta;
            const message = parsed?.choices?.[0]?.message;
            const media = this.extractMediaFromMessage(delta) || this.extractMediaFromMessage(message);
            const chunk = media
              || this.normalizeContent(delta?.content ?? delta?.text ?? delta?.transcript ?? delta?.audio?.transcript);
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
      const msg = this.extractErrorMessage(error, 'Unknown OpenRouter stream error');
      throw new Error(`OpenRouter API stream call failed: ${msg} (latency ${latency}ms)`);
    }
  }
}
