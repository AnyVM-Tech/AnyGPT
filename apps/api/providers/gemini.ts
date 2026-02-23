import dotenv from 'dotenv';
import {
  IAIProvider,
  IMessage,
  ContentPart,
  ProviderResponse,
  ProviderStreamChunk,
  ProviderStreamPassthrough
} from './interfaces.js'; // Only import necessary interfaces
import { fetchWithTimeout } from '../modules/http.js';
// Removed imports related to compute and Provider state

dotenv.config();

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

type GeminiModelCatalogItem = {
  id: string;
  supportedMethods: Set<string>;
};

type GeminiModelCatalogCacheEntry = {
  expiresAt: number;
  models: GeminiModelCatalogItem[];
};

export class GeminiAI implements IAIProvider {
  private static modelCatalogCache: Map<string, GeminiModelCatalogCacheEntry> = new Map();

  private apiKey: string;
  // Removed state properties: busy, lastLatency, providerData, alpha, providerId

  private normalizeModelId(modelId: string): string {
    return modelId.startsWith('google/') ? modelId.slice('google/'.length) : modelId;
  }

  private toModelsName(modelId: string): string {
    return modelId.startsWith('models/') ? modelId : `models/${modelId}`;
  }

  private async getModelCatalog(): Promise<GeminiModelCatalogItem[]> {
    const now = Date.now();
    const cacheKey = this.apiKey;
    const cached = GeminiAI.modelCatalogCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.models;
    }

    const endpoint = `${GEMINI_API_BASE}/models?key=${encodeURIComponent(this.apiKey)}`;
    const response = await fetchWithTimeout(endpoint);
    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      console.error(`Gemini ListModels raw error response: ${responseText}`);
      throw new Error(`Gemini ListModels failed: [${response.status} ${response.statusText}] ${responseText}`);
    }

    const payload = await response.json();
    const modelsRaw = Array.isArray(payload?.models) ? payload.models : [];
    const models: GeminiModelCatalogItem[] = modelsRaw
      .map((model: any) => {
        const name = typeof model?.name === 'string' ? model.name : '';
        const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
        const supportedGenerationMethods = Array.isArray(model?.supportedGenerationMethods)
          ? model.supportedGenerationMethods
          : [];
        const supportedMethods = new Set(
          supportedGenerationMethods
            .filter((method: any) => typeof method === 'string' && method.length > 0)
            .map((method: string) => method.toLowerCase())
        );
        return { id, supportedMethods };
      })
      .filter((entry: GeminiModelCatalogItem) => entry.id.length > 0);

    GeminiAI.modelCatalogCache.set(cacheKey, {
      expiresAt: now + MODEL_CATALOG_TTL_MS,
      models,
    });

    return models;
  }

  private async resolveModelIdForMethod(
    requestedModelId: string,
    method: 'generateContent' | 'streamGenerateContent',
    allowGenerateFallbackForStream: boolean = false
  ): Promise<{ modelId: string; usesStreamMethod: boolean }> {
    const normalizedRequest = this.normalizeModelId(requestedModelId);
    const models = await this.getModelCatalog();
    const methodKey = method.toLowerCase();
    const exact = models.find((entry) => entry.id === normalizedRequest);
    if (!exact) {
      return { modelId: normalizedRequest, usesStreamMethod: method === 'streamGenerateContent' };
    }

    if (exact.supportedMethods.has(methodKey)) {
      return { modelId: normalizedRequest, usesStreamMethod: method === 'streamGenerateContent' };
    }

    if (allowGenerateFallbackForStream && method === 'streamGenerateContent' && exact.supportedMethods.has('generatecontent')) {
      return { modelId: normalizedRequest, usesStreamMethod: false };
    }

    const availableExamples = models.slice(0, 5).map((entry) => entry.id).join(', ');
    throw new Error(
      `Gemini model '${normalizedRequest}' does not support '${method}'. Available examples: ${availableExamples}`
    );
  }

  private buildGenerationConfig(message: IMessage): Record<string, any> {
    const config: Record<string, any> = {
      temperature: typeof message.temperature === 'number' ? message.temperature : 1,
      topP: typeof message.top_p === 'number' ? message.top_p : 0.95,
      maxOutputTokens:
        typeof message.max_output_tokens === 'number'
          ? message.max_output_tokens
          : (typeof message.max_tokens === 'number' ? message.max_tokens : 8192),
    };

    const requestedModalities = Array.isArray(message.modalities)
      ? message.modalities.map((modality) => String(modality).trim().toLowerCase())
      : [];
    if (requestedModalities.length > 0) {
      config.responseModalities = requestedModalities.map((modality) => modality.toUpperCase());
    }

    if (message.audio && typeof message.audio === 'object') {
      const formatRaw = typeof message.audio.format === 'string' ? message.audio.format.trim().toLowerCase() : '';
      if (formatRaw) {
        config.responseMimeType = formatRaw.includes('/') ? formatRaw : `audio/${formatRaw}`;
      }

      const voiceName = typeof message.audio.voice === 'string' ? message.audio.voice.trim() : '';
      if (voiceName) {
        config.speechConfig = {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            },
          },
        };
      }
    }

    return config;
  }

  private contentToText(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content ?? '');
    const textParts = content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' || part.type === 'input_text') return part.text || '';
        return '';
      })
      .filter((text) => text.length > 0);
    return textParts.join('\n');
  }

  private buildContentsFromMessages(message: IMessage): { contents: any[]; systemText: string } {
    const sourceMessages = Array.isArray(message.messages) && message.messages.length > 0
      ? message.messages
      : [{ role: message.role || 'user', content: message.content }];

    const contents: any[] = [];
    const systemTexts: string[] = [];

    for (const entry of sourceMessages) {
      const roleRaw = typeof entry.role === 'string' ? entry.role.toLowerCase() : 'user';
      if (roleRaw === 'system') {
        const text = this.contentToText(entry.content);
        if (text) systemTexts.push(text);
        continue;
      }
      const geminiRole = roleRaw === 'assistant' || roleRaw === 'model' ? 'model' : 'user';
      contents.push({ role: geminiRole, parts: this.toGeminiContent(entry.content) });
    }

    if (contents.length === 0) {
      contents.push({ role: 'user', parts: this.toGeminiContent(message.content) });
    }

    return { contents, systemText: systemTexts.join('\n\n') };
  }

  private buildRequestBody(message: IMessage): Record<string, any> {
    const { contents, systemText: systemFromMessages } = this.buildContentsFromMessages(message);
    const body: Record<string, any> = {
      contents,
      generationConfig: this.buildGenerationConfig(message),
    };

    const systemText = Array.isArray(message.system)
      ? message.system.filter((s) => typeof s === 'string' && s.trim()).join('\n')
      : (typeof message.system === 'string' ? message.system : '');
    const instructions = typeof message.instructions === 'string' ? message.instructions.trim() : '';
    const instructionText = [systemFromMessages, systemText, instructions].filter(Boolean).join('\n\n');
    if (instructionText) {
      body.systemInstruction = {
        parts: [{ text: instructionText }],
      };
    }

    return body;
  }

  private async requestGemini(modelId: string, endpointSuffix: string, body: Record<string, any>): Promise<Response> {
    const separator = endpointSuffix.includes('?') ? '&' : '?';
    const endpoint = `${GEMINI_API_BASE}/${this.toModelsName(encodeURIComponent(modelId))}:${endpointSuffix}${separator}key=${encodeURIComponent(this.apiKey)}`;
    return fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async throwGeminiHttpError(response: Response, context: string): Promise<never> {
    const responseText = await response.text().catch(() => '');
    const details = responseText ? ` ${responseText}` : '';
    throw new Error(`Gemini API ${context} failed: [${response.status} ${response.statusText}]${details}`);
  }

  private extractOutputFromParts(parts: any[]): string {
    if (!Array.isArray(parts) || parts.length === 0) return '';

    const inlineDataPart = parts.find((part) => part?.inlineData?.data);
    if (inlineDataPart?.inlineData?.data) {
      const mimeType = typeof inlineDataPart.inlineData.mimeType === 'string'
        ? inlineDataPart.inlineData.mimeType
        : 'application/octet-stream';
      return `data:${mimeType};base64,${inlineDataPart.inlineData.data}`;
    }

    const textParts = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter((text) => text.length > 0);
    return textParts.join('');
  }

  private extractUsage(usageMetadata: any): { promptTokens?: number; completionTokens?: number; totalTokens?: number } {
    const promptTokens = typeof usageMetadata?.promptTokenCount === 'number' ? usageMetadata.promptTokenCount : undefined;
    const completionTokens = typeof usageMetadata?.candidatesTokenCount === 'number' ? usageMetadata.candidatesTokenCount : undefined;
    const totalTokens = typeof usageMetadata?.totalTokenCount === 'number' ? usageMetadata.totalTokenCount : undefined;
    return { promptTokens, completionTokens, totalTokens };
  }

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Gemini API key is required');
    }
    this.apiKey = apiKey;
    // Removed providerData initialization and initializeModelData call
  }

  private toGeminiContent(content: string | ContentPart[]) {
    if (typeof content === 'string') return [{ text: content }];
    return content.map((part) => {
      if (part.type === 'text') return { text: part.text };
      if (part.type === 'input_text') return { text: part.text };
      if (part.type === 'image_url') {
        const url = part.image_url.url;
        if (url.startsWith('data:')) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          const mimeType = match?.[1] || 'image/jpeg';
          const data = match?.[2] || '';
          return { inlineData: { data, mimeType } };
        }
        return { fileData: { fileUri: url, mimeType: 'image/jpeg' } };
      }
      if (part.type === 'input_audio') {
        const mimeType = part.input_audio.format.startsWith('audio/')
          ? part.input_audio.format
          : `audio/${part.input_audio.format}`;
        return { inlineData: { data: part.input_audio.data, mimeType } };
      }
      return { text: '' };
    });
  }

  // Removed isBusy, getLatency, getProviderData, initializeModelData methods

  /**
   * Sends a message to the Google Generative AI API.
   * This method is now stateless and only focuses on the API interaction.
   * @param message - The message to send, including the model details.
   * @returns A promise containing the API response content and latency.
   */
  async sendMessage(message: IMessage): Promise<ProviderResponse> {
    // Removed busy flag management
    const startTime = Date.now();

    try {
      const body = this.buildRequestBody(message);
      const resolved = await this.resolveModelIdForMethod(message.model.id, 'generateContent');
      const response = await this.requestGemini(resolved.modelId, 'generateContent', body);
      if (!response.ok) {
        await this.throwGeminiHttpError(response, 'generateContent');
      }

      const result = await response.json();
      const parts = result?.candidates?.[0]?.content?.parts || [];
      const responseText = this.extractOutputFromParts(parts);
      if (!responseText) {
        throw new Error('Invalid response structure received from Gemini API');
      }

      const endTime = Date.now();
      const latency = endTime - startTime;
      // Removed lastLatency update

      // Removed all internal state updates (token calculation, updateProviderData, compute calls)

      // Return only the response and latency
      const usageMetadata = result?.usageMetadata;
      const usage = this.extractUsage(usageMetadata);

      return {
        response: responseText,
        latency: latency,
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        }
      };

    } catch (error: any) {
      // Removed busy flag management
      // Removed internal state updates on error

      const endTime = Date.now();
      const latency = endTime - startTime;
      console.error(`Error during sendMessage with Gemini model ${message.model.id} (Latency: ${latency}ms):`, error);

      // Extract a more specific error message if possible
      const errorMessage = error.message || 'Unknown Gemini API error';
      // Rethrow the error to be handled by the MessageHandler
      throw new Error(`Gemini API call failed: ${errorMessage}`);
    }
  }

  async createPassthroughStream(_message: IMessage): Promise<ProviderStreamPassthrough | null> {
    return null;
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const startTime = Date.now();

    try {
      const body = this.buildRequestBody(message);
      const resolved = await this.resolveModelIdForMethod(message.model.id, 'streamGenerateContent', true);

      if (!resolved.usesStreamMethod) {
        const nonStreamResponse = await this.requestGemini(resolved.modelId, 'generateContent', body);
        if (!nonStreamResponse.ok) {
          await this.throwGeminiHttpError(nonStreamResponse, 'generateContent (stream fallback)');
        }
        const nonStreamJson = await nonStreamResponse.json();
        const parts = nonStreamJson?.candidates?.[0]?.content?.parts || [];
        const chunkOutput = this.extractOutputFromParts(parts);
        if (chunkOutput) {
          const latency = Date.now() - startTime;
          yield { chunk: chunkOutput, latency, response: chunkOutput, anystream: null };
        }
        return;
      }

      const response = await this.requestGemini(resolved.modelId, 'streamGenerateContent?alt=sse', body);
      if (!response.ok) {
        await this.throwGeminiHttpError(response, 'streamGenerateContent');
      }
      if (!response.body) {
        throw new Error('Gemini streaming response body is empty.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullResponse = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const lineBreakIndex = buffer.indexOf('\n');
          if (lineBreakIndex === -1) break;

          let line = buffer.slice(0, lineBreakIndex);
          buffer = buffer.slice(lineBreakIndex + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trimStart();
          if (!data || data === '[DONE]') continue;

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const parts = parsed?.candidates?.[0]?.content?.parts;
          const chunkOutput = this.extractOutputFromParts(parts || []);
          if (!chunkOutput) continue;

          fullResponse += chunkOutput;
          const latency = Date.now() - startTime;
          yield { chunk: chunkOutput, latency, response: fullResponse, anystream: null };
        }
      }
    } catch (error: any) {
      const latency = Date.now() - startTime;
      console.error(`Error during sendMessageStream with Gemini model ${message.model.id} (Latency: ${latency}ms):`, error);
      const errorMessage = error.message || 'Unknown Gemini API error';
      throw new Error(`Gemini API stream call failed: ${errorMessage}`);
    }
  }
}
