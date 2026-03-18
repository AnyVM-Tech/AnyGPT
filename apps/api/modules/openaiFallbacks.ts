import type { Request, Response } from '../lib/uws-compat.js';
import { messageHandler } from '../providers/handler.js';
import { fetchWithTimeout } from './http.js';
import { detectMimeTypeFromBase64 } from './mediaParsing.js';
import {
  buildResponsesCompletedEvent,
  buildResponsesContentPartAddedEvent,
  buildResponsesContentPartDoneEvent,
  buildResponsesCreatedEvent,
  buildResponsesOutputItemAddedEvent,
  buildResponsesOutputItemDoneEvent,
  buildResponsesOutputTextDeltaEvent,
  buildResponsesOutputTextDoneEvent,
  buildResponsesResponseObject,
  createResponsesItemId,
  createResponsesMessageItem,
} from './openaiResponsesFormat.js';
import { ImagenAI } from '../providers/imagen.js';
import { updateUserTokenUsage } from './userData.js';
import { isInsufficientCreditsError, isRateLimitOrQuotaError } from './errorClassification.js';
import { formatGeneratedImageMarkdown } from './generatedImageStore.js';
import { enforceModelCapabilities, listImageGenProviders, listVideoGenProviders, type ImageGenerationProviderSelection, type VideoGenerationProviderSelection } from './openaiProviderSelection.js';
import { resolveSoraVideoModelId } from './openaiRouteUtils.js';

type FallbackSource = 'chat' | 'responses';

type ImageGenerationResult = {
  responseJson: Record<string, any>;
  imageRef?: string;
};

type VideoGenerationResult = {
  responseJson: Record<string, any>;
  requestId: string;
  provider: { apiKey: string; baseUrl: string };
};

const SORA_VIDEO_REMIX_MARKER_RE = /<!--\s*sora2video:([a-z0-9_-]+)\s*-->/i;

function parseDataUrl(value: string | undefined): { mimeType: string; base64: string } | null {
  const match = String(value || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1] || 'image/png', base64: match[2] || '' };
}

export function extractImageReferenceFromGenerationResponse(responseJson: any): string | undefined {
  const first = Array.isArray(responseJson?.data) ? responseJson.data[0] : undefined;
  if (typeof first?.url === 'string' && first.url.trim()) return first.url;
  if (typeof first?.b64_json === 'string' && first.b64_json.trim()) {
    const mimeType = typeof first?.mime_type === 'string' && first.mime_type.trim()
      ? first.mime_type.trim()
      : 'image/png';
    return `data:${mimeType};base64,${first.b64_json}`;
  }
  return undefined;
}

function shouldRetryImageGenerationWithoutResponseFormat(errorText: string): boolean {
  const normalized = String(errorText || '').toLowerCase();
  return normalized.includes("unknown parameter: 'response_format'")
    || normalized.includes('"param": "response_format"')
    || normalized.includes('"param":"response_format"')
    || normalized.includes('unsupported parameter: response_format');
}

function parseImageEditSseResponse(raw: string): Record<string, any> | null {
  const source = String(raw || '');
  if (!source.trim()) return null;

  const dataPayloads: any[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      dataPayloads.push(JSON.parse(payload));
    } catch {
      // Ignore malformed chunks and keep scanning for the completed event.
    }
  }

  for (let index = dataPayloads.length - 1; index >= 0; index -= 1) {
    const event = dataPayloads[index];
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'image_edit.completed' && typeof event.b64_json === 'string') {
      return {
        created: Math.floor(Date.now() / 1000),
        data: [{
          b64_json: event.b64_json,
          mime_type: typeof event.mime_type === 'string' ? event.mime_type : 'image/png',
        }],
        usage: event.usage,
      };
    }
    if (typeof event.b64_json === 'string') {
      return {
        created: Math.floor(Date.now() / 1000),
        data: [{
          b64_json: event.b64_json,
          mime_type: typeof event.mime_type === 'string' ? event.mime_type : 'image/png',
        }],
        usage: event.usage,
      };
    }
  }

  return null;
}

function shouldTryNextImageGenerationProvider(error: any): boolean {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || error || '');
  const normalized = message.toLowerCase();
  if (statusCode === 402 || statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429) {
    return true;
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return true;
  }
  if (isRateLimitOrQuotaError(message) || isInsufficientCreditsError(message)) {
    return true;
  }
  return normalized.includes('billing_hard_limit_reached')
    || normalized.includes('billing hard limit')
    || normalized.includes('billing_limit_user_error')
    || normalized.includes('you exceeded your current quota')
    || normalized.includes('insufficient_quota');
}

function shouldTryNextVideoGenerationProvider(error: any): boolean {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || error || '');
  const normalized = message.toLowerCase();
  if ([401, 402, 403, 408, 409, 425, 429].includes(statusCode)) {
    return true;
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return true;
  }
  if (isRateLimitOrQuotaError(message) || isInsufficientCreditsError(message)) {
    return true;
  }
  return normalized.includes('billing_hard_limit_reached')
    || normalized.includes('billing hard limit')
    || normalized.includes('billing_limit_user_error')
    || normalized.includes('invalid api key')
    || normalized.includes('incorrect api key')
    || normalized.includes('you exceeded your current quota')
    || normalized.includes('insufficient_quota');
}

function resolveVideoSize(requestBody: any, defaultSize?: string): string | undefined {
  if (typeof requestBody?.size === 'string' && requestBody.size.trim()) return requestBody.size.trim();
  if (typeof requestBody?.resolution === 'string' && requestBody.resolution.trim()) return requestBody.resolution.trim();
  const aspectRatio = typeof requestBody?.aspect_ratio === 'string'
    ? requestBody.aspect_ratio.trim()
    : '';
  if (aspectRatio === '16:9') return '1280x720';
  if (aspectRatio === '9:16') return '720x1280';
  return typeof defaultSize === 'string' && defaultSize.trim() ? defaultSize.trim() : undefined;
}

function resolveVideoSeconds(requestBody: any): string | undefined {
  if (typeof requestBody?.seconds === 'string' && requestBody.seconds.trim()) {
    return requestBody.seconds.trim();
  }
  if (typeof requestBody?.seconds === 'number' && Number.isFinite(requestBody.seconds) && requestBody.seconds > 0) {
    return String(Math.floor(requestBody.seconds));
  }
  if (typeof requestBody?.duration === 'number' && Number.isFinite(requestBody.duration) && requestBody.duration > 0) {
    return String(Math.floor(requestBody.duration));
  }
  return undefined;
}

type OpenAIVideoInputReference = {
  file_id?: string;
  image_url?: string;
};

type OpenAIVideoMultipartReference = {
  data: Buffer;
  mimeType: string;
  filename: string;
};

type OpenAIVideoReferencePayload = {
  json?: OpenAIVideoInputReference;
  multipart?: OpenAIVideoMultipartReference;
};

type ParsedUpstreamJsonOptions = {
  emptyMessage: string;
  invalidMessage: string;
  statusCode?: number;
  providerId?: string;
};

function inferExtensionFromMimeType(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase().trim();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  return 'png';
}

function createUpstreamJsonResponseError(message: string, options: Omit<ParsedUpstreamJsonOptions, 'emptyMessage' | 'invalidMessage'> = {}): Error {
  const error = new Error(message);
  (error as any).statusCode = typeof options.statusCode === 'number' ? options.statusCode : 502;
  if (options.providerId) {
    (error as any).providerId = options.providerId;
  }
  return error;
}

async function parseUpstreamJsonResponse(
  upstreamRes: globalThis.Response,
  options: ParsedUpstreamJsonOptions,
): Promise<Record<string, any>> {
  const rawText = await upstreamRes.text().catch(() => '');
  if (!rawText.trim()) {
    throw createUpstreamJsonResponseError(options.emptyMessage, options);
  }

  try {
    return JSON.parse(rawText) as Record<string, any>;
  } catch {
    throw createUpstreamJsonResponseError(options.invalidMessage, options);
  }
}

function buildMultipartVideoReferenceFromBase64(base64: string, mimeType?: string): OpenAIVideoMultipartReference {
  const normalizedBase64 = String(base64 || '').replace(/\s+/g, '');
  let data: Buffer;
  try {
    data = Buffer.from(normalizedBase64, 'base64');
  } catch {
    const error = new Error('Bad Request: invalid base64 image data for input_reference.');
    (error as any).statusCode = 400;
    throw error;
  }
  if (data.length === 0) {
    const error = new Error('Bad Request: input_reference image data is empty.');
    (error as any).statusCode = 400;
    throw error;
  }
  const normalizedMimeType = typeof mimeType === 'string' && mimeType.trim()
    ? mimeType.trim()
    : (detectMimeTypeFromBase64(normalizedBase64) || 'image/png');
  return {
    data,
    mimeType: normalizedMimeType,
    filename: `input_reference.${inferExtensionFromMimeType(normalizedMimeType)}`,
  };
}

function buildMultipartVideoReferenceFromDataUrl(dataUrl: string): OpenAIVideoMultipartReference {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    const error = new Error('Bad Request: invalid data URL for input_reference.');
    (error as any).statusCode = 400;
    throw error;
  }
  return buildMultipartVideoReferenceFromBase64(parsed.base64, parsed.mimeType);
}

function resolveOpenAIVideoInputReferenceUrl(value: any): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (!value || typeof value !== 'object') return '';

  for (const key of ['image_url', 'url']) {
    const candidate = (value as Record<string, any>)[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === 'object' && typeof candidate.url === 'string' && candidate.url.trim()) {
      return candidate.url.trim();
    }
  }

  return '';
}

function resolveOpenAIVideoInputReferenceBase64(value: any): { data: string; mimeType?: string } | null {
  if (!value || typeof value !== 'object') return null;

  for (const key of ['data', 'b64_json', 'base64']) {
    const candidate = (value as Record<string, any>)[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return {
        data: candidate.trim(),
        mimeType: typeof (value as Record<string, any>).media_type === 'string'
          ? (value as Record<string, any>).media_type
          : typeof (value as Record<string, any>).mime_type === 'string'
            ? (value as Record<string, any>).mime_type
            : undefined,
      };
    }
  }

  return null;
}

function buildOpenAIVideoInputReference(requestBody: any, imageUrl?: string | null): OpenAIVideoReferencePayload | undefined {
  if (requestBody?.input_reference !== undefined) {
    const value = requestBody.input_reference;
    if (typeof value === 'string' && value.trim()) {
      if (value.trim().startsWith('data:')) {
        return { multipart: buildMultipartVideoReferenceFromDataUrl(value.trim()) };
      }
      return { json: { image_url: value.trim() } };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const error = new Error(
        'Bad Request: input_reference must be a string or object with file_id, image_url, or base64 image data for OpenAI-compatible video requests.',
      );
      (error as any).statusCode = 400;
      throw error;
    }

    if (typeof value.file_id === 'string' && value.file_id.trim()) {
      return { json: { file_id: value.file_id.trim() } };
    }

    const inputImageUrl = resolveOpenAIVideoInputReferenceUrl(value);
    if (inputImageUrl) {
      if (inputImageUrl.startsWith('data:')) {
        return { multipart: buildMultipartVideoReferenceFromDataUrl(inputImageUrl) };
      }
      return { json: { image_url: inputImageUrl } };
    }

    const inputBase64 = resolveOpenAIVideoInputReferenceBase64(value);
    if (inputBase64) {
      if (inputBase64.data.startsWith('data:')) {
        return { multipart: buildMultipartVideoReferenceFromDataUrl(inputBase64.data) };
      }
      return {
        multipart: buildMultipartVideoReferenceFromBase64(
          inputBase64.data,
          inputBase64.mimeType,
        ),
      };
    }

    const error = new Error(
      'Bad Request: input_reference must include file_id, image_url, or base64 image data for OpenAI-compatible video requests.',
    );
    (error as any).statusCode = 400;
    throw error;
  }

  const explicitImageUrl = typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl.trim() : '';
  if (explicitImageUrl) {
    if (explicitImageUrl.startsWith('data:')) {
      return { multipart: buildMultipartVideoReferenceFromDataUrl(explicitImageUrl) };
    }
    return { json: { image_url: explicitImageUrl } };
  }

  return undefined;
}

function buildMultipartVideoGenerationRequest(params: {
  modelId: string;
  prompt: string;
  size?: string;
  seconds?: string;
  seed?: number;
  multipartReference: OpenAIVideoMultipartReference;
}): { contentType: string; body: Buffer } {
  const { modelId, prompt, size, seconds, seed, multipartReference } = params;
  const boundary = `----AnyGPTVideoGen${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  const appendField = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`));
  };
  const appendFile = (name: string, filename: string, mimeType: string, data: Buffer) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    chunks.push(data);
    chunks.push(Buffer.from('\r\n'));
  };

  appendField('model', modelId);
  appendField('prompt', prompt);
  appendField('size', size);
  appendField('seconds', seconds);
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    appendField('seed', seed);
  }
  appendFile('input_reference', multipartReference.filename, multipartReference.mimeType, multipartReference.data);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

function extractSoraRemixIdFromUnknown(value: any): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    const match = value.match(SORA_VIDEO_REMIX_MARKER_RE);
    return match?.[1];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const remixId = extractSoraRemixIdFromUnknown(item);
      if (remixId) return remixId;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const key of ['content', 'text', 'message', 'output_text']) {
      const remixId = extractSoraRemixIdFromUnknown((value as Record<string, any>)[key]);
      if (remixId) return remixId;
    }
  }
  return undefined;
}

function resolveSoraRemixId(requestBody: any): string | undefined {
  if (typeof requestBody?.remix_id === 'string' && requestBody.remix_id.trim()) {
    return requestBody.remix_id.trim();
  }

  const scanCollection = (items: any): string | undefined => {
    if (!Array.isArray(items)) return undefined;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      const role = typeof item?.role === 'string' ? item.role.toLowerCase() : '';
      if (role === 'user') continue;
      const remixId = extractSoraRemixIdFromUnknown(item);
      if (remixId) return remixId;
    }
    return undefined;
  };

  return scanCollection(requestBody?.messages)
    || scanCollection(requestBody?.input)
    || extractSoraRemixIdFromUnknown(requestBody?.input);
}

export function buildVideoGenerationStartedContent(requestId: string): string {
  const normalized = String(requestId || '').trim();
  if (!normalized) return 'Video generation started.';
  return `Video generation started. Request ID: ${normalized}. Check /v1/videos/${normalized} for status and /v1/videos/${normalized}/content when it is complete.\n<!-- sora2video:${normalized} -->`;
}

async function requestGeminiImageGeneration(params: {
  modelId: string;
  prompt: string;
  requestBody: any;
  userApiKey: string;
  requestId?: string;
}): Promise<ImageGenerationResult> {
  const { modelId, prompt, requestBody, userApiKey, requestId } = params;
  const lowerModelId = String(modelId || '').toLowerCase();
  const requestedModalities = lowerModelId.includes('nano-banana') ? ['image', 'text'] : ['image'];
  const result = await messageHandler.handleMessages([
    {
      role: 'user',
      model: { id: modelId },
      content: [{ type: 'text', text: prompt }],
      modalities: requestedModalities,
      max_output_tokens: typeof requestBody?.max_output_tokens === 'number' ? requestBody.max_output_tokens : 128,
    } as any,
  ], modelId, userApiKey, { requestId });
  const dataUrl = typeof result?.response === 'string' ? result.response : '';
  const parsed = parseDataUrl(dataUrl);
  const responseJson = {
    created: Math.floor(Date.now() / 1000),
    data: [{
      url: dataUrl || undefined,
      b64_json: parsed?.base64 || undefined,
      mime_type: parsed?.mimeType || 'image/png',
    }],
  };
  return {
    responseJson,
    imageRef: dataUrl || undefined,
  };
}

async function requestOpenAICompatibleImageGeneration(params: {
  provider: ImageGenerationProviderSelection;
  modelId: string;
  prompt: string;
  requestBody: any;
  upstreamTimeoutMs: number;
}): Promise<ImageGenerationResult> {
  const { provider, modelId, prompt, requestBody, upstreamTimeoutMs } = params;
  const upstreamUrl = `${provider.baseUrl}/v1/images/generations`;
  const basePayload: Record<string, any> = {
    model: modelId,
    prompt,
    n: typeof requestBody?.n === 'number' ? requestBody.n : 1,
    size: typeof requestBody?.size === 'string' ? requestBody.size : '1024x1024',
    quality: typeof requestBody?.quality === 'string' ? requestBody.quality : undefined,
    style: typeof requestBody?.style === 'string' ? requestBody.style : undefined,
  };
  const requestedResponseFormat = typeof requestBody?.response_format === 'string'
    ? requestBody.response_format
    : undefined;
  if (requestedResponseFormat) {
    basePayload.response_format = requestedResponseFormat;
  }

  let upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(basePayload),
  }, upstreamTimeoutMs);

  if (!upstreamRes.ok) {
    let errText = await upstreamRes.text().catch(() => '');
    if (requestedResponseFormat && shouldRetryImageGenerationWithoutResponseFormat(errText)) {
      const retryPayload = { ...basePayload };
      delete retryPayload.response_format;
      upstreamRes = await fetchWithTimeout(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(retryPayload),
      }, upstreamTimeoutMs);
      if (upstreamRes.ok) {
        const responseJson = await upstreamRes.json();
        return {
          responseJson,
          imageRef: extractImageReferenceFromGenerationResponse(responseJson),
        };
      }
      errText = await upstreamRes.text().catch(() => errText);
    }
    const error = new Error(`Image generation upstream error: ${errText || upstreamRes.statusText}`);
    (error as any).statusCode = upstreamRes.status;
    (error as any).providerId = provider.providerId;
    throw error;
  }

  const responseJson = await upstreamRes.json();
  return {
    responseJson,
    imageRef: extractImageReferenceFromGenerationResponse(responseJson),
  };
}

async function requestOpenAICompatibleImageEdit(params: {
  provider: ImageGenerationProviderSelection;
  contentType: string;
  body: BodyInit;
  upstreamTimeoutMs: number;
}): Promise<Record<string, any>> {
  const { provider, contentType, body, upstreamTimeoutMs } = params;
  const upstreamUrl = `${provider.baseUrl}/v1/images/edits`;
  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body,
  }, upstreamTimeoutMs);

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => '');
    const error = new Error(`Image edits upstream error: ${errText || upstreamRes.statusText}`);
    (error as any).statusCode = upstreamRes.status;
    (error as any).providerId = provider.providerId;
    throw error;
  }

  const responseContentType = String(upstreamRes.headers.get('content-type') || '').toLowerCase();
  if (responseContentType.includes('text/event-stream')) {
    const raw = await upstreamRes.text();
    const parsed = parseImageEditSseResponse(raw);
    if (parsed) return parsed;
    const error = new Error('Image edits upstream error: failed to parse image edit event stream');
    (error as any).statusCode = 502;
    (error as any).providerId = provider.providerId;
    throw error;
  }

  return await upstreamRes.json();
}

export async function requestImageGeneration(params: {
  modelId: string;
  prompt: string;
  requestBody: any;
  upstreamTimeoutMs: number;
  userApiKey?: string;
  requestId?: string;
}): Promise<ImageGenerationResult> {
  const { modelId, prompt, requestBody, upstreamTimeoutMs, userApiKey, requestId } = params;
  const providers = await listImageGenProviders(modelId, ['image_output']);
  if (providers.length === 0) {
    throw new Error('No available provider for image generation');
  }

  const directProviders = providers.filter((provider) => provider.kind !== 'gemini');
  if (directProviders.length === 0) {
    if (!userApiKey) {
      const error = new Error('No available provider for image generation');
      (error as any).statusCode = 503;
      throw error;
    }
    return requestGeminiImageGeneration({
      modelId,
      prompt,
      requestBody,
      userApiKey,
      requestId,
    });
  }

  let lastError: any = null;
  for (let index = 0; index < directProviders.length; index += 1) {
    const provider = directProviders[index];
    try {
      return await requestOpenAICompatibleImageGeneration({
        provider,
        modelId,
        prompt,
        requestBody,
        upstreamTimeoutMs,
      });
    } catch (error: any) {
      lastError = error;
      const hasMoreProviders = index < directProviders.length - 1;
      if (hasMoreProviders && shouldTryNextImageGenerationProvider(error)) {
        console.warn(
          `[ImageGeneration] Provider ${provider.providerId} failed for ${modelId} `
          + `with a retryable capacity error. Trying next provider...`
        );
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No available provider for image generation');
}

export async function requestImageEdit(params: {
  modelId: string;
  contentType: string;
  body: BodyInit;
  upstreamTimeoutMs: number;
}): Promise<Record<string, any>> {
  const { modelId, contentType, body, upstreamTimeoutMs } = params;
  const providers = (await listImageGenProviders(modelId, ['image_input', 'image_output']))
    .filter((provider) => provider.kind === 'openai');
  if (providers.length === 0) {
    throw new Error('No available provider for image edits');
  }

  let lastError: any = null;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      return await requestOpenAICompatibleImageEdit({
        provider,
        contentType,
        body,
        upstreamTimeoutMs,
      });
    } catch (error: any) {
      lastError = error;
      const hasMoreProviders = index < providers.length - 1;
      if (hasMoreProviders && shouldTryNextImageGenerationProvider(error)) {
        console.warn(
          `[ImageEdits] Provider ${provider.providerId} failed for ${modelId} `
          + `with a retryable capacity error. Trying next provider...`
        );
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No available provider for image edits');
}

type ImageEditReference = {
  image_url?: string;
  file_id?: string;
};

function normalizeImageEditReference(value: any): ImageEditReference | null {
  if (!value) return null;
  if (typeof value === 'string' && value.trim()) {
    return { image_url: value.trim() };
  }
  if (typeof value !== 'object') return null;
  if (typeof value.file_id === 'string' && value.file_id.trim()) {
    return { file_id: value.file_id.trim() };
  }
  const imageUrl = typeof value.image_url === 'string'
    ? value.image_url.trim()
    : (typeof value.image_url?.url === 'string' ? value.image_url.url.trim() : '');
  if (imageUrl) {
    return { image_url: imageUrl };
  }
  return null;
}

function pickImageEditOptionFields(requestBody: any, options: { includeStream?: boolean } = {}): Record<string, any> {
  const includeStream = options.includeStream ?? true;
  const next: Record<string, any> = {};
  for (const key of [
    'size',
    'quality',
    'background',
    'output_format',
    'output_compression',
    'moderation',
    'n',
    'user',
  ]) {
    if (requestBody?.[key] !== undefined) {
      next[key] = requestBody[key];
    }
  }
  if (includeStream && requestBody?.stream !== undefined) {
    next.stream = requestBody.stream;
  }
  return next;
}

function buildMultipartImageEditRequest(params: {
  modelId: string;
  prompt: string;
  imageUrl: string;
  requestBody: any;
}): { contentType: string; body: Buffer } {
  const { modelId, prompt, imageUrl, requestBody } = params;
  const parsedImage = parseDataUrl(imageUrl);
  if (!parsedImage) {
    const error = new Error('Bad Request: invalid image data URL for image edit.');
    (error as any).statusCode = 400;
    throw error;
  }

  const imageBuffer = Buffer.from(parsedImage.base64, 'base64');
  if (imageBuffer.length === 0) {
    const error = new Error('Bad Request: image data URL is empty.');
    (error as any).statusCode = 400;
    throw error;
  }

  const boundary = `----AnyGPTImageEdit${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  const appendField = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`));
  };
  const appendFile = (name: string, filename: string, mimeType: string, data: Buffer) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    chunks.push(data);
    chunks.push(Buffer.from('\r\n'));
  };

  appendField('model', modelId);
  appendField('prompt', prompt);
  for (const [key, value] of Object.entries(pickImageEditOptionFields(requestBody))) {
    appendField(key, value);
  }
  appendFile('image', `input.${(parsedImage.mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'}`, parsedImage.mimeType, imageBuffer);

  const maskRef = normalizeImageEditReference(requestBody?.mask);
  if (maskRef?.image_url?.startsWith('data:')) {
    const parsedMask = parseDataUrl(maskRef.image_url);
    if (parsedMask) {
      appendFile('mask', `mask.${(parsedMask.mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'}`, parsedMask.mimeType, Buffer.from(parsedMask.base64, 'base64'));
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

function buildJsonImageEditRequest(params: {
  modelId: string;
  prompt: string;
  imageUrl: string;
  requestBody: any;
}): { contentType: string; body: string } {
  const { modelId, prompt, imageUrl, requestBody } = params;
  const payload: Record<string, any> = {
    model: modelId,
    prompt,
    images: [{ image_url: imageUrl }],
    ...pickImageEditOptionFields(requestBody),
  };
  const maskRef = normalizeImageEditReference(requestBody?.mask);
  if (maskRef) {
    payload.mask = maskRef;
  }
  return {
    contentType: 'application/json',
    body: JSON.stringify(payload),
  };
}

export async function requestImageEditFromReference(params: {
  modelId: string;
  prompt: string;
  imageUrl: string;
  requestBody: any;
  upstreamTimeoutMs: number;
}): Promise<ImageGenerationResult> {
  const { modelId, prompt, imageUrl, requestBody, upstreamTimeoutMs } = params;
  const normalizedRequestBody = requestBody && typeof requestBody === 'object'
    ? { ...requestBody }
    : requestBody;
  if (normalizedRequestBody && typeof normalizedRequestBody === 'object') {
    delete normalizedRequestBody.stream;
  }
  const requestPayload = imageUrl.startsWith('data:')
    ? buildMultipartImageEditRequest({ modelId, prompt, imageUrl, requestBody: normalizedRequestBody })
    : buildJsonImageEditRequest({ modelId, prompt, imageUrl, requestBody: normalizedRequestBody });

  const responseJson = await requestImageEdit({
    modelId,
    contentType: requestPayload.contentType,
    body: requestPayload.body as BodyInit,
    upstreamTimeoutMs,
  });

  return {
    responseJson,
    imageRef: extractImageReferenceFromGenerationResponse(responseJson),
  };
}

async function requestVideoGenerationWithProvider(params: {
  provider: VideoGenerationProviderSelection;
  modelId: string;
  prompt: string;
  imageUrl?: string | null;
  requestBody: any;
  upstreamTimeoutMs: number;
}): Promise<VideoGenerationResult> {
  const { provider, modelId, prompt, imageUrl, requestBody, upstreamTimeoutMs } = params;
  const soraModel = provider.kind === 'openai' ? resolveSoraVideoModelId(modelId) : null;
  const upstreamModelId = provider.kind === 'openai' && soraModel?.providerModelId
    ? soraModel.providerModelId
    : modelId;
  const payload: Record<string, any> = { model: upstreamModelId, prompt };

  if (provider.kind === 'openai') {
    const remixId = resolveSoraRemixId(requestBody);
    if (remixId) {
      const remixPayload: Record<string, any> = { prompt };
      const upstreamUrl = `${provider.baseUrl}/v1/videos/${encodeURIComponent(remixId)}/remix`;
      const upstreamRes = await fetchWithTimeout(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(remixPayload),
      }, upstreamTimeoutMs);

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        const error = new Error(`Video generation upstream error: ${errText || upstreamRes.statusText}`);
        (error as any).statusCode = upstreamRes.status;
        (error as any).providerId = provider.providerId;
        throw error;
      }

      const responseJson = await parseUpstreamJsonResponse(upstreamRes, {
        emptyMessage: 'Video remix upstream returned an empty response body.',
        invalidMessage: 'Video remix upstream returned a non-JSON response body.',
        providerId: provider.providerId,
      });
      const requestId = responseJson?.request_id || responseJson?.id;
      if (!requestId) {
        const error = new Error('Video generation upstream response missing request_id.');
        (error as any).statusCode = 502;
        (error as any).providerId = provider.providerId;
        throw error;
      }

      if (!responseJson.request_id) responseJson.request_id = String(requestId);
      if (!responseJson.id) responseJson.id = String(requestId);

      return {
        responseJson,
        requestId: String(requestId),
        provider: { apiKey: provider.apiKey, baseUrl: provider.baseUrl },
      };
    }

    const size = resolveVideoSize(requestBody, soraModel?.defaultSize);
    const seconds = resolveVideoSeconds(requestBody);
    const inputReference = buildOpenAIVideoInputReference(requestBody, imageUrl);
    if (inputReference?.json) payload.input_reference = inputReference.json;
    if (size) payload.size = size;
    if (seconds) payload.seconds = seconds;
    if (typeof requestBody?.seed === 'number') payload.seed = requestBody.seed;

    const upstreamUrl = `${provider.baseUrl}/v1/videos`;
    const multipartRequest = inputReference?.multipart
      ? buildMultipartVideoGenerationRequest({
        modelId: upstreamModelId,
        prompt,
        size,
        seconds,
        seed: typeof requestBody?.seed === 'number' ? requestBody.seed : undefined,
        multipartReference: inputReference.multipart,
      })
      : null;
    const upstreamRes = await fetchWithTimeout(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': multipartRequest?.contentType || 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: multipartRequest ? (multipartRequest.body as unknown as BodyInit) : JSON.stringify(payload),
    }, upstreamTimeoutMs);

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      const error = new Error(`Video generation upstream error: ${errText || upstreamRes.statusText}`);
      (error as any).statusCode = upstreamRes.status;
      (error as any).providerId = provider.providerId;
      throw error;
    }

    const responseJson = await parseUpstreamJsonResponse(upstreamRes, {
      emptyMessage: 'Video generation upstream returned an empty response body.',
      invalidMessage: 'Video generation upstream returned a non-JSON response body.',
      providerId: provider.providerId,
    });
    const requestId = responseJson?.request_id || responseJson?.id;
    if (!requestId) {
      const error = new Error('Video generation upstream response missing request_id.');
      (error as any).statusCode = 502;
      (error as any).providerId = provider.providerId;
      throw error;
    }

    if (!responseJson.request_id) responseJson.request_id = String(requestId);
    if (!responseJson.id) responseJson.id = String(requestId);

    return {
      responseJson,
      requestId: String(requestId),
      provider: { apiKey: provider.apiKey, baseUrl: provider.baseUrl },
    };
  }

  if (typeof requestBody?.image_url === 'string') payload.image_url = requestBody.image_url;
  if (typeof requestBody?.video_url === 'string') payload.video_url = requestBody.video_url;
  if (imageUrl && !payload.image_url) payload.image_url = imageUrl;
  if (typeof requestBody?.duration === 'number') payload.duration = requestBody.duration;
  if (typeof requestBody?.aspect_ratio === 'string') payload.aspect_ratio = requestBody.aspect_ratio;
  if (typeof requestBody?.resolution === 'string') payload.resolution = requestBody.resolution;
  if (typeof requestBody?.seed === 'number') payload.seed = requestBody.seed;

  const upstreamUrl = `${provider.baseUrl}/v1/videos/generations`;
  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(payload),
  }, upstreamTimeoutMs);

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => '');
    const error = new Error(`Video generation upstream error: ${errText || upstreamRes.statusText}`);
    (error as any).statusCode = upstreamRes.status;
    (error as any).providerId = provider.providerId;
    throw error;
  }

  const responseJson = await parseUpstreamJsonResponse(upstreamRes, {
    emptyMessage: 'Video generation upstream returned an empty response body.',
    invalidMessage: 'Video generation upstream returned a non-JSON response body.',
    providerId: provider.providerId,
  });
  const requestId = responseJson?.request_id || responseJson?.id;
  if (!requestId) {
    const error = new Error('Video generation upstream response missing request_id.');
    (error as any).statusCode = 502;
    (error as any).providerId = provider.providerId;
    throw error;
  }

  if (!responseJson.request_id) responseJson.request_id = String(requestId);
  if (!responseJson.id) responseJson.id = String(requestId);

  return {
    responseJson,
    requestId: String(requestId),
    provider: { apiKey: provider.apiKey, baseUrl: provider.baseUrl },
  };
}

export async function requestVideoGeneration(params: {
  modelId: string;
  prompt: string;
  imageUrl?: string | null;
  requestBody: any;
  upstreamTimeoutMs: number;
}): Promise<VideoGenerationResult> {
  const { modelId, prompt, imageUrl, requestBody, upstreamTimeoutMs } = params;
  const providers = await listVideoGenProviders(modelId);
  if (providers.length === 0) {
    throw new Error('No available provider for video generation');
  }

  let lastError: any = null;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      return await requestVideoGenerationWithProvider({
        provider,
        modelId,
        prompt,
        imageUrl,
        requestBody,
        upstreamTimeoutMs,
      });
    } catch (error: any) {
      lastError = error;
      const hasMoreProviders = index < providers.length - 1;
      if (hasMoreProviders && shouldTryNextVideoGenerationProvider(error)) {
        console.warn(
          `[VideoGeneration] Provider ${provider.providerId} failed for ${modelId} `
          + `with a retryable capacity error. Trying next provider...`
        );
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No available provider for video generation');
}

async function requestOpenAICompatibleVideoGenerationMultipart(params: {
  provider: VideoGenerationProviderSelection;
  contentType: string;
  body: BodyInit;
  upstreamTimeoutMs: number;
}): Promise<VideoGenerationResult> {
  const { provider, contentType, body, upstreamTimeoutMs } = params;
  const upstreamUrl = `${provider.baseUrl}/v1/videos`;
  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body,
  }, upstreamTimeoutMs);

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => '');
    const error = new Error(`Video generation upstream error: ${errText || upstreamRes.statusText}`);
    (error as any).statusCode = upstreamRes.status;
    (error as any).providerId = provider.providerId;
    throw error;
  }

  const responseJson = await parseUpstreamJsonResponse(upstreamRes, {
    emptyMessage: 'Video generation upstream returned an empty response body.',
    invalidMessage: 'Video generation upstream returned a non-JSON response body.',
    providerId: provider.providerId,
  });
  const requestId = responseJson?.request_id || responseJson?.id;
  if (!requestId) {
    const error = new Error('Video generation upstream response missing request_id.');
    (error as any).statusCode = 502;
    (error as any).providerId = provider.providerId;
    throw error;
  }

  if (!responseJson.request_id) responseJson.request_id = String(requestId);
  if (!responseJson.id) responseJson.id = String(requestId);

  return {
    responseJson,
    requestId: String(requestId),
    provider: { apiKey: provider.apiKey, baseUrl: provider.baseUrl },
  };
}

export async function requestVideoGenerationMultipart(params: {
  modelId: string;
  contentType: string;
  body: BodyInit;
  upstreamTimeoutMs: number;
}): Promise<VideoGenerationResult> {
  const { modelId, contentType, body, upstreamTimeoutMs } = params;
  const providers = (await listVideoGenProviders(modelId)).filter((provider) => provider.kind === 'openai');
  if (providers.length === 0) {
    throw new Error('No available provider for video generation');
  }

  let lastError: any = null;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      return await requestOpenAICompatibleVideoGenerationMultipart({
        provider,
        contentType,
        body,
        upstreamTimeoutMs,
      });
    } catch (error: any) {
      lastError = error;
      const hasMoreProviders = index < providers.length - 1;
      if (hasMoreProviders && shouldTryNextVideoGenerationProvider(error)) {
        console.warn(
          `[VideoGenerationMultipart] Provider ${provider.providerId} failed for ${modelId} `
          + 'with a retryable capacity error. Trying next provider...'
        );
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No available provider for video generation');
}

function writeResponsesEvent(response: Response, payload: Record<string, any>): void {
  response.write(`event: ${payload.type}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendResponsesTextResult(params: {
  response: Response;
  modelId: string;
  contentText: string;
  usage: Record<string, number>;
  stream: boolean;
}): void {
  const { response, modelId, contentText, usage, stream } = params;
  const responseId = createResponsesItemId('resp');
  const created = Math.floor(Date.now() / 1000);
  const messageId = createResponsesItemId('msg');
  const responseBody = buildResponsesResponseObject({
    id: responseId,
    created,
    model: modelId,
    outputText: contentText,
    status: 'completed',
    messageId,
    messageStatus: 'completed',
    usage,
  });

  if (!stream) {
    if (!(response as any).completed) response.json(responseBody);
    return;
  }

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  try { (response as any).flushHeaders?.(); } catch {}

  const pendingMessageItem = createResponsesMessageItem('', { id: messageId, status: 'in_progress' });
  const finalMessageItem = Array.isArray(responseBody.output)
    ? responseBody.output.find((item: any) => item?.type === 'message' && item?.role === 'assistant')
    : undefined;
  const finalTextPart = Array.isArray(finalMessageItem?.content) && finalMessageItem.content.length > 0
    ? finalMessageItem.content[0]
    : { type: 'output_text', text: contentText };

  writeResponsesEvent(response, buildResponsesCreatedEvent({
    id: responseId,
    object: 'response',
    created,
    model: modelId,
    status: 'in_progress',
    output: [],
    output_text: '',
  }));
  writeResponsesEvent(response, buildResponsesOutputItemAddedEvent({
    responseId,
    outputIndex: 0,
    item: pendingMessageItem,
  }));
  writeResponsesEvent(response, buildResponsesContentPartAddedEvent({
    responseId,
    itemId: messageId,
    outputIndex: 0,
    contentIndex: 0,
    part: { type: 'output_text', text: '' },
  }));
  writeResponsesEvent(response, buildResponsesOutputTextDeltaEvent({
    responseId,
    itemId: messageId,
    outputIndex: 0,
    contentIndex: 0,
    delta: contentText,
  }));
  writeResponsesEvent(response, buildResponsesOutputTextDoneEvent({
    responseId,
    itemId: messageId,
    outputIndex: 0,
    contentIndex: 0,
    text: contentText,
  }));
  writeResponsesEvent(response, buildResponsesContentPartDoneEvent({
    responseId,
    itemId: messageId,
    outputIndex: 0,
    contentIndex: 0,
    part: finalTextPart,
  }));
  writeResponsesEvent(response, buildResponsesOutputItemDoneEvent({
    responseId,
    outputIndex: 0,
    item: finalMessageItem || createResponsesMessageItem(contentText, { id: messageId, status: 'completed' }),
  }));
  writeResponsesEvent(response, buildResponsesCompletedEvent(responseBody));
  response.write('data: [DONE]\n\n');
  response.end();
}

export async function handleImageGenFallbackFromChatOrResponses(params: {
  modelId: string;
  prompt: string;
  imageUrl?: string | null;
  requestBody: any;
  request: Request;
  response: Response;
  source: FallbackSource;
  upstreamTimeoutMs: number;
}) {
  const { modelId, prompt, imageUrl, requestBody, request, response, source, upstreamTimeoutMs } = params;

  if (!prompt) {
    if (!(response as any).completed) {
      response.status(400).json({
        error: {
          message: `Bad Request: prompt is required for image generation (fallback from /v1/${source}).`,
          type: 'invalid_request_error',
          param: 'prompt',
          code: 'missing_prompt',
        },
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  const requiredCaps = (imageUrl ? ['image_input', 'image_output'] : ['image_output']) as Array<'image_input' | 'image_output'>;
  const capsOk = await enforceModelCapabilities(modelId, requiredCaps, response);
  if (!capsOk) return;

  let resJson: Record<string, any>;
  let imageRef: string | undefined;
  try {
    const result = imageUrl
      ? await requestImageEditFromReference({
        modelId,
        prompt,
        imageUrl,
        requestBody,
        upstreamTimeoutMs,
      })
      : await requestImageGeneration({
        modelId,
        prompt,
        requestBody,
        upstreamTimeoutMs,
        userApiKey: request.apiKey || undefined,
        requestId: request.requestId,
      });
    resJson = result.responseJson;
    imageRef = result.imageRef;
  } catch (error: any) {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 503;
    if (!(response as any).completed) {
      response.status(statusCode).json({
        error: error?.message || (imageUrl ? 'No available provider for image edits' : 'No available provider for image generation'),
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }
  const content = imageRef
    ? (formatGeneratedImageMarkdown(imageRef, request.headers) || 'Image generation completed.')
    : 'Image generation completed.';

  const wantsStream = Boolean(requestBody?.stream);
  if (source === 'chat' && wantsStream) {
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    try { (response as any).flushHeaders?.(); } catch {}

    const firstChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content },
        finish_reason: null,
      }],
    };
    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
    response.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
    response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
  } else if (source === 'chat') {
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = Math.ceil(prompt.length / 4);
    const totalTokens = promptTokens + 1;
    response.json({
      id: `chatcmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: totalTokens },
    });
  } else {
    const promptTokens = Math.ceil(prompt.length / 4);
    const totalTokens = promptTokens + 1;
    sendResponsesTextResult({
      response,
      modelId,
      contentText: content,
      usage: { input_tokens: promptTokens, output_tokens: 1, total_tokens: totalTokens },
      stream: wantsStream,
    });
  }

  const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
  await updateUserTokenUsage(tokenEstimate, request.apiKey!);
}

export async function handleVideoGenFallbackFromChatOrResponses(params: {
  modelId: string;
  prompt: string;
  imageUrl?: string | null;
  requestBody: any;
  response: Response;
  source: FallbackSource;
  upstreamTimeoutMs: number;
  setVideoRequestCache: (requestId: string, provider: { apiKey: string; baseUrl: string }) => void;
}) {
  const { modelId, prompt, imageUrl, requestBody, response, source, upstreamTimeoutMs, setVideoRequestCache } = params;

  if (!prompt) {
    if (!(response as any).completed) {
      response.status(400).json({
        error: {
          message: `Bad Request: prompt is required for video generation (fallback from /v1/${source}).`,
          type: 'invalid_request_error',
          param: 'prompt',
          code: 'missing_prompt',
        },
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  let requestId: string;
  let provider: { apiKey: string; baseUrl: string };
  try {
    const result = await requestVideoGeneration({
      modelId,
      prompt,
      imageUrl,
      requestBody,
      upstreamTimeoutMs,
    });
    requestId = result.requestId;
    provider = result.provider;
  } catch (error: any) {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 503;
    if (!(response as any).completed) {
      response.status(statusCode).json({
        error: error?.message || 'No available provider for video generation',
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }
  setVideoRequestCache(String(requestId), provider);

  const contentText = buildVideoGenerationStartedContent(requestId);
  const wantsStream = Boolean(requestBody?.stream);

  if (source === 'chat') {
    if (wantsStream) {
      const created = Math.floor(Date.now() / 1000);
      const id = `chatcmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      try { (response as any).flushHeaders?.(); } catch {}

      const firstChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta: { content: contentText }, finish_reason: null }]
      };
      response.write(`data: ${JSON.stringify(firstChunk)}\n\n`);

      const finalChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      };
      response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      response.write(`data: [DONE]\n\n`);
      return response.end();
    }

    const openaiResponse = {
      id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: contentText },
        logprobs: null,
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    if (!(response as any).completed) response.json(openaiResponse);
    return;
  }

  const promptTokens = Math.ceil(prompt.length / 4);
  const totalTokens = promptTokens + 1;
  sendResponsesTextResult({
    response,
    modelId,
    contentText,
    usage: { input_tokens: promptTokens, output_tokens: 1, total_tokens: totalTokens },
    stream: wantsStream,
  });
}
