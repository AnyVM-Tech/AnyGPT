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
import { logUniqueProviderError } from '../modules/errorLogger.js';
import { normalizeImageFetchReferer } from '../modules/openaiRequestSupport.js';
import { textMentionsHostname } from '../modules/urlGuards.js';
import dns from 'node:dns/promises';
import net from 'node:net';
// Removed imports related to compute and Provider state

const REMOTE_MEDIA_FETCHABILITY_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.GEMINI_REMOTE_MEDIA_FETCHABILITY_CACHE_TTL_MS ?? 30000)
);
const remoteMediaFetchabilityCache = new Map<
  string,
  { expiresAt: number; value: boolean }
>();

function getCachedRemoteMediaFetchability(url: string): boolean | null {
  const cached = remoteMediaFetchabilityCache.get(url);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    remoteMediaFetchabilityCache.delete(url);
    return null;
  }
  return cached.value;
}

function setCachedRemoteMediaFetchability(url: string, value: boolean): boolean {
  remoteMediaFetchabilityCache.set(url, {
    value,
    expiresAt: Date.now() + REMOTE_MEDIA_FETCHABILITY_CACHE_TTL_MS
  });
  return value;
}

function isLikelyFetchableRemoteMediaUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const cached = getCachedRemoteMediaFetchability(url);
  if (cached !== null) return cached;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return setCachedRemoteMediaFetchability(url, false);
    }
    if (!parsed.hostname || parsed.hostname === 'localhost') return false;
    return true;
  } catch {
    return false;
  }
}

async function canGeminiFetchRemoteMediaUrl(url: string, referer?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      Accept: '*/*',
      'User-Agent': 'AnyGPT/1.0 Gemini remote media preflight',
    };
    const normalizedReferer = normalizeImageFetchReferer(referer);
    if (normalizedReferer) headers.Referer = normalizedReferer;

    const response = await fetchWithTimeout(url, {
      method: 'HEAD',
      headers,
      redirect: 'follow',
    }, 5000);

    if (response.ok) return true;
    if (response.status === 405 || response.status === 501) {
      const fallback = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { ...headers, Range: 'bytes=0-0' },
        redirect: 'follow',
      }, 5000);
      return fallback.ok;
    }
    return false;
  } catch {
    return false;
  }
}

async function assertGeminiRemoteMediaAccessible(message: IMessage): Promise<void> {
  const remoteUrls = Array.from(new Set(collectRemoteMediaUrls(message)));
  if (remoteUrls.length === 0) return;

  const referer = normalizeImageFetchReferer((message as any)?.metadata?.referer || (message as any)?.referer);
  for (const url of remoteUrls) {
    const ok = await canGeminiFetchRemoteMediaUrl(url, referer);
    if (!ok) {
      const error = new Error(`Gemini API call failed: gemini:invalid_argument:unsupported_remote_media_url (${url})`);
      (error as any).code = 'GEMINI_UNSUPPORTED_REMOTE_MEDIA_URL';
      (error as any).retryable = false;
      (error as any).providerSwitchWorthless = true;
      (error as any).clientMessage = 'Invalid request: one or more remote media URLs could not be fetched by Gemini. Use a publicly accessible URL or inline/base64 media content.';
      throw error;
    }
  }
}

function collectRemoteMediaUrls(value: unknown, acc: string[] = []): string[] {
  if (!value) return acc;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRemoteMediaUrls(item, acc);
    return acc;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'url' || key === 'image_url' || key === 'file_uri' || key === 'media_url') && typeof nested === 'string' && /^https?:\/\//i.test(nested)) {
        acc.push(nested);
        continue;
      }
      collectRemoteMediaUrls(nested, acc);
    }
  }
  return acc;
}

function isLikelyUnsupportedRemoteMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.local')) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const parts = host.split('.').map((part) => Number(part));
      const [a, b] = parts;
      if (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

const GEMINI_CATALOG_AUTH_FAILURE_CACHE_MS = Math.max(30_000, Number(process.env.GEMINI_CATALOG_AUTH_FAILURE_CACHE_MS ?? 5 * 60_000));
const GEMINI_SHARED_CATALOG_AUTH_FAILURE_CACHE_KEY = '__shared_project_auth_failure__';

function isGeminiProjectAuthFailureMessage(message: string | undefined): boolean {
  const normalized = String(message || '').toLowerCase();
  return textMentionsHostname(normalized, 'generativelanguage.googleapis.com')
    || normalized.includes('generative language api has not been used in project')
    || normalized.includes('api activation')
    || normalized.includes('permission_denied');
}
const GEMINI_SHARED_CATALOG_LIST_FAILURE_CACHE_KEY = '__shared_catalog_list_failure__';
const geminiCatalogAuthFailureCache = new Map<string, { expiresAt: number; error: Error }>();

function getGeminiCatalogAuthFailureCacheKey(apiKey: string, endpoint: string): string {
  return `${endpoint}::${apiKey.slice(0, 12)}`;
}

function isGeminiCatalogAuthFailure(error: any): boolean {
  const status = Number(error?.response?.status ?? error?.status ?? 0);
  const message = String(error?.message || error?.response?.data?.error?.message || '').toLowerCase();
  return status === 401
    || status === 403
    || message.includes('api key not found')
    || message.includes('api_key_invalid')
    || message.includes('generative language api has not been used')
    || message.includes('service_disabled')
    || message.includes('api key not valid')
    || message.includes('permission denied')
    || message.includes('forbidden');
}

function copyGeminiErrorMetadata(target: Error, source: any): Error {
  const keys = [
    'status',
    'statusCode',
    'code',
    'retryable',
    'authFailure',
    'providerSwitchWorthless',
    'clientMessage',
    'requestRetryWorthless',
  ];
  for (const key of keys) {
    if (source?.[key] !== undefined) {
      (target as any)[key] = source[key];
    }
  }
  return target;
}

function isGeminiCatalogAuthFailureMessage(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('api key not found') ||
    normalized.includes('api key not valid') ||
    normalized.includes('please pass a valid api key') ||
    normalized.includes('api_key_invalid') ||
    normalized.includes('api key invalid') ||
    normalized.includes('api_key') && normalized.includes('invalid')
  );
}

function getCachedGeminiCatalogAuthFailure(apiKey: string, endpoint: string): Error | null {
  const key = getGeminiCatalogAuthFailureCacheKey(apiKey, endpoint);
  const cached = geminiCatalogAuthFailureCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    geminiCatalogAuthFailureCache.delete(key);
    return null;
  }
  return copyGeminiErrorMetadata(new Error(cached.error.message), cached.error);
}

function cacheGeminiCatalogAuthFailure(apiKey: string, endpoint: string, error: any): void {
  const key = getGeminiCatalogAuthFailureCacheKey(apiKey, endpoint);
  const message = String(error?.message || error?.response?.data?.error?.message || 'Gemini ListModels failed');
  const wrapped = copyGeminiErrorMetadata(new Error(message), error);
  const status = Number(error?.response?.status ?? error?.status ?? (wrapped as any).status ?? 403);
  (wrapped as any).status = status;
  (wrapped as any).statusCode = status;
  (wrapped as any).code = 'GEMINI_CATALOG_AUTH_DISABLED';
  (wrapped as any).retryable = false;
  (wrapped as any).authFailure = true;
  geminiCatalogAuthFailureCache.set(key, {
    expiresAt: Date.now() + GEMINI_CATALOG_AUTH_FAILURE_CACHE_MS,
    error: wrapped,
  });
}

async function inlineUnsupportedRemoteImageParts(parts: any[], referer?: string): Promise<any[]> {
  const normalizedReferer = normalizeImageFetchReferer(referer);
  return Promise.all(parts.map(async (part: any) => {
    const imageUrl = part?.fileData?.fileUri;
    if (!imageUrl || typeof imageUrl !== 'string') return part;
    if (!/^https?:\/\//i.test(imageUrl)) return part;

    try {
      const response = await fetchWithTimeout(imageUrl, {
        method: 'GET',
        headers: normalizedReferer ? { Referer: normalizedReferer } : undefined,
      }, 15000);
      if (!response.ok) return part;

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (!/^image\//i.test(contentType)) return part;

      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) return part;

      return {
        inlineData: {
          mimeType: contentType,
          data: Buffer.from(arrayBuffer).toString('base64'),
        },
      };
    } catch {
      return part;
    }
  }));
}

function isUnsupportedRemoteMediaUrlErrorMessage(value: string | undefined): boolean {
  return /cannot fetch content from the provided url/i.test(value ?? '');
}

function isUnsupportedRemoteMediaUrlError(error: any): boolean {
  const message = String(error?.message ?? '');
  const responseMessage = String(error?.response?.data?.error?.message ?? '');
  const responseStatus = String(error?.response?.data?.error?.status ?? '');
  const responseCode = Number(error?.response?.data?.error?.code ?? error?.response?.status ?? 0);

  return (
    isUnsupportedRemoteMediaUrlErrorMessage(message) ||
    isUnsupportedRemoteMediaUrlErrorMessage(responseMessage) ||
    (responseCode === 400 && responseStatus.toUpperCase() === 'INVALID_ARGUMENT' &&
      /cannot fetch content from the provided url/i.test(responseMessage))
  );
}

function sanitizeGeminiContentParts(parts: ContentPart[] | undefined): ContentPart[] | undefined {
  if (!Array.isArray(parts)) return parts;
  const filtered = parts.filter((part: any) => {
    if (!part || typeof part !== 'object') return true;
    const fileUri = typeof part.fileData?.fileUri === 'string' ? part.fileData.fileUri : undefined;
    const inlineUrl = typeof part.imageUrl?.url === 'string' ? part.imageUrl.url : undefined;
    const candidateUrl = fileUri ?? inlineUrl;
    if (!candidateUrl) return true;
    return !/^https?:\/\//i.test(candidateUrl);
  });
  return filtered.length > 0 ? filtered : parts.filter((part: any) => typeof part?.text === 'string' && part.text.trim().length > 0);
}

dotenv.config();

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const GEMINI_STREAM_IDLE_TIMEOUT_MS = (() => {
  const raw = process.env.GEMINI_STREAM_IDLE_TIMEOUT_MS;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return 30_000;
})();

type GeminiModelCatalogItem = {
  id: string;
  supportedMethods: Set<string>;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
};

type GeminiModelCatalogCacheEntry = {
  expiresAt: number;
  models: GeminiModelCatalogItem[];
};

export class GeminiAI implements IAIProvider {
  private sanitizeUnsupportedRemoteMediaContent(content: string | ContentPart[] | undefined): {
    content: string | ContentPart[] | undefined;
    changed: boolean;
  } {
    if (typeof content === 'string' || !Array.isArray(content)) {
      return { content, changed: false };
    }

    const filteredParts = content.filter((part: any) => {
      const candidate = typeof part?.image_url?.url === 'string'
        ? part.image_url.url
        : typeof part?.file_url?.url === 'string'
          ? part.file_url.url
          : undefined;
      if (!candidate) return true;
      try {
        const parsed = new URL(candidate);
        return parsed.protocol !== 'http:' && parsed.protocol !== 'https:';
      } catch {
        return true;
      }
    });

    return {
      content: filteredParts,
      changed: filteredParts.length !== content.length,
    };
  }

  private stripUnsupportedRemoteMediaParts(message: IMessage): { message: IMessage; changed: boolean } {
    let changed = false;

    const topLevelContent = this.sanitizeUnsupportedRemoteMediaContent(message.content);
    changed = changed || topLevelContent.changed;

    const sanitizedMessages = Array.isArray(message.messages)
      ? message.messages.map((entry) => {
          const sanitized = this.sanitizeUnsupportedRemoteMediaContent(entry?.content as any);
          changed = changed || sanitized.changed;
          return sanitized.changed
            ? { ...entry, content: sanitized.content as any }
            : entry;
        })
      : message.messages;

    return changed
      ? {
          message: {
            ...message,
            content: topLevelContent.content as any,
            ...(sanitizedMessages ? { messages: sanitizedMessages } : {}),
          },
          changed: true,
        }
      : { message, changed: false };
  }

  private hasUnsupportedRemoteMediaUrl(message: IMessage): boolean {
    return this.stripUnsupportedRemoteMediaParts(message).changed;
  }

  private buildUnsupportedRemoteMediaError(mode: 'call' | 'stream'): Error {
    const wrappedError = new Error(
      mode === 'stream'
        ? 'Gemini API stream call failed: gemini:invalid_argument:unsupported_remote_media_url'
        : 'Gemini API call failed: gemini:invalid_argument:unsupported_remote_media_url'
    );
    (wrappedError as any).__providerUniqueLogged = true;
    (wrappedError as any).status = 400;
    (wrappedError as any).code = 'GEMINI_UNSUPPORTED_REMOTE_MEDIA_URL';
    (wrappedError as any).retryable = false;
    (wrappedError as any).providerSwitchWorthless = true;
    (wrappedError as any).requestRetryWorthless = true;
    (wrappedError as any).clientMessage = 'Invalid request: one or more remote media URLs could not be fetched by Gemini. Use a publicly accessible URL or inline/base64 media content.';
    return wrappedError;
  }

  private static modelCatalogCache: Map<string, GeminiModelCatalogCacheEntry> = new Map();
  private static modelTokenLimits: Map<string, { inputTokenLimit?: number; outputTokenLimit?: number }> = new Map();

  private apiKey: string;

  /**
   * Strip API keys from error/response text to prevent leaking secrets into logs.
   */
  private redactApiKey(text: string): string {
    if (!this.apiKey || !text) return text;
    return text.split(this.apiKey).join('[REDACTED]');
  }
  // Removed state properties: busy, lastLatency, providerData, alpha, providerId

  private static normalizeModelIdStatic(modelId: string): string {
    let normalized = String(modelId || '');
    if (normalized.startsWith('google/')) normalized = normalized.slice('google/'.length);
    if (normalized.startsWith('models/')) normalized = normalized.slice('models/'.length);
    return normalized;
  }

  private normalizeModelId(modelId: string): string {
    return GeminiAI.normalizeModelIdStatic(modelId);
  }

  private static recordModelTokenLimits(modelId: string, inputTokenLimit?: number, outputTokenLimit?: number) {
    const normalized = GeminiAI.normalizeModelIdStatic(modelId);
    const next: { inputTokenLimit?: number; outputTokenLimit?: number } = {
      ...(GeminiAI.modelTokenLimits.get(normalized) ?? {}),
    };
    if (Number.isFinite(inputTokenLimit) && (inputTokenLimit as number) > 0) {
      next.inputTokenLimit = inputTokenLimit;
    }
    if (Number.isFinite(outputTokenLimit) && (outputTokenLimit as number) > 0) {
      next.outputTokenLimit = outputTokenLimit;
    }
    if (Object.keys(next).length > 0) {
      GeminiAI.modelTokenLimits.set(normalized, next);
    }
  }

  static getModelTokenLimits(modelId: string): { inputTokenLimit?: number; outputTokenLimit?: number } | undefined {
    const normalized = GeminiAI.normalizeModelIdStatic(modelId);
    return GeminiAI.modelTokenLimits.get(normalized);
  }

  private static extractTokenLimitFromMessage(message: string): { kind: 'input' | 'output'; limit: number } | null {
    const raw = String(message || '');
    const inputMatch = raw.match(/input token count exceeds the maximum number of tokens allowed\s+(\d+)/i);
    if (inputMatch) {
      const limit = Number(inputMatch[1]);
      if (Number.isFinite(limit)) return { kind: 'input', limit };
    }
    const outputMatch = raw.match(/output token count exceeds the maximum number of tokens allowed\s+(\d+)/i);
    if (outputMatch) {
      const limit = Number(outputMatch[1]);
      if (Number.isFinite(limit)) return { kind: 'output', limit };
    }
    const maxOutputMatch = raw.match(/max\s*output\s*tokens[^\d]*(\d+)/i);
    if (maxOutputMatch) {
      const limit = Number(maxOutputMatch[1]);
      if (Number.isFinite(limit)) return { kind: 'output', limit };
    }
    const genericMatch = raw.match(/maximum number of tokens allowed\s+(\d+)/i);
    if (genericMatch) {
      const limit = Number(genericMatch[1]);
      if (!Number.isFinite(limit)) return null;
      const lowered = raw.toLowerCase();
      if (lowered.includes('input')) return { kind: 'input', limit };
      if (lowered.includes('output')) return { kind: 'output', limit };
    }
    return null;
  }

  private static extractGeminiErrorMessage(errorMessage: string): string {
    const raw = String(errorMessage || '');
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonSlice = raw.slice(jsonStart, jsonEnd + 1);
      try {
        const parsed = JSON.parse(jsonSlice);
        const apiMessage = parsed?.error?.message;
        if (typeof apiMessage === 'string' && apiMessage.trim()) return apiMessage;
      } catch {
        // Ignore JSON parsing errors and fall back to raw message
      }
    }
    return raw;
  }

  static updateModelTokenLimitsFromError(modelId: string, errorMessage: string) {
    const apiMessage = GeminiAI.extractGeminiErrorMessage(errorMessage);
    const parsed = GeminiAI.extractTokenLimitFromMessage(apiMessage);
    if (!parsed) return;
    if (parsed.kind === 'input') {
      GeminiAI.recordModelTokenLimits(modelId, parsed.limit, undefined);
      return;
    }
    GeminiAI.recordModelTokenLimits(modelId, undefined, parsed.limit);
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
    const cachedAuthFailure = getCachedGeminiCatalogAuthFailure(this.apiKey, GEMINI_API_BASE);
    if (cachedAuthFailure) {
      (cachedAuthFailure as any).retryable = false;
      (cachedAuthFailure as any).providerSwitchWorthless = true;
      throw cachedAuthFailure;
    }

    try {
      const endpoint = `${GEMINI_API_BASE}/models?key=${encodeURIComponent(this.apiKey)}`;
      const response = await fetchWithTimeout(endpoint);
      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        const redactedResponseText = this.redactApiKey(responseText);
        console.error(`Gemini ListModels raw error response: ${redactedResponseText}`);
        const listModelsError = new Error(`Gemini ListModels failed: [${response.status} ${response.statusText}] ${redactedResponseText}`);
        (listModelsError as any).status = response.status;
        (listModelsError as any).statusCode = response.status;
        const normalizedListModelsErrorText = `${response.status} ${response.statusText} ${redactedResponseText}`.toLowerCase();
        const isCatalogAuthOrGovernanceFailure =
          response.status === 400 ||
          response.status === 401 ||
          response.status === 403;
        const isInvalidApiKeyFailure =
          normalizedListModelsErrorText.includes('api key not valid') ||
          normalizedListModelsErrorText.includes('api_key_invalid') ||
          normalizedListModelsErrorText.includes('invalid api key');
        const isDisabledOrForbiddenCatalogFailure =
          normalizedListModelsErrorText.includes('generative language api has not been used in project') ||
          normalizedListModelsErrorText.includes('generative language api is disabled') ||
          normalizedListModelsErrorText.includes('service_disabled') ||
          normalizedListModelsErrorText.includes('accessnotconfigured') ||
          normalizedListModelsErrorText.includes('forbidden') ||
          normalizedListModelsErrorText.includes('permission denied') ||
          normalizedListModelsErrorText.includes('permission_denied') ||
          normalizedListModelsErrorText.includes('api has not been used in project') ||
          normalizedListModelsErrorText.includes('enable it by visiting');
        if (
          isCatalogAuthOrGovernanceFailure &&
          (isInvalidApiKeyFailure || isDisabledOrForbiddenCatalogFailure)
        ) {
          (listModelsError as any).retryable = false;
          (listModelsError as any).providerSwitchWorthless = true;
          (listModelsError as any).requestRetryWorthless = true;
          (listModelsError as any).failureOrigin = 'upstream_provider';
        }
        const isGeminiCatalogAuthFailure =
          response.status === 401 ||
          response.status === 403 ||
          (response.status === 400 && (
            normalizedListModelsErrorText.includes('api key not valid') ||
            normalizedListModelsErrorText.includes('api_key_invalid') ||
            normalizedListModelsErrorText.includes('invalid api key')
          ));
        if (isGeminiCatalogAuthFailure) {
          (listModelsError as any).retryable = false;
          (listModelsError as any).requestRetryWorthless = true;
          (listModelsError as any).requestRetryWorthless = true;
          (listModelsError as any).providerSwitchWorthless = true;
          cacheGeminiCatalogAuthFailure(this.apiKey, GEMINI_API_BASE, listModelsError);
        }
        throw listModelsError;
      }

      const payload = await response.json();
      const modelsRaw = Array.isArray(payload?.models) ? payload.models : [];
      const models: GeminiModelCatalogItem[] = modelsRaw
        .map((model: any) => {
          const name = typeof model?.name === 'string' ? model.name : '';
          const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
          const inputTokenLimit = typeof model?.inputTokenLimit === 'number' ? model.inputTokenLimit : undefined;
          const outputTokenLimit = typeof model?.outputTokenLimit === 'number' ? model.outputTokenLimit : undefined;
          const supportedGenerationMethods = Array.isArray(model?.supportedGenerationMethods)
            ? model.supportedGenerationMethods
            : [];
          const supportedMethods = new Set(
            supportedGenerationMethods
              .filter((method: any) => typeof method === 'string' && method.length > 0)
              .map((method: string) => method.toLowerCase())
          );
          if (Number.isFinite(inputTokenLimit) || Number.isFinite(outputTokenLimit)) {
            GeminiAI.recordModelTokenLimits(id, inputTokenLimit, outputTokenLimit);
          }
          return { id, supportedMethods, inputTokenLimit, outputTokenLimit };
        })
        .filter((entry: GeminiModelCatalogItem) => entry.id.length > 0);

      GeminiAI.modelCatalogCache.set(cacheKey, {
        expiresAt: now + MODEL_CATALOG_TTL_MS,
        models,
      });

      return models;
    } catch (error: any) {
      if (isGeminiCatalogAuthFailure(error)) {
        cacheGeminiCatalogAuthFailure(this.apiKey, GEMINI_API_BASE, error);
        throw getCachedGeminiCatalogAuthFailure(this.apiKey, GEMINI_API_BASE) ?? error;
      }
      throw error;
    }
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
    const modelLimits = GeminiAI.getModelTokenLimits(message.model?.id ?? '');
    const outputTokenLimit = typeof modelLimits?.outputTokenLimit === 'number' ? modelLimits.outputTokenLimit : undefined;
    const defaultMaxOutput = typeof outputTokenLimit === 'number' && outputTokenLimit > 0
      ? outputTokenLimit
      : 8192;
    let maxOutputTokens =
      typeof message.max_output_tokens === 'number'
        ? message.max_output_tokens
        : (typeof message.max_tokens === 'number' ? message.max_tokens : defaultMaxOutput);
    if (typeof outputTokenLimit === 'number' && outputTokenLimit > 0 && maxOutputTokens > outputTokenLimit) {
      console.warn(
        `Gemini maxOutputTokens clamped from ${maxOutputTokens} to ${outputTokenLimit} for model ${message.model?.id ?? 'unknown'}.`
      );
      maxOutputTokens = outputTokenLimit;
    }
    const config: Record<string, any> = {
      temperature: typeof message.temperature === 'number' ? message.temperature : 1,
      topP: typeof message.top_p === 'number' ? message.top_p : 0.95,
      maxOutputTokens,
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

  private normalizeGeminiTools(message: IMessage): Array<Record<string, any>> | undefined {
    const tools = Array.isArray(message.tools) ? message.tools : [];
    const functionDeclarations = tools
      .map((tool: any) => {
        if (!tool || typeof tool !== 'object') return null;
        const functionPayload = tool.function && typeof tool.function === 'object'
          ? tool.function
          : tool;
        const name = typeof functionPayload?.name === 'string' ? functionPayload.name.trim() : '';
        if (!name) return null;
        return {
          name,
          ...(typeof functionPayload?.description === 'string' && functionPayload.description.trim()
            ? { description: functionPayload.description.trim() }
            : {}),
          ...(functionPayload?.parameters && typeof functionPayload.parameters === 'object'
            ? { parameters: functionPayload.parameters }
            : {}),
        };
      })
      .filter((entry): entry is { name: string; description?: string; parameters?: any } => Boolean(entry));

    if (functionDeclarations.length === 0) return undefined;
    return [{ functionDeclarations }];
  }

  private normalizeGeminiToolConfig(message: IMessage): Record<string, any> | undefined {
    const toolChoice = message.tool_choice;
    if (toolChoice === 'none') {
      return { functionCallingConfig: { mode: 'NONE' } };
    }
    if (toolChoice === 'required') {
      return { functionCallingConfig: { mode: 'ANY' } };
    }
    if (toolChoice && typeof toolChoice === 'object') {
      const functionName = typeof toolChoice?.function?.name === 'string'
        ? toolChoice.function.name.trim()
        : '';
      if (functionName) {
        return {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [functionName],
          },
        };
      }
    }
    if (toolChoice === 'auto') {
      return { functionCallingConfig: { mode: 'AUTO' } };
    }
    return undefined;
  }

  private extractGeminiToolCalls(result: any): any[] | undefined {
    const collected: any[] = [];
    const pushToolCall = (call: any) => {
      const name = typeof call?.name === 'string' ? call.name.trim() : '';
      if (!name) return;
      const args = call?.args && typeof call.args === 'object' ? call.args : {};
      collected.push({
        id: typeof call?.id === 'string' && call.id.trim() ? call.id.trim() : undefined,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      });
    };

    const topLevelFunctionCalls = Array.isArray(result?.functionCalls) ? result.functionCalls : [];
    topLevelFunctionCalls.forEach(pushToolCall);

    const parts = Array.isArray(result?.candidates?.[0]?.content?.parts)
      ? result.candidates[0].content.parts
      : [];
    for (const part of parts) {
      if (part?.functionCall && typeof part.functionCall === 'object') {
        pushToolCall(part.functionCall);
      }
    }

    return collected.length > 0 ? collected : undefined;
  }

  private isGeminiInstructionRole(roleRaw: string): boolean {
    return roleRaw === 'system' || roleRaw === 'developer';
  }

  private buildContentsFromMessages(message: IMessage): { contents: any[]; systemText: string } {
    const sourceMessages = Array.isArray(message.messages) && message.messages.length > 0
      ? message.messages
      : [{ role: message.role || 'user', content: message.content }];

    const contents: any[] = [];
    const systemTexts: string[] = [];

    for (const entry of sourceMessages) {
      const roleRaw = typeof entry.role === 'string' ? entry.role.toLowerCase() : 'user';
      if (this.isGeminiInstructionRole(roleRaw)) {
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

    const tools = this.normalizeGeminiTools(message);
    if (tools) {
      body.tools = tools;
      const toolConfig = this.normalizeGeminiToolConfig(message);
      if (toolConfig) body.toolConfig = toolConfig;
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
    const details = responseText ? ` ${this.redactApiKey(responseText)}` : '';
    throw new Error(`Gemini API ${context} failed: [${response.status} ${response.statusText}]${details}`);
  }

  private extractOutputFromParts(parts: any[]): string {
    return this.extractOutputAndReasoningFromParts(parts).content;
  }

  private extractOutputAndReasoningFromParts(parts: any[]): { content: string; reasoning: string } {
    if (!Array.isArray(parts) || parts.length === 0) return { content: '', reasoning: '' };

    const inlineDataPart = parts.find((part) => part?.inlineData?.data);
    if (inlineDataPart?.inlineData?.data) {
      const mimeType = typeof inlineDataPart.inlineData.mimeType === 'string'
        ? inlineDataPart.inlineData.mimeType
        : 'application/octet-stream';
      return {
        content: `data:${mimeType};base64,${inlineDataPart.inlineData.data}`,
        reasoning: '',
      };
    }

    const contentParts: string[] = [];
    const reasoningParts: string[] = [];

    for (const part of parts) {
      const text = typeof part?.text === 'string' ? part.text : '';
      if (!text) continue;
      if (part?.thought === true) {
        reasoningParts.push(text);
      } else {
        contentParts.push(text);
      }
    }

    return {
      content: contentParts.join(''),
      reasoning: reasoningParts.join(''),
    };
  }

  private humanizeGeminiEnum(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ');
  }

  private normalizeGeminiFinishReason(value: any): string | undefined {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!normalized) return undefined;
    if (normalized === 'MAX_TOKENS') return 'length';
    if ([
      'SAFETY',
      'RECITATION',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
      'LANGUAGE',
      'IMAGE_SAFETY',
      'IMAGE_PROHIBITED_CONTENT',
      'IMAGE_RECITATION',
    ].includes(normalized)) {
      return 'content_filter';
    }
    return 'stop';
  }

  private isGeminiFilteredFinishReason(value: string): boolean {
    const normalized = String(value || '').trim().toUpperCase();
    return [
      'SAFETY',
      'RECITATION',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
      'LANGUAGE',
      'IMAGE_SAFETY',
      'IMAGE_PROHIBITED_CONTENT',
      'IMAGE_RECITATION',
    ].includes(normalized);
  }

  private buildGeminiNoContentOutcome(result: any): { response: string; finishReason?: string } | null {
    const promptBlockReason =
      typeof result?.promptFeedback?.blockReason === 'string'
        ? result.promptFeedback.blockReason.trim()
        : '';
    const promptBlockMessage =
      typeof result?.promptFeedback?.blockReasonMessage === 'string'
        ? result.promptFeedback.blockReasonMessage.trim()
        : '';
    if (promptBlockReason) {
      return {
        response:
          promptBlockMessage ||
          `Gemini blocked the prompt due to ${this.humanizeGeminiEnum(promptBlockReason)}.`,
        finishReason: 'content_filter',
      };
    }

    const candidate = result?.candidates?.[0];
    const rawFinishReason =
      typeof candidate?.finishReason === 'string'
        ? candidate.finishReason.trim()
        : '';
    const finishMessage =
      typeof candidate?.finishMessage === 'string'
        ? candidate.finishMessage.trim()
        : '';
    if (!rawFinishReason) return null;

    if (this.isGeminiFilteredFinishReason(rawFinishReason)) {
      return {
        response:
          finishMessage ||
          `Gemini blocked the response due to ${this.humanizeGeminiEnum(rawFinishReason)}.`,
        finishReason: 'content_filter',
      };
    }

    if (finishMessage) {
      return {
        response: finishMessage,
        finishReason: this.normalizeGeminiFinishReason(rawFinishReason),
      };
    }

    if (rawFinishReason.toUpperCase() === 'MAX_TOKENS') {
      return {
        response: 'Gemini reached the maximum output token limit before returning text.',
        finishReason: 'length',
      };
    }

    return null;
  }

  private buildGeminiNoContentError(result: any): Error {
    const promptBlockReason =
      typeof result?.promptFeedback?.blockReason === 'string'
        ? result.promptFeedback.blockReason.trim()
        : '';
    const candidate = result?.candidates?.[0];
    const rawFinishReason =
      typeof candidate?.finishReason === 'string'
        ? candidate.finishReason.trim()
        : '';
    const finishMessage =
      typeof candidate?.finishMessage === 'string'
        ? candidate.finishMessage.trim()
        : '';
    const details: string[] = [];
    if (promptBlockReason) details.push(`prompt blockReason=${promptBlockReason}`);
    if (rawFinishReason) details.push(`finishReason=${rawFinishReason}`);
    if (finishMessage) details.push(`finishMessage=${finishMessage}`);
    const error = new Error(
      details.length > 0
        ? `Gemini returned no text, reasoning, or tool calls (${details.join(', ')}).`
        : 'Gemini returned no text, reasoning, or tool calls.'
    );
    (error as any).code = rawFinishReason
      ? 'GEMINI_EMPTY_CANDIDATE'
      : 'GEMINI_INVALID_RESPONSE_STRUCTURE';
    (error as any).retryable = true;
    (error as any).providerSwitchWorthless = false;
    (error as any).requestRetryWorthless = false;
    return error;
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
    const originalParts = Array.isArray((message as any)?.parts) ? (message as any).parts : null;
    let retriedWithInlinedRemoteMedia = false;
    if (Array.isArray((message as any)?.parts) && (message as any).parts.length > 0) {
      try {
        (message as any).parts = await inlineUnsupportedRemoteImageParts(
          (message as any).parts,
          (message as any)?.referer
        );
      } catch {
        // Best-effort normalization only; preserve existing provider behavior on fetch failures.
      }
    }
    if (Array.isArray(message?.messages)) {
      message.messages = await Promise.all(
        message.messages.map(async (entry: any) => {
          if (!Array.isArray(entry?.content)) return entry;
          return {
            ...entry,
            content: await inlineUnsupportedRemoteImageParts(entry.content, (message as any)?.referer),
          };
        })
      );
    }
    // Removed busy flag management
    const startTime = Date.now();

    try {
      const sanitizedMessage = this.stripUnsupportedRemoteMediaParts(message);
      if (sanitizedMessage.changed) {
        throw this.buildUnsupportedRemoteMediaError('call');
      }

      const activeMessage = sanitizedMessage.message;
      const resolved = await this.resolveModelIdForMethod(activeMessage.model.id, 'generateContent');
      const body = this.buildRequestBody(activeMessage);
      const response = await this.requestGemini(resolved.modelId, 'generateContent', body);
      if (!response.ok) {
        await this.throwGeminiHttpError(response, 'generateContent');
      }

      const result = await response.json();
      const parts = result?.candidates?.[0]?.content?.parts || [];
      const extracted = this.extractOutputAndReasoningFromParts(parts);
      const toolCalls = this.extractGeminiToolCalls(result);
      const responseText = extracted.content;
      const reasoningText = extracted.reasoning;
      if (!responseText && !reasoningText && (!toolCalls || toolCalls.length === 0)) {
        const structuredOutcome = this.buildGeminiNoContentOutcome(result);
        if (structuredOutcome) {
          const endTime = Date.now();
          const latency = endTime - startTime;
          const usageMetadata = result?.usageMetadata;
          const usage = this.extractUsage(usageMetadata);
          return {
            response: structuredOutcome.response,
            latency: latency,
            reasoning: undefined,
            tool_calls: toolCalls,
            finish_reason: structuredOutcome.finishReason,
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
            }
          };
        }
        throw this.buildGeminiNoContentError(result);
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
        reasoning: reasoningText || undefined,
        tool_calls: toolCalls,
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
      void logUniqueProviderError({
        provider: 'gemini',
        operation: 'sendMessage',
        modelId: message.model?.id,
        endpoint: GEMINI_API_BASE,
        latencyMs: latency,
        error,
      });
      console.error(`Error during sendMessage with Gemini model ${message.model.id} (Latency: ${latency}ms):`, error);

      // Extract a more specific error message if possible
      const errorMessage = error.message || 'Unknown Gemini API error';
      GeminiAI.updateModelTokenLimitsFromError(message.model?.id ?? '', errorMessage);
      if (
        (error as any)?.code === 'GEMINI_UNSUPPORTED_REMOTE_MEDIA_URL'
        || /cannot fetch content from the provided url|unsupported_remote_media_url/i.test(errorMessage)
      ) {
        throw this.buildUnsupportedRemoteMediaError('call');
      }
      const isProjectAuthFailure = /generative language api has not been used in project|api\s+has\s+not\s+been\s+used\s+in\s+project|service disabled|api_disabled|accessnotconfigured/i.test(errorMessage);
      const isInvalidKeyFailure = /api key not found|api key not valid|api_key_invalid/i.test(errorMessage);
      const isModelUnavailableFailure = /no longer available to new users|update your code to use a newer model|model[_\s]?not[_\s]?found/i.test(errorMessage);
      // Rethrow the error to be handled by the MessageHandler
      const wrappedError = copyGeminiErrorMetadata(new Error(`Gemini API call failed: ${errorMessage}`), error);
      (wrappedError as any).__providerUniqueLogged = true;
      if (isProjectAuthFailure) {
        (wrappedError as any).status = 403;
        (wrappedError as any).statusCode = 403;
        (wrappedError as any).code = 'GEMINI_API_DISABLED';
        (wrappedError as any).retryable = false;
        (wrappedError as any).authFailure = true;
      } else if (isInvalidKeyFailure) {
        const status = Number((wrappedError as any).status ?? (wrappedError as any).statusCode ?? 400);
        (wrappedError as any).status = status;
        (wrappedError as any).statusCode = status;
        (wrappedError as any).code = 'GEMINI_INVALID_API_KEY';
        (wrappedError as any).retryable = false;
        (wrappedError as any).authFailure = true;
      } else if (isModelUnavailableFailure) {
        const status = Number((wrappedError as any).status ?? (wrappedError as any).statusCode ?? 404);
        (wrappedError as any).status = status;
        (wrappedError as any).statusCode = status;
        (wrappedError as any).code = 'model_not_found';
        (wrappedError as any).retryable = false;
      } else if (/invalid response structure received from gemini api/i.test(errorMessage) && (wrappedError as any).code === undefined) {
        (wrappedError as any).code = 'GEMINI_INVALID_RESPONSE_STRUCTURE';
        (wrappedError as any).retryable = false;
      }
      throw wrappedError;
    }
  }

  async createPassthroughStream(_message: IMessage): Promise<ProviderStreamPassthrough | null> {
    return null;
  }

  async *sendMessageStream(message: IMessage): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const startTime = Date.now();

    try {
      const sanitizedMessage = this.stripUnsupportedRemoteMediaParts(message);
      if (sanitizedMessage.changed) {
        throw this.buildUnsupportedRemoteMediaError('stream');
      }

      const activeMessage = sanitizedMessage.message;
      const resolved = await this.resolveModelIdForMethod(activeMessage.model.id, 'streamGenerateContent', true);
      const body = this.buildRequestBody(activeMessage);

      if (!resolved.usesStreamMethod) {
        const nonStreamResponse = await this.requestGemini(resolved.modelId, 'generateContent', body);
        if (!nonStreamResponse.ok) {
          await this.throwGeminiHttpError(nonStreamResponse, 'generateContent (stream fallback)');
        }
        const nonStreamJson = await nonStreamResponse.json();
        const parts = nonStreamJson?.candidates?.[0]?.content?.parts || [];
        const extracted = this.extractOutputAndReasoningFromParts(parts);
        const toolCalls = this.extractGeminiToolCalls(nonStreamJson);
        const finishReason = this.normalizeGeminiFinishReason(
          nonStreamJson?.candidates?.[0]?.finishReason
        );
        if (extracted.content || extracted.reasoning || (toolCalls && toolCalls.length > 0)) {
          const latency = Date.now() - startTime;
          yield {
            chunk: extracted.content,
            latency,
            response: extracted.content,
            reasoning: extracted.reasoning || undefined,
            anystream: null,
            tool_calls: toolCalls,
            finish_reason: finishReason,
          };
        } else {
          const structuredOutcome = this.buildGeminiNoContentOutcome(nonStreamJson);
          if (structuredOutcome) {
            const latency = Date.now() - startTime;
            yield {
              chunk: structuredOutcome.response,
              latency,
              response: structuredOutcome.response,
              reasoning: undefined,
              anystream: null,
              tool_calls: toolCalls,
              finish_reason: structuredOutcome.finishReason,
            };
          } else {
            throw this.buildGeminiNoContentError(nonStreamJson);
          }
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
      let sawMeaningfulOutput = false;
      let lastStructuredNoContentOutcome:
        | { response: string; finishReason?: string }
        | null = null;
      let lastNoContentPayload: any = null;
      let idleTimeoutId: NodeJS.Timeout | null = null;
      let idleTimedOut = false;

      const clearIdleTimeout = () => {
        if (idleTimeoutId) clearTimeout(idleTimeoutId);
        idleTimeoutId = null;
      };

      const scheduleIdleTimeout = () => {
        if (!Number.isFinite(GEMINI_STREAM_IDLE_TIMEOUT_MS) || GEMINI_STREAM_IDLE_TIMEOUT_MS <= 0) return;
        clearIdleTimeout();
        idleTimeoutId = setTimeout(() => {
          idleTimedOut = true;
          try {
            reader.cancel();
          } catch {
            // Ignore cancel errors
          }
        }, GEMINI_STREAM_IDLE_TIMEOUT_MS);
      };

      while (true) {
        scheduleIdleTimeout();
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          clearIdleTimeout();
          if (idleTimedOut) {
            throw new Error(`Gemini stream idle timeout after ${GEMINI_STREAM_IDLE_TIMEOUT_MS}ms`);
          }
          throw error;
        }
        clearIdleTimeout();
        if (idleTimedOut) {
          throw new Error(`Gemini stream idle timeout after ${GEMINI_STREAM_IDLE_TIMEOUT_MS}ms`);
        }
        const { done, value } = readResult;
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
          const extracted = this.extractOutputAndReasoningFromParts(parts || []);
          const toolCalls = this.extractGeminiToolCalls(parsed);
          const finishReason = this.normalizeGeminiFinishReason(
            parsed?.candidates?.[0]?.finishReason
          );
          const chunkOutput = extracted.content;
          const reasoningOutput = extracted.reasoning;
          if (!chunkOutput && !reasoningOutput && (!toolCalls || toolCalls.length === 0)) {
            lastNoContentPayload = parsed;
            const structuredOutcome = this.buildGeminiNoContentOutcome(parsed);
            if (structuredOutcome) {
              lastStructuredNoContentOutcome = structuredOutcome;
            }
            continue;
          }

          fullResponse += chunkOutput;
          sawMeaningfulOutput = true;
          const latency = Date.now() - startTime;
          yield {
            chunk: chunkOutput,
            latency,
            response: fullResponse,
            reasoning: reasoningOutput || undefined,
            anystream: null,
            tool_calls: toolCalls,
            finish_reason: finishReason,
          };
        }
      }

      if (!sawMeaningfulOutput) {
        if (lastStructuredNoContentOutcome) {
          const latency = Date.now() - startTime;
          yield {
            chunk: lastStructuredNoContentOutcome.response,
            latency,
            response: lastStructuredNoContentOutcome.response,
            reasoning: undefined,
            anystream: null,
            finish_reason: lastStructuredNoContentOutcome.finishReason,
          };
          return;
        }
        if (lastNoContentPayload) {
          throw this.buildGeminiNoContentError(lastNoContentPayload);
        }
      }
    } catch (error: any) {
      const latency = Date.now() - startTime;
      void logUniqueProviderError({
        provider: 'gemini',
        operation: 'sendMessageStream',
        modelId: message.model?.id,
        endpoint: GEMINI_API_BASE,
        latencyMs: latency,
        error,
      });
      console.error(`Error during sendMessageStream with Gemini model ${message.model.id} (Latency: ${latency}ms):`, error);
      const errorMessage = error.message || 'Unknown Gemini API error';
      GeminiAI.updateModelTokenLimitsFromError(message.model?.id ?? '', errorMessage);
      const isUnsupportedRemoteMediaUrl = /cannot fetch content from the provided url/i.test(errorMessage);
      const isProjectAuthFailure = /generative language api has not been used in project|it is disabled\. enable it by visiting|permission_denied/i.test(errorMessage);
      const isInvalidKeyFailure = /api key not found|api key not valid|api_key_invalid/i.test(errorMessage);
      const isModelUnavailableFailure = /no longer available to new users|update your code to use a newer model|model[_\s]?not[_\s]?found/i.test(errorMessage);
      const normalizedMessage = isUnsupportedRemoteMediaUrl
        ? 'gemini:invalid_argument:unsupported_remote_media_url'
        : isProjectAuthFailure
          ? 'gemini:auth_failure:project_api_disabled_or_unavailable'
          : isInvalidKeyFailure
            ? 'gemini:auth_failure:invalid_api_key'
          : isModelUnavailableFailure
            ? 'gemini:model_not_found'
          : errorMessage;
      const wrappedError = copyGeminiErrorMetadata(new Error(`Gemini API stream call failed: ${normalizedMessage}`), error);
      (wrappedError as any).__providerUniqueLogged = true;
      const status = isUnsupportedRemoteMediaUrl
        ? 400
        : ((isProjectAuthFailure || isInvalidKeyFailure)
          ? Number((wrappedError as any).status ?? (wrappedError as any).statusCode ?? (isProjectAuthFailure ? 403 : 400))
          : Number((wrappedError as any).status ?? (wrappedError as any).statusCode ?? (isModelUnavailableFailure ? 404 : 400)));
      (wrappedError as any).status = status;
      (wrappedError as any).statusCode = status;
      if (isUnsupportedRemoteMediaUrl) {
        (wrappedError as any).code = 'GEMINI_UNSUPPORTED_REMOTE_MEDIA_URL';
        (wrappedError as any).retryable = false;
      } else if (isProjectAuthFailure) {
        (wrappedError as any).code = 'GEMINI_PROJECT_AUTH_FAILURE';
        (wrappedError as any).retryable = false;
      } else if (isInvalidKeyFailure) {
        (wrappedError as any).code = 'GEMINI_INVALID_API_KEY';
        (wrappedError as any).retryable = false;
      } else if (isModelUnavailableFailure) {
        (wrappedError as any).code = 'model_not_found';
        (wrappedError as any).retryable = false;
      } else {
        if ((wrappedError as any).code === undefined) {
          (wrappedError as any).code = 'GEMINI_API_ERROR';
        }
        if ((wrappedError as any).retryable === undefined) {
          (wrappedError as any).retryable = false;
        }
      }
      (wrappedError as any).authFailure = isProjectAuthFailure || isInvalidKeyFailure;
      // Gemini may reject remote media URLs that other providers can still consume,
      // so keep provider fallback available while avoiding pointless retries against
      // the same provider with the same request payload.
      (wrappedError as any).providerSwitchWorthless = false;
      (wrappedError as any).requestRetryWorthless = isUnsupportedRemoteMediaUrl;
      if (isUnsupportedRemoteMediaUrl) {
        (wrappedError as any).clientMessage = 'Invalid request: one or more remote media URLs could not be fetched by Gemini. Use a publicly accessible URL or inline/base64 media content.';
      }
      throw wrappedError;
    }
  }
}
