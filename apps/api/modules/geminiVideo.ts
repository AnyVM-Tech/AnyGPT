import crypto from 'node:crypto';
import { fetchWithTimeout } from './http.js';
import { detectMimeTypeFromBase64 } from './mediaParsing.js';
import type { VideoGenerationProviderSelection } from './openaiProviderSelection.js';

const GEMINI_VIDEO_CACHE_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.GEMINI_VIDEO_CACHE_TTL_MS ?? 2 * 24 * 60 * 60 * 1000)
);

export type VideoRequestCacheProvider = {
  apiKey: string;
  baseUrl: string;
  kind?: VideoGenerationProviderSelection['kind'];
  operationName?: string;
  modelId?: string;
  contentUri?: string;
  ttlMs?: number;
  activeRequestId?: string;
  retryState?: VideoRetryState;
};

export type VideoRetryProvider = {
  apiKey: string;
  baseUrl: string;
};

export type VideoRetryState = {
  modelId: string;
  prompt: string;
  imageUrl?: string | null;
  requestBody?: any;
  attemptCount?: number;
  maxAttempts?: number;
  attemptedProviders?: VideoRetryProvider[];
};

type GeminiVideoOperation = Record<string, any>;

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const normalized = String(baseUrl || '').trim();
  return normalized.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com/v1beta';
}

function normalizeOperationName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^\/+/, '');
}

function toModelsName(modelId: string): string {
  return modelId.startsWith('models/') ? modelId : `models/${modelId}`;
}

function parseDataUrl(value: string | undefined): { mimeType: string; base64: string } | null {
  const match = String(value || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1] || 'application/octet-stream', base64: match[2] || '' };
}

function getAliasedFieldValue(source: any, aliases: string[]): any {
  if (!source || typeof source !== 'object') return undefined;
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) {
      const value = (source as Record<string, any>)[alias];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function getAliasedTrimmedString(source: any, aliases: string[]): string {
  const value = getAliasedFieldValue(source, aliases);
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeMimeType(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function normalizeAspectRatio(requestBody: any): string | null {
  const explicit = getAliasedTrimmedString(requestBody, ['aspectRatio', 'aspect_ratio']);
  if (explicit === '16:9' || explicit === '9:16') return explicit;

  const size = getAliasedTrimmedString(requestBody, ['size']);
  if (!size) return null;
  const normalized = size.toLowerCase();
  if (
    normalized === '1280x720' ||
    normalized === '1920x1080' ||
    normalized === '3840x2160'
  ) {
    return '16:9';
  }
  if (
    normalized === '720x1280' ||
    normalized === '1080x1920' ||
    normalized === '2160x3840'
  ) {
    return '9:16';
  }
  return null;
}

function normalizeResolution(requestBody: any): string | null {
  const explicit = getAliasedTrimmedString(requestBody, ['resolution']);
  const lowered = explicit.toLowerCase();
  if (lowered === '720p' || lowered === '1080p' || lowered === '4k') {
    return lowered;
  }

  const size = getAliasedTrimmedString(requestBody, ['size']).toLowerCase();
  if (
    size === '1280x720' ||
    size === '720x1280'
  ) {
    return '720p';
  }
  if (
    size === '1920x1080' ||
    size === '1080x1920'
  ) {
    return '1080p';
  }
  if (
    size === '3840x2160' ||
    size === '2160x3840'
  ) {
    return '4k';
  }
  return null;
}

function buildGeminiImageSource(value: any): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const parsed = parseDataUrl(trimmed);
    if (parsed) {
      return {
        bytesBase64Encoded: parsed.base64,
        mimeType: parsed.mimeType,
      };
    }
    return { uri: trimmed };
  }

  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const inlineData = value.inlineData && typeof value.inlineData === 'object'
    ? value.inlineData
    : null;
  if (inlineData && typeof inlineData.data === 'string' && inlineData.data.trim()) {
    return {
      bytesBase64Encoded: inlineData.data.trim(),
      mimeType: normalizeMimeType(inlineData.mimeType, detectMimeTypeFromBase64(inlineData.data.trim()) || 'image/png'),
    };
  }

  const rawData = getAliasedFieldValue(value, ['bytesBase64Encoded', 'data', 'base64', 'b64_json']);
  if (typeof rawData === 'string' && rawData.trim()) {
    const trimmedData = rawData.trim();
    const parsed = parseDataUrl(trimmedData);
    if (parsed) {
      return {
        bytesBase64Encoded: parsed.base64,
        mimeType: parsed.mimeType,
      };
    }
    return {
      bytesBase64Encoded: trimmedData,
      mimeType: normalizeMimeType(
        getAliasedFieldValue(value, ['mimeType', 'mime_type', 'mediaType', 'media_type']),
        detectMimeTypeFromBase64(trimmedData) || 'image/png'
      ),
    };
  }

  const fileData = value.fileData && typeof value.fileData === 'object'
    ? value.fileData
    : null;
  const uri = getAliasedTrimmedString(value, ['uri', 'url', 'image_url', 'imageUrl'])
    || getAliasedTrimmedString(fileData, ['fileUri', 'uri', 'url']);
  if (uri) {
    const mimeType = normalizeMimeType(
      getAliasedFieldValue(value, ['mimeType', 'mime_type']),
      normalizeMimeType(fileData?.mimeType, 'image/png')
    );
    return { uri, mimeType };
  }

  return null;
}

function buildGeminiVideoSource(value: any): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    const parsed = parseDataUrl(trimmed);
    if (parsed) {
      return {
        inlineData: {
          mimeType: parsed.mimeType,
          data: parsed.base64,
        },
      };
    }
    return { uri: trimmed };
  }

  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const inlineData = value.inlineData && typeof value.inlineData === 'object'
    ? value.inlineData
    : null;
  if (inlineData && typeof inlineData.data === 'string' && inlineData.data.trim()) {
    return {
      inlineData: {
        mimeType: normalizeMimeType(inlineData.mimeType, 'video/mp4'),
        data: inlineData.data.trim(),
      },
    };
  }

  const rawData = getAliasedFieldValue(value, ['data', 'base64', 'b64_json']);
  if (typeof rawData === 'string' && rawData.trim()) {
    const trimmedData = rawData.trim();
    const parsed = parseDataUrl(trimmedData);
    if (parsed) {
      return {
        inlineData: {
          mimeType: parsed.mimeType,
          data: parsed.base64,
        },
      };
    }
    return {
      inlineData: {
        mimeType: normalizeMimeType(
          getAliasedFieldValue(value, ['mimeType', 'mime_type', 'mediaType', 'media_type']),
          'video/mp4'
        ),
        data: trimmedData,
      },
    };
  }

  const fileData = value.fileData && typeof value.fileData === 'object'
    ? value.fileData
    : null;
  const uri = getAliasedTrimmedString(value, ['uri', 'url', 'video_url', 'videoUrl'])
    || getAliasedTrimmedString(fileData, ['fileUri', 'uri', 'url']);
  if (uri) {
    const mimeType = normalizeMimeType(
      getAliasedFieldValue(value, ['mimeType', 'mime_type']),
      normalizeMimeType(fileData?.mimeType, 'video/mp4')
    );
    return { uri, mimeType };
  }

  return null;
}

function buildGeminiReferenceImages(value: any): Array<Record<string, any>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const references: Array<Record<string, any>> = [];
  for (const entry of value.slice(0, 3)) {
    const image = buildGeminiImageSource(
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry.image ?? entry)
        : entry
    );
    if (!image) continue;
    const referenceType = entry && typeof entry === 'object'
      ? getAliasedTrimmedString(entry, ['referenceType', 'reference_type']) || 'asset'
      : 'asset';
    references.push({ image, referenceType });
  }
  return references.length > 0 ? references : undefined;
}

function buildGeminiVideoParameters(requestBody: any): Record<string, any> {
  const parameters: Record<string, any> = {};

  const aspectRatio = normalizeAspectRatio(requestBody);
  if (aspectRatio) parameters.aspectRatio = aspectRatio;

  const resolution = normalizeResolution(requestBody);
  if (resolution) parameters.resolution = resolution;

  const durationSeconds = normalizePositiveInteger(
    getAliasedFieldValue(requestBody, ['durationSeconds', 'duration_seconds', 'seconds', 'duration'])
  );
  if (durationSeconds !== null) parameters.durationSeconds = durationSeconds;

  const requestedVideoCount = normalizePositiveInteger(
    getAliasedFieldValue(requestBody, ['numberOfVideos', 'number_of_videos', 'sampleCount', 'sample_count', 'n'])
  );
  if (requestedVideoCount !== null) {
    if (requestedVideoCount !== 1) {
      const error = new Error('Bad Request: Gemini Veo currently supports only one generated video per /v1/videos request.');
      (error as any).statusCode = 400;
      throw error;
    }
    parameters.numberOfVideos = 1;
  }

  const personGeneration = getAliasedTrimmedString(requestBody, ['personGeneration', 'person_generation']);
  if (personGeneration) parameters.personGeneration = personGeneration;

  const negativePrompt = getAliasedTrimmedString(requestBody, ['negativePrompt', 'negative_prompt']);
  if (negativePrompt) parameters.negativePrompt = negativePrompt;

  const enhancePrompt = getAliasedFieldValue(requestBody, ['enhancePrompt', 'enhance_prompt']);
  if (typeof enhancePrompt === 'boolean') parameters.enhancePrompt = enhancePrompt;

  const seed = getAliasedFieldValue(requestBody, ['seed']);
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    parameters.seed = Math.floor(seed);
  }

  return parameters;
}

function buildGeminiVideoOperationUrl(baseUrl: string, operationName: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${normalizeOperationName(operationName)}`;
}

function buildGeminiVideoModelUrl(baseUrl: string, modelId: string): string {
  const normalizedModelId = toModelsName(modelId).replace(/^models\//, '');
  return `${normalizeBaseUrl(baseUrl)}/models/${encodeURIComponent(normalizedModelId)}:predictLongRunning`;
}

function createGeminiVideoRequestId(): string {
  return `gvid_${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizeGeminiOperationError(error: any): Record<string, any> | null {
  if (!error || typeof error !== 'object') return null;
  const message = typeof error.message === 'string' ? error.message : '';
  const code = typeof error.code === 'number' || typeof error.code === 'string' ? error.code : null;
  const status = typeof error.status === 'string' ? error.status : null;
  return {
    message: message || 'Gemini video operation failed.',
    code,
    status,
  };
}

function extractGeminiGeneratedVideoEntries(operation: GeminiVideoOperation): any[] {
  const response = operation?.response;
  const direct = Array.isArray(response?.generatedVideos)
    ? response.generatedVideos
    : [];
  if (direct.length > 0) return direct;

  const samples = Array.isArray(response?.generateVideoResponse?.generatedSamples)
    ? response.generateVideoResponse.generatedSamples
    : [];
  if (samples.length > 0) return samples;

  const altSamples = Array.isArray(response?.generate_video_response?.generated_samples)
    ? response.generate_video_response.generated_samples
    : [];
  return altSamples;
}

export function extractGeminiGeneratedVideoUri(operation: GeminiVideoOperation): string | null {
  for (const entry of extractGeminiGeneratedVideoEntries(operation)) {
    const video = entry?.video ?? entry;
    const uri = getAliasedTrimmedString(video, ['downloadUri', 'download_uri', 'uri', 'fileUri', 'file_uri', 'url']);
    if (uri) return uri;
  }
  return null;
}

function extractGeminiGeneratedVideoMimeType(operation: GeminiVideoOperation): string | null {
  for (const entry of extractGeminiGeneratedVideoEntries(operation)) {
    const video = entry?.video ?? entry;
    const mimeType = getAliasedTrimmedString(video, ['mimeType', 'mime_type']);
    if (mimeType) return mimeType;
  }
  return null;
}

function inferGeminiVideoStatus(operation: GeminiVideoOperation): 'queued' | 'processing' | 'completed' | 'failed' {
  if (operation?.done === true) {
    return operation?.error ? 'failed' : 'completed';
  }
  const metadataState = getAliasedTrimmedString(operation?.metadata, ['state', 'status']).toLowerCase();
  if (metadataState === 'pending' || metadataState === 'queued') return 'queued';
  return 'processing';
}

function buildGeminiVideoStatusResponse(params: {
  requestId: string;
  operation: GeminiVideoOperation;
  provider: VideoRequestCacheProvider;
}): Record<string, any> {
  const { requestId, operation, provider } = params;
  const createdAt = getAliasedTrimmedString(operation?.metadata, ['createTime', 'create_time']) || new Date().toISOString();
  const createdUnix = Number.isFinite(Date.parse(createdAt))
    ? Math.floor(Date.parse(createdAt) / 1000)
    : Math.floor(Date.now() / 1000);
  const contentUri = extractGeminiGeneratedVideoUri(operation);
  const status = inferGeminiVideoStatus(operation);

  return {
    id: requestId,
    request_id: requestId,
    object: 'video',
    created: createdUnix,
    created_at: createdAt,
    model: provider.modelId || null,
    status,
    provider: 'gemini',
    content_url: contentUri ? `/v1/videos/${encodeURIComponent(requestId)}/content` : null,
    operation: {
      name: normalizeOperationName(operation?.name),
      done: Boolean(operation?.done),
      metadata: operation?.metadata ?? null,
    },
    error: normalizeGeminiOperationError(operation?.error),
  };
}

async function parseGeminiJsonResponse(
  response: globalThis.Response,
  errorPrefix: string,
  providerId?: string
): Promise<Record<string, any>> {
  const rawText = await response.text().catch(() => '');
  let parsed: Record<string, any> | null = null;
  if (rawText.trim()) {
    try {
      parsed = JSON.parse(rawText) as Record<string, any>;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message = typeof parsed?.error?.message === 'string'
      ? parsed.error.message
      : rawText || response.statusText || errorPrefix;
    const error = new Error(`${errorPrefix}: ${message}`);
    (error as any).statusCode = response.status;
    if (providerId) (error as any).providerId = providerId;
    throw error;
  }

  if (parsed) return parsed;
  const error = new Error(`${errorPrefix}: empty or non-JSON response body`);
  (error as any).statusCode = 502;
  if (providerId) (error as any).providerId = providerId;
  throw error;
}

export async function requestGeminiVideoGeneration(params: {
  provider: VideoGenerationProviderSelection;
  modelId: string;
  prompt: string;
  imageUrl?: string | null;
  requestBody: any;
  upstreamTimeoutMs: number;
}): Promise<{
  responseJson: Record<string, any>;
  requestId: string;
  provider: VideoRequestCacheProvider;
}> {
  const { provider, modelId, prompt, imageUrl, requestBody, upstreamTimeoutMs } = params;
  if (provider.kind !== 'gemini') {
    const error = new Error('Gemini video generation requires a Gemini provider.');
    (error as any).statusCode = 500;
    throw error;
  }

  const instance: Record<string, any> = { prompt };
  const firstFrameInput =
    getAliasedFieldValue(requestBody, ['image', 'image_url', 'imageUrl', 'input_reference']) ?? imageUrl;
  if (firstFrameInput !== undefined && firstFrameInput !== null && firstFrameInput !== '') {
    const firstFrame = buildGeminiImageSource(firstFrameInput);
    if (!firstFrame) {
      const error = new Error('Bad Request: Gemini Veo image inputs must be data URLs, inline base64 objects, or URI values.');
      (error as any).statusCode = 400;
      throw error;
    }
    instance.image = firstFrame;
  }

  const lastFrameInput = getAliasedFieldValue(requestBody, ['lastFrame', 'last_frame']);
  if (lastFrameInput !== undefined && lastFrameInput !== null && lastFrameInput !== '') {
    const lastFrame = buildGeminiImageSource(lastFrameInput);
    if (!lastFrame) {
      const error = new Error('Bad Request: Gemini Veo lastFrame inputs must be data URLs, inline base64 objects, or URI values.');
      (error as any).statusCode = 400;
      throw error;
    }
    instance.lastFrame = lastFrame;
  }

  const referenceImagesInput = getAliasedFieldValue(requestBody, ['referenceImages', 'reference_images']);
  if (referenceImagesInput !== undefined && referenceImagesInput !== null) {
    const referenceImages = buildGeminiReferenceImages(referenceImagesInput);
    if (!referenceImages || referenceImages.length === 0) {
      const error = new Error('Bad Request: Gemini Veo referenceImages must contain image objects or URI/data URL strings.');
      (error as any).statusCode = 400;
      throw error;
    }
    instance.referenceImages = referenceImages;
  }

  const sourceVideoInput = getAliasedFieldValue(requestBody, ['video', 'video_url', 'videoUrl']);
  if (sourceVideoInput !== undefined && sourceVideoInput !== null && sourceVideoInput !== '') {
    const sourceVideo = buildGeminiVideoSource(sourceVideoInput);
    if (!sourceVideo) {
      const error = new Error('Bad Request: Gemini Veo video inputs must be data URLs, inline base64 objects, or URI values.');
      (error as any).statusCode = 400;
      throw error;
    }
    instance.video = sourceVideo;
  }

  const body: Record<string, any> = {
    instances: [instance],
  };
  const parameters = buildGeminiVideoParameters(requestBody);
  if (Object.keys(parameters).length > 0) {
    body.parameters = parameters;
  }

  const response = await fetchWithTimeout(
    buildGeminiVideoModelUrl(provider.baseUrl, modelId),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': provider.apiKey,
      },
      body: JSON.stringify(body),
    },
    upstreamTimeoutMs
  );
  const operation = await parseGeminiJsonResponse(
    response,
    'Video generation upstream error',
    provider.providerId
  );
  const operationName = normalizeOperationName(operation?.name);
  if (!operationName) {
    const error = new Error('Video generation upstream response missing operation name.');
    (error as any).statusCode = 502;
    (error as any).providerId = provider.providerId;
    throw error;
  }

  const requestId = createGeminiVideoRequestId();
  const cacheProvider: VideoRequestCacheProvider = {
    apiKey: provider.apiKey,
    baseUrl: normalizeBaseUrl(provider.baseUrl),
    kind: 'gemini',
    operationName,
    modelId,
    ttlMs: GEMINI_VIDEO_CACHE_TTL_MS,
  };

  return {
    responseJson: buildGeminiVideoStatusResponse({
      requestId,
      operation,
      provider: cacheProvider,
    }),
    requestId,
    provider: cacheProvider,
  };
}

export async function getGeminiVideoOperation(
  provider: VideoRequestCacheProvider,
  upstreamTimeoutMs: number
): Promise<GeminiVideoOperation> {
  const operationName = normalizeOperationName(provider.operationName);
  if (!operationName) {
    const error = new Error('No Gemini operation is associated with this video request.');
    (error as any).statusCode = 404;
    throw error;
  }

  const response = await fetchWithTimeout(
    buildGeminiVideoOperationUrl(provider.baseUrl, operationName),
    {
      method: 'GET',
      headers: {
        'x-goog-api-key': provider.apiKey,
      },
    },
    upstreamTimeoutMs
  );
  return await parseGeminiJsonResponse(
    response,
    'Video status upstream error'
  );
}

export function buildGeminiVideoCacheUpdate(
  provider: VideoRequestCacheProvider,
  operation: GeminiVideoOperation
): VideoRequestCacheProvider | null {
  const contentUri = extractGeminiGeneratedVideoUri(operation);
  if (!contentUri || contentUri === provider.contentUri) return null;
  return {
    ...provider,
    contentUri,
    ttlMs: provider.ttlMs,
  };
}

export function buildGeminiVideoStatusPayload(
  requestId: string,
  provider: VideoRequestCacheProvider,
  operation: GeminiVideoOperation
): Record<string, any> {
  return buildGeminiVideoStatusResponse({ requestId, provider, operation });
}

export async function downloadGeminiVideoContent(params: {
  provider: VideoRequestCacheProvider;
  upstreamTimeoutMs: number;
}): Promise<{
  upstreamRes: globalThis.Response;
  operation: GeminiVideoOperation | null;
  contentUri: string;
  mimeType: string | null;
}> {
  const { provider, upstreamTimeoutMs } = params;
  let operation: GeminiVideoOperation | null = null;
  let contentUri = typeof provider.contentUri === 'string' && provider.contentUri.trim()
    ? provider.contentUri.trim()
    : '';
  let mimeType: string | null = null;

  if (!contentUri) {
    operation = await getGeminiVideoOperation(provider, upstreamTimeoutMs);
    if (!operation?.done) {
      const error = new Error('Video content is not ready yet.');
      (error as any).statusCode = 409;
      throw error;
    }
    if (operation?.error) {
      const normalizedError = normalizeGeminiOperationError(operation.error);
      const error = new Error(normalizedError?.message || 'Video generation failed.');
      (error as any).statusCode = 502;
      throw error;
    }
    contentUri = extractGeminiGeneratedVideoUri(operation) || '';
    mimeType = extractGeminiGeneratedVideoMimeType(operation);
  }

  if (!contentUri) {
    const error = new Error('Video content is unavailable for this Gemini operation.');
    (error as any).statusCode = 404;
    throw error;
  }

  if (!/^https?:\/\//i.test(contentUri)) {
    contentUri = new URL(contentUri.replace(/^\/+/, ''), `${normalizeBaseUrl(provider.baseUrl)}/`).toString();
  }

  const upstreamRes = await fetchWithTimeout(
    contentUri,
    {
      method: 'GET',
      headers: {
        'x-goog-api-key': provider.apiKey,
      },
      redirect: 'follow',
    },
    upstreamTimeoutMs
  );

  if (!upstreamRes.ok) {
    const errorText = await upstreamRes.text().catch(() => upstreamRes.statusText || '');
    const error = new Error(`Video content upstream error: ${errorText || upstreamRes.statusText}`);
    (error as any).statusCode = upstreamRes.status;
    throw error;
  }

  return {
    upstreamRes,
    operation,
    contentUri,
    mimeType,
  };
}

export function isGeminiVideoRequestId(requestId: string): boolean {
  return String(requestId || '').trim().toLowerCase().startsWith('gvid_');
}
