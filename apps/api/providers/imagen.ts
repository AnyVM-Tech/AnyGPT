import dotenv from 'dotenv';
import { IAIProvider, IMessage, ProviderResponse } from './interfaces.js';
import { fetchWithTimeout } from '../modules/http.js';

dotenv.config();

const GEMINI_BASE_URLS = [
  'https://generativelanguage.googleapis.com/v1beta',
  'https://generativelanguage.googleapis.com/v1',
] as const;

const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

type ModelCatalogItem = {
  id: string;
  supportedMethods: Set<string>;
};

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: ModelCatalogItem[];
};

interface ImagenRequest {
  model?: string;
  prompt?: {
    text: string;
  };
  config?: {
    numberOfImages?: number;
    includeRaiReason?: boolean;
    aspectRatio?: string;
  };
}

interface ImagenResponse {
  generatedImages?: Array<{ image?: { imageBytes?: string; mimeType?: string } }>;
  images?: Array<{ inlineData?: { data?: string; mimeType?: string } }>;
  error?: { message?: string };
}

/**
 * Minimal Imagen client hitting the generativelanguage image endpoint.
 * Returns a data URL (mime + base64) so downstream can render without extra hops.
 */
export class ImagenAI implements IAIProvider {
  private static modelCatalogCache: Map<string, ModelCatalogCacheEntry> = new Map();

  private apiKey: string;
  private modelId: string;

  constructor(apiKey: string, modelId: string = 'imagen-4.0-generate-001') {
    if (!apiKey) throw new Error('Imagen API key is required');
    this.apiKey = apiKey;
    this.modelId = modelId.startsWith('google/') ? modelId.slice('google/'.length) : modelId;
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

  private sanitizePrompt(prompt: string, maxChars: number = 8000): string {
    if (!prompt) return '';
    const withoutDataUrls = prompt.replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[binary-data]');
    const compact = withoutDataUrls.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxChars) return compact;
    return compact.slice(0, maxChars);
  }

  private buildImagenBody(promptText: string): ImagenRequest {
    return {
      model: `models/${this.modelId}`,
      prompt: { text: promptText },
      config: {
        numberOfImages: 1,
      },
    };
  }

  private getCatalogCacheKey(baseUrl: string): string {
    return `${this.apiKey}::${baseUrl}`;
  }

  private async getModelCatalog(baseUrl: string): Promise<ModelCatalogItem[]> {
    const now = Date.now();
    const cacheKey = this.getCatalogCacheKey(baseUrl);
    const cached = ImagenAI.modelCatalogCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.models;

    const endpoint = `${baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`;
    const response = await fetchWithTimeout(endpoint);
    if (!response.ok) {
      ImagenAI.modelCatalogCache.set(cacheKey, { expiresAt: now + MODEL_CATALOG_TTL_MS, models: [] });
      return [];
    }

    const payload = await response.json().catch(() => ({} as any));
    const modelsRaw = Array.isArray(payload?.models) ? payload.models : [];
    const allModels: ModelCatalogItem[] = [];
    for (const model of modelsRaw) {
      const name = typeof model?.name === 'string' ? model.name : '';
      const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
      if (!id) continue;

      const supportedGenerationMethods = Array.isArray(model?.supportedGenerationMethods)
        ? model.supportedGenerationMethods
        : [];
      const supportedMethods = new Set<string>(
        supportedGenerationMethods
          .filter((method: any) => typeof method === 'string')
          .map((method: string) => method.toLowerCase())
      );
      allModels.push({ id, supportedMethods });
    }

    const deduped = new Map<string, ModelCatalogItem>();
    for (const model of allModels) {
      const existing = deduped.get(model.id);
      if (!existing) deduped.set(model.id, model);
      else model.supportedMethods.forEach((m) => existing.supportedMethods.add(m));
    }

    const models = [...deduped.values()];
    ImagenAI.modelCatalogCache.set(cacheKey, { expiresAt: now + MODEL_CATALOG_TTL_MS, models });
    return models;
  }

  private pickPredictModel(catalog: ModelCatalogItem[]): string | null {
    const requested = this.modelId.toLowerCase();
    const direct = catalog.find((m) => m.id.toLowerCase() === requested && m.supportedMethods.has('predict'));
    if (direct) return direct.id;

    const sameFamily = catalog.find((m) => m.id.toLowerCase().startsWith('imagen-') && m.supportedMethods.has('predict'));
    if (sameFamily) return sameFamily.id;

    return null;
  }

  private pickGenerateImagesModel(catalog: ModelCatalogItem[]): string | null {
    const requested = this.modelId.toLowerCase();
    const direct = catalog.find((m) => m.id.toLowerCase() === requested && m.supportedMethods.has('generateimages'));
    if (direct) return direct.id;

    const sameFamily = catalog.find((m) => m.id.toLowerCase().startsWith('imagen-') && m.supportedMethods.has('generateimages'));
    if (sameFamily) return sameFamily.id;

    return null;
  }

  private pickImageGenerateContentModel(catalog: ModelCatalogItem[]): string | null {
    const preferred = catalog.find((m) => m.id.toLowerCase().includes('flash-image') && m.supportedMethods.has('generatecontent'));
    if (preferred) return preferred.id;

    const nanoBanana = catalog.find((m) => m.id.toLowerCase().includes('nano-banana') && m.supportedMethods.has('generatecontent'));
    if (nanoBanana) return nanoBanana.id;

    const genericImageModel = catalog.find((m) => m.id.toLowerCase().includes('image') && m.supportedMethods.has('generatecontent'));
    if (genericImageModel) return genericImageModel.id;

    return null;
  }

  private extractImageData(json: ImagenResponse): { mimeType: string; data: string } | null {
    const fromGenerated = json.generatedImages?.[0]?.image;
    if (fromGenerated?.imageBytes) {
      return {
        mimeType: fromGenerated.mimeType || 'image/png',
        data: fromGenerated.imageBytes,
      };
    }

    const fromInline = json.images?.[0]?.inlineData;
    if (fromInline?.data) {
      return {
        mimeType: fromInline.mimeType || 'image/png',
        data: fromInline.data,
      };
    }

    return null;
  }

  private async callImagen(promptText: string): Promise<ImagenResponse> {
    const safePrompt = this.sanitizePrompt(promptText, 2000);
    const attemptedErrors: string[] = [];

    // --- Strategy 1: Use predict method (real Imagen models) ---
    predictLoop:
    for (const baseUrl of GEMINI_BASE_URLS) {
      const catalog = await this.getModelCatalog(baseUrl);
      const predictModelId = this.pickPredictModel(catalog);
      if (!predictModelId) continue;

      const endpoint = `${baseUrl}/models/${encodeURIComponent(predictModelId)}:predict?key=${encodeURIComponent(this.apiKey)}`;
      const predictBody = {
        instances: [{ prompt: safePrompt }],
        parameters: { sampleCount: 1 },
      };

      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(predictBody),
      });

      if (res.ok) {
        const json = await res.json().catch(() => ({} as any));
        const predictions = Array.isArray(json?.predictions) ? json.predictions : [];
        const imageBytes = predictions[0]?.bytesBase64Encoded || predictions[0]?.image?.bytesBase64Encoded;
        const mimeType = predictions[0]?.mimeType || predictions[0]?.image?.mimeType || 'image/png';
        if (imageBytes) {
          return { images: [{ inlineData: { data: imageBytes, mimeType } }] };
        }
      } else {
        const text = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Imagen API authorization failed (${res.status}): ${text || res.statusText}`);
        }
        // 429 = quota exceeded — skip entire predict strategy for this key
        if (res.status === 429) break predictLoop;
      }
    }

    // --- Strategy 2: Use generateContent on image-capable Gemini model ---
    for (const baseUrl of GEMINI_BASE_URLS) {
      const catalog = await this.getModelCatalog(baseUrl);
      const contentModelId = this.pickImageGenerateContentModel(catalog);
      if (!contentModelId) continue;

      const endpoint = `${baseUrl}/models/${encodeURIComponent(contentModelId)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      const payload = {
        contents: [{ role: 'user', parts: [{ text: `Generate an image of: ${safePrompt}` }] }],
      };

      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const json = await response.json().catch(() => ({} as any));
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const inlineImage = Array.isArray(parts) ? parts.find((part: any) => part?.inlineData?.data) : null;
        if (inlineImage?.inlineData?.data) {
          return {
            images: [{
              inlineData: {
                data: inlineImage.inlineData.data,
                mimeType: inlineImage.inlineData.mimeType || 'image/png',
              },
            }],
          };
        }
        // Got 200 but text-only — this key can't generate images, stop trying other base URLs
        break;
      } else {
        const text = await response.text().catch(() => '');
        if (response.status === 429) break; // quota — let handler try next provider
        if (response.status === 404) continue; // model not on this API version
        attemptedErrors.push(`${response.status} @ generateContent ${contentModelId}${text ? ` -> ${text.slice(0, 200)}` : ''}`);
      }
    }

    // --- Strategy 3: Try generateImages as last resort ---
    for (const baseUrl of GEMINI_BASE_URLS) {
      const catalog = await this.getModelCatalog(baseUrl);
      const generateImagesModelId = this.pickGenerateImagesModel(catalog);
      if (!generateImagesModelId) continue;

      const body = this.buildImagenBody(safePrompt);
      body.model = `models/${generateImagesModelId}`;

      const endpoint = `${baseUrl}/models/${encodeURIComponent(generateImagesModelId)}:generateImages?key=${encodeURIComponent(this.apiKey)}`;
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        return (await res.json()) as ImagenResponse;
      }

      const text = await res.text().catch(() => '');
      attemptedErrors.push(`${res.status} @ generateImages ${generateImagesModelId}${text ? ` -> ${text.slice(0, 200)}` : ''}`);
    }

    if (attemptedErrors.length === 0) {
      attemptedErrors.push('no eligible image models found (empty catalog or unsupported methods)');
    }
    throw new Error(`Imagen API failed after all strategies: ${attemptedErrors.join(' | ')}`);
  }

  async sendMessage(message: IMessage): Promise<ProviderResponse> {
    const start = Date.now();
    const promptText = this.sanitizePrompt(this.buildPrompt(message.content), 8000);
    if (!promptText) {
      throw new Error('Imagen requires a text prompt');
    }

    const json = await this.callImagen(promptText);
    const latency = Date.now() - start;

    const img = this.extractImageData(json);
    if (!img?.data) {
      const err = json.error?.message || 'No image returned from Imagen';
      throw new Error(err);
    }

    const mime = img.mimeType || 'image/png';
    const dataUrl = `data:${mime};base64,${img.data}`;

    return { response: dataUrl, latency };
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<{ chunk: string; latency: number; response: string; anystream: any; }, void, unknown> {
    // Imagen does not provide true streaming; reuse the non-stream call and emit chunked payloads.
    const result = await this.sendMessage(message);
    const maxChunkSize = 8 * 1024;
    const fullResponse = result.response || '';

    if (fullResponse.length <= maxChunkSize) {
      yield { chunk: fullResponse, latency: result.latency, response: fullResponse, anystream: null };
      return;
    }

    for (let offset = 0; offset < fullResponse.length; offset += maxChunkSize) {
      const chunk = fullResponse.slice(offset, offset + maxChunkSize);
      const partialResponse = fullResponse.slice(0, offset + chunk.length);
      yield {
        chunk,
        latency: result.latency,
        response: partialResponse,
        anystream: null,
      };
    }
  }
}
