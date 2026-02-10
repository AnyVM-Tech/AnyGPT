import dotenv from 'dotenv';
import { IAIProvider, IMessage } from './interfaces.js';

dotenv.config();

interface ImagenRequest {
  prompt: {
    text: string;
  };
  // Optional: add "safetySettings" or "aspectRatio" later if needed
}

interface ImagenResponse {
  images?: Array<{ inlineData?: { data?: string; mimeType?: string } }>;
  error?: { message?: string };
}

/**
 * Minimal Imagen client hitting the generativelanguage image endpoint.
 * Returns a data URL (mime + base64) so downstream can render without extra hops.
 */
export class ImagenAI implements IAIProvider {
  private apiKey: string;
  private modelId: string;
  private endpoint: string;

  constructor(apiKey: string, modelId: string = 'imagen-4.0-generate-001') {
    if (!apiKey) throw new Error('Imagen API key is required');
    this.apiKey = apiKey;
    this.modelId = modelId;
    this.endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateImages`;
  }

  private buildPrompt(content: string | any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      // Pull any text parts; ignore non-text parts for Imagen prompt construction
      const texts = content
        .map((p: any) => (p?.type === 'text' ? p.text : ''))
        .filter(Boolean);
      return texts.join(' ').trim();
    }
    return '';
  }

  async sendMessage(message: IMessage): Promise<{ response: string; latency: number }> {
    const start = Date.now();
    const promptText = this.buildPrompt(message.content);
    if (!promptText) {
      throw new Error('Imagen requires a text prompt');
    }

    const body: ImagenRequest = { prompt: { text: promptText } };

    const res = await fetch(`${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const latency = Date.now() - start;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Imagen API failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as ImagenResponse;
    const img = json.images?.[0]?.inlineData;
    if (!img?.data) {
      const err = json.error?.message || 'No image returned from Imagen';
      throw new Error(err);
    }

    const mime = img.mimeType || 'image/png';
    const dataUrl = `data:${mime};base64,${img.data}`;

    return { response: dataUrl, latency };
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<{ chunk: string; latency: number; response: string; anystream: any; }, void, unknown> {
    // Imagen does not provide true streaming; reuse the non-stream call and emit a single chunk.
    const result = await this.sendMessage(message);
    yield { chunk: result.response, latency: result.latency, response: result.response, anystream: null };
  }
}