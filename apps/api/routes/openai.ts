import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import dotenv from 'dotenv';
import dns from 'node:dns/promises';
import net from 'node:net';
import { messageHandler } from '../providers/handler.js'; 
import { IMessage, type ModelCapability } from '../providers/interfaces.js'; 
import { 
    generateUserApiKey, // Now async
    extractMessageFromRequestBody, 
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage, // Now async
} from '../modules/userData.js';
// Import TierData type for Request extension
import { TierData } from '../modules/userData.js'; 
import { logError } from '../modules/errorLogger.js';
import redis from '../modules/db.js';
import tiersData from '../tiers.json' with { type: 'json' };
import { incrementSharedRateLimitCounters } from '../modules/rateLimitRedis.js';
import { enforceInMemoryRateLimit, evaluateSharedRateLimit, RequestTimestampStore } from '../modules/rateLimit.js';
import { runAuthMiddleware, runRateLimitMiddleware } from '../modules/middlewareFactory.js';
import { dataManager, LoadedProviders, LoadedProviderData, type ModelsFileStructure } from '../modules/dataManager.js';
import { logger } from '../modules/logger.js';
import { redactAuthorizationHeader, redactToken } from '../modules/redaction.js';
import { fetchWithTimeout } from '../modules/http.js';
import {
    createInteractionToken,
    executeGeminiInteraction,
    getInteractionsSigningSecret,
    normalizeDeepResearchModel,
    verifyInteractionToken,
    extractOpenAIResponseFormat,
    InteractionRequest,
    InteractionTokenClient,
} from '../modules/interactions.js';
 
dotenv.config();
 
const openaiRouter = new HyperExpress.Router();
 
// --- Rate Limiting Store --- 
const requestTimestamps: RequestTimestampStore = {};
const RATE_LIMIT_KEY_PREFIX = 'api:ratelimit:';
const INTERACTIONS_TOKEN_TTL_SECONDS = 15 * 60;

async function incrementSharedCounters(apiKey: string) {
    try {
        return await incrementSharedRateLimitCounters(redis, RATE_LIMIT_KEY_PREFIX, apiKey);
    } catch (err) {
        console.warn('[RateLimit] Shared counter failure, falling back to in-memory.', err);
        return null;
    }
}
 
// --- Request Extension ---
declare module '../lib/uws-compat.js' {
  interface Request {
    apiKey?: string; userId?: string; userRole?: string;
    userTokenUsage?: number; userTier?: string; 
    tierLimits?: TierData; 
  }
}
 
// --- Middleware ---
 
// MUST be async because it calls await validateApiKeyAndUsage
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
    logger.debug(`[AuthMiddleware] Request received at ${request.path} with method ${request.method}`);
    logger.debug(`[AuthMiddleware] Authorization header: ${redactAuthorizationHeader(request.headers['authorization'] as string | undefined) || 'None'}`);
    logger.debug(`[AuthMiddleware] x-api-key header: ${redactToken(request.headers['x-api-key'] as string | undefined) || 'None'}`);

    return runAuthMiddleware(request, response, next, {
        callNext: true,
        extractApiKey: (req) => {
            const authHeader = req.headers['authorization'] || req.headers['Authorization'];
            if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
            const apiKeyHeader = req.headers['api-key'];
            return (typeof apiKeyHeader === 'string' && apiKeyHeader) ? apiKeyHeader : null;
        },
        onMissingApiKey: async (req) => {
            await logError({ message: 'Unauthorized: Missing API key' }, req);
            return { status: 401, body: { error: 'Unauthorized: Missing or invalid API key header.', timestamp: new Date().toISOString() } };
        },
        onInvalidApiKey: async (req, details) => {
            const errorMessage = `Unauthorized: ${details.error || 'Invalid key/config.'}`;
            await logError({ message: errorMessage, statusCode: details.statusCode, apiKey: redactToken(details.apiKey) }, req);
            return { status: details.statusCode, body: { error: errorMessage, timestamp: new Date().toISOString() } };
        },
        onInternalError: async (req, error) => {
            await logError(error, req);
            console.error('Error during auth/usage check:', error);
            return { status: 500, body: { error: 'Internal Server Error', reference: 'Error during authentication processing.', timestamp: new Date().toISOString() } };
        },
    });
}

// Remains synchronous
async function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    return runRateLimitMiddleware(
        request,
        response,
        next,
        requestTimestamps,
        {
            onMissingContext: (req) => {
                const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (rateLimitMiddleware).';
                logError({ message: errMsg, requestPath: req.path }, req).catch(e => console.error('Failed background log:', e));
                console.error(errMsg);
                return { status: 500, body: { error: 'Internal Server Error', reference: 'Configuration error for rate limiting.', timestamp: new Date().toISOString() } };
            },
            onDenied: (req, details) => {
                const windowLabel = details.window.toUpperCase();
                logError({ message: `Rate limit exceeded: Max ${details.limit} ${windowLabel}.`, apiKey: redactToken(req.apiKey) }, req).catch(e => console.error('Failed background log:', e));
                return { status: 429, body: { error: `Rate limit exceeded: Max ${details.limit} ${windowLabel}.`, timestamp: new Date().toISOString() } };
            },
            sharedDecisionProvider: async (_req, apiKey, limits) => {
                const sharedCounts = await incrementSharedCounters(apiKey);
                if (!sharedCounts) return null;
                return evaluateSharedRateLimit(sharedCounts, limits);
            },
        }
    );
}

function extractResponsesRequestBody(requestBody: any): { message: IMessage; modelId: string; stream: boolean } {
    if (!requestBody || typeof requestBody !== 'object') {
        throw new Error('Invalid request body.');
    }

    if (!requestBody.model || typeof requestBody.model !== 'string' || !requestBody.model.trim()) {
        throw new Error('model parameter is required.');
    }
    const modelId = requestBody.model.trim();

    const rawInput = requestBody.input;
    if (rawInput === undefined || rawInput === null) {
        throw new Error('input is required for the responses API.');
    }

    let normalizedInput: any;
    if (Array.isArray(rawInput)) {
        normalizedInput = rawInput;
    } else if (typeof rawInput === 'string') {
        normalizedInput = [{ type: 'input_text', text: rawInput }];
    } else if (typeof rawInput === 'object') {
        normalizedInput = [rawInput];
    } else {
        throw new Error('input must be a string, array, or object.');
    }

    const maxTokens = typeof requestBody.max_tokens === 'number' ? requestBody.max_tokens : undefined;
    const maxOutputTokens = typeof requestBody.max_output_tokens === 'number' ? requestBody.max_output_tokens : undefined;
    const temperature = typeof requestBody.temperature === 'number' ? requestBody.temperature : undefined;
    const topP = typeof requestBody.top_p === 'number' ? requestBody.top_p : undefined;

    const message: IMessage = {
        content: normalizedInput,
        model: { id: modelId },
        useResponsesApi: true,
        system: requestBody.system,
        response_format: requestBody.response_format,
        max_tokens: maxTokens,
        max_output_tokens: maxOutputTokens,
        temperature,
        top_p: topP,
        metadata: requestBody.metadata,
        modalities: requestBody.modalities,
        audio: requestBody.audio,
        tools: requestBody.tools,
        tool_choice: requestBody.tool_choice,
        reasoning: requestBody.reasoning,
        instructions: requestBody.instructions
    };

    return { message, modelId, stream: Boolean(requestBody.stream) };
}

const BASE64_DATA_URL_GLOBAL = /data:([^;\s]+);base64,([A-Za-z0-9+/=_-]+)/gi;
const IMAGE_INPUT_TOKENS_PER_KB = readEnvNumber('IMAGE_INPUT_TOKENS_PER_KB', 4);
const IMAGE_OUTPUT_TOKENS_PER_KB = readEnvNumber('IMAGE_OUTPUT_TOKENS_PER_KB', 8);
const AUDIO_INPUT_TOKENS_PER_KB = readEnvNumber('AUDIO_INPUT_TOKENS_PER_KB', 2);
const AUDIO_OUTPUT_TOKENS_PER_KB = readEnvNumber('AUDIO_OUTPUT_TOKENS_PER_KB', 4);
const IMAGE_URL_FALLBACK_TOKENS = readEnvNumber('IMAGE_URL_FALLBACK_TOKENS', 512);
const AUDIO_DATA_FALLBACK_TOKENS = readEnvNumber('AUDIO_DATA_FALLBACK_TOKENS', 256);
const IMAGE_MIN_TOKENS = readEnvNumber('IMAGE_MIN_TOKENS', 0);
const AUDIO_MIN_TOKENS = readEnvNumber('AUDIO_MIN_TOKENS', 0);
const LOG_SENSITIVE_PAYLOADS = readEnvBool('LOG_SENSITIVE_PAYLOADS', false);
const UPSTREAM_TIMEOUT_MS = readEnvNumber('UPSTREAM_TIMEOUT_MS', 120_000);
const VIDEO_REQUEST_CACHE_TTL_MS = readEnvNumber('VIDEO_REQUEST_CACHE_TTL_MS', 60 * 60 * 1000);
const IMAGE_FETCH_TIMEOUT_MS = readEnvNumber('IMAGE_FETCH_TIMEOUT_MS', 15_000);
const IMAGE_FETCH_MAX_BYTES = readEnvNumber('IMAGE_FETCH_MAX_BYTES', 8 * 1024 * 1024);
const IMAGE_FETCH_MAX_REDIRECTS = readEnvNumber('IMAGE_FETCH_MAX_REDIRECTS', 3);
const IMAGE_FETCH_ALLOW_PRIVATE = readEnvBool('IMAGE_FETCH_ALLOW_PRIVATE', false);
const IMAGE_FETCH_FORWARD_AUTH = readEnvBool('IMAGE_FETCH_FORWARD_AUTH', false);
const IMAGE_FETCH_USER_AGENT = process.env.IMAGE_FETCH_USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const IMAGE_FETCH_REFERER = process.env.IMAGE_FETCH_REFERER;
const IMAGE_FETCH_ALLOWED_PROTOCOLS = (readEnvCsv('IMAGE_FETCH_ALLOWED_PROTOCOLS') ?? ['http', 'https']).map((p) => p.toLowerCase());
const IMAGE_FETCH_ALLOWED_HOSTS = readEnvCsv('IMAGE_FETCH_ALLOWED_HOSTS');

function readEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readEnvBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function readEnvCsv(name: string): string[] | null {
    const raw = process.env[name];
    if (!raw) return null;
    const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : null;
}

function getHeaderValue(headers: Record<string, any>, name: string): string | undefined {
    if (!headers) return undefined;
    const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    if (Array.isArray(direct)) return typeof direct[0] === 'string' ? direct[0] : undefined;
    return typeof direct === 'string' ? direct : undefined;
}

function normalizeImageFetchReferer(raw?: string): string | undefined {
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.toString();
        }
    } catch {
        return undefined;
    }
    return undefined;
}

const videoRequestCache = new Map<string, { apiKey: string; baseUrl: string; expiresAt: number }>();

function setVideoRequestCache(requestId: string, provider: { apiKey: string; baseUrl: string }) {
    if (!requestId) return;
    const expiresAt = Date.now() + VIDEO_REQUEST_CACHE_TTL_MS;
    videoRequestCache.set(requestId, { ...provider, expiresAt });
}

function getVideoRequestCache(requestId: string): { apiKey: string; baseUrl: string } | null {
    const entry = videoRequestCache.get(requestId);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
        videoRequestCache.delete(requestId);
        return null;
    }
    return { apiKey: entry.apiKey, baseUrl: entry.baseUrl };
}

function estimateTokensFromBase64Payload(payload: string, tokensPerKb: number, minTokens: number): number {
    if (!payload) return minTokens;
    const cleaned = payload.replace(/\s+/g, '');
    if (!cleaned) return minTokens;
    const bytes = Math.max(0, Math.floor((cleaned.length * 3) / 4));
    const tokens = Math.ceil((bytes / 1024) * tokensPerKb);
    return Math.max(tokens, minTokens);
}

function estimateTokensFromDataUrl(dataUrl: string, direction: 'input' | 'output'): number {
    const match = dataUrl.match(/^data:([^;\s]+);base64,([A-Za-z0-9+/=_-]+)$/i);
    if (!match) return 0;
    const mimeType = (match[1] || '').toLowerCase();
    const payload = match[2] || '';

    if (mimeType.startsWith('image/')) {
        const perKb = direction === 'input' ? IMAGE_INPUT_TOKENS_PER_KB : IMAGE_OUTPUT_TOKENS_PER_KB;
        return estimateTokensFromBase64Payload(payload, perKb, IMAGE_MIN_TOKENS);
    }
    if (mimeType.startsWith('audio/')) {
        const perKb = direction === 'input' ? AUDIO_INPUT_TOKENS_PER_KB : AUDIO_OUTPUT_TOKENS_PER_KB;
        return estimateTokensFromBase64Payload(payload, perKb, AUDIO_MIN_TOKENS);
    }
    return 0;
}

function estimateTokensFromText(text: string, direction: 'input' | 'output' = 'output'): number {
    const value = String(text || '');
    if (!value) return 0;

    let mediaTokens = 0;
    if (value.includes('data:')) {
        const regex = new RegExp(BASE64_DATA_URL_GLOBAL);
        for (const match of value.matchAll(regex)) {
            const mimeType = (match[1] || '').toLowerCase();
            const payload = match[2] || '';
            if (mimeType.startsWith('image/')) {
                const perKb = direction === 'input' ? IMAGE_INPUT_TOKENS_PER_KB : IMAGE_OUTPUT_TOKENS_PER_KB;
                mediaTokens += estimateTokensFromBase64Payload(payload, perKb, IMAGE_MIN_TOKENS);
            } else if (mimeType.startsWith('audio/')) {
                const perKb = direction === 'input' ? AUDIO_INPUT_TOKENS_PER_KB : AUDIO_OUTPUT_TOKENS_PER_KB;
                mediaTokens += estimateTokensFromBase64Payload(payload, perKb, AUDIO_MIN_TOKENS);
            }
        }
    }

    const stripped = value.replace(BASE64_DATA_URL_GLOBAL, '[binary-data]');
    if (!stripped) return mediaTokens;
    return mediaTokens + Math.ceil(stripped.length / 4);
}

function estimateTokensFromContent(content: IMessage['content']): number {
    if (typeof content === 'string') {
        return estimateTokensFromText(content, 'input');
    }
    if (!Array.isArray(content)) {
        return estimateTokensFromText(JSON.stringify(content), 'input');
    }

    let total = 0;
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const type = String((part as any).type || '').toLowerCase();
        if (type === 'text' || type === 'input_text') {
            total += estimateTokensFromText((part as any).text || '', 'input');
            continue;
        }
        if (type === 'image_url') {
            const url = (part as any)?.image_url?.url;
            if (typeof url === 'string' && url.startsWith('data:')) {
                total += estimateTokensFromDataUrl(url, 'input');
            } else if (typeof url === 'string' && url.length > 0) {
                total += IMAGE_URL_FALLBACK_TOKENS;
            }
            continue;
        }
        if (type === 'input_audio') {
            const data = (part as any)?.input_audio?.data;
            if (typeof data === 'string' && data.length > 0) {
                total += estimateTokensFromBase64Payload(data, AUDIO_INPUT_TOKENS_PER_KB, AUDIO_MIN_TOKENS);
            } else {
                total += AUDIO_DATA_FALLBACK_TOKENS;
            }
            continue;
        }
        total += estimateTokensFromText(JSON.stringify(part), 'input');
    }

    return total;
}

function extractUsageTokens(usage: any): { promptTokens?: number; completionTokens?: number; totalTokens?: number } {
    if (!usage || typeof usage !== 'object') return {};

    const promptTokens = typeof usage.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : (typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined);
    const completionTokens = typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : (typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined);
    const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;

    return { promptTokens, completionTokens, totalTokens };
}

function createSseDataParser(onData: (data: string, eventName?: string) => void) {
    let buffer = '';
    let currentEvent = '';

    return (chunk: string) => {
        buffer += chunk;

        while (true) {
            const lineBreakIndex = buffer.indexOf('\n');
            if (lineBreakIndex === -1) break;

            let line = buffer.slice(0, lineBreakIndex);
            buffer = buffer.slice(lineBreakIndex + 1);

            if (line.endsWith('\r')) line = line.slice(0, -1);

            if (!line) {
                currentEvent = '';
                continue;
            }
            if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
                continue;
            }
            if (line.startsWith('data:')) {
                onData(line.slice(5).trimStart(), currentEvent || undefined);
            }
        }
    };
}

function isImageModelId(modelId: string): boolean {
    const normalized = String(modelId || '').toLowerCase();
    if (!normalized) return false;
    if (normalized.includes('embedding') || normalized.includes('transcribe')) return false;
    return normalized.includes('imagen') || normalized.includes('image') || normalized.includes('nano-banana');
}

function isNanoBananaModel(modelId: string): boolean {
    const normalized = String(modelId || '').toLowerCase();
    return normalized.includes('nano-banana');
}

function ensureNanoBananaModalities(modalities: any): string[] {
    const raw = Array.isArray(modalities) ? modalities : [];
    const normalized = raw.map((m) => String(m).toLowerCase().trim()).filter(Boolean);
    const set = new Set<string>(normalized);
    set.add('image');
    set.add('text');
    return Array.from(set);
}

function isNonChatModel(modelId: string): 'tts' | 'stt' | 'image-gen' | 'video-gen' | 'embedding' | false {
    const n = String(modelId || '').toLowerCase();
    if (n.startsWith('tts-') || n.includes('-tts')) return 'tts';
    if (n.startsWith('whisper') || n.includes('transcribe')) return 'stt';
    if (n.includes('grok-imagine-video') || n.includes('imagine-video')) return 'video-gen';
    if (
        n.startsWith('dall-e') ||
        n.startsWith('gpt-image') ||
        n.includes('gpt-image') ||
        n.includes('chatgpt-image') ||
        n.includes('image-gen') ||
        n.includes('imagegen') ||
        n.startsWith('imagen') ||
        n.includes('imagen') ||
        n.includes('nano-banana') ||
        n.includes('grok-imagine') ||
        n.includes('grok-2-image')
    ) return 'image-gen';
    if (n.includes('embedding')) return 'embedding';
    return false;
}

function formatAssistantContent(raw: string): string {
    if (typeof raw !== 'string') return '';
    if (raw.startsWith('data:image/')) {
        return `![generated image](${raw})`;
    }
    return raw;
}

function extractTextFromContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const textPart = content.find((part: any) =>
            part && (part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string'
        );
        if (textPart?.text) return textPart.text;
    }
    return '';
}

function extractInputAudioFromContent(content: any): { data: string; format: string } | null {
    if (!Array.isArray(content)) return null;
    const audioPart = content.find((part: any) =>
        part && part.type === 'input_audio' && part.input_audio
        && typeof part.input_audio.data === 'string'
        && typeof part.input_audio.format === 'string'
    );
    if (!audioPart) return null;
    return { data: audioPart.input_audio.data, format: audioPart.input_audio.format };
}

function extractImageUrlFromContent(content: any): string | null {
    if (!Array.isArray(content)) return null;
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const type = String(part.type || '').toLowerCase();
        if (type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            if (typeof url === 'string' && url.length > 0) return url;
        }
        if (type === 'input_image') {
            const url = typeof (part as any).image_url === 'string' ? (part as any).image_url : (part as any).image_url?.url;
            if (typeof url === 'string' && url.length > 0) return url;
        }
    }
    return null;
}

function extractTextFromMessages(rawMessages: any[]): string {
    if (!Array.isArray(rawMessages)) return '';
    const lastUser = rawMessages.filter(m => m?.role === 'user').pop();
    if (!lastUser) return '';
    return extractTextFromContent(lastUser.content);
}

function extractInputAudioFromMessages(rawMessages: any[]): { data: string; format: string } | null {
    if (!Array.isArray(rawMessages)) return null;
    for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
        const msg = rawMessages[i];
        const audio = extractInputAudioFromContent(msg?.content);
        if (audio) return audio;
    }
    return null;
}

function extractImageUrlFromMessages(rawMessages: any[]): string | null {
    if (!Array.isArray(rawMessages)) return null;
    for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
        const msg = rawMessages[i];
        const url = extractImageUrlFromContent(msg?.content);
        if (url) return url;
    }
    return null;
}

function extractTextFromResponsesInput(input: any): string {
    if (typeof input === 'string') return input;
    if (Array.isArray(input)) {
        for (const item of input) {
            const content = item?.content ?? item;
            const text = extractTextFromContent(content);
            if (text) return text;
        }
    }
    return '';
}

function extractInputAudioFromResponsesInput(input: any): { data: string; format: string } | null {
    if (Array.isArray(input)) {
        for (const item of input) {
            const content = item?.content ?? item;
            const audio = extractInputAudioFromContent(content);
            if (audio) return audio;
        }
    }
    return null;
}

function extractImageUrlFromResponsesInput(input: any): string | null {
    if (Array.isArray(input)) {
        for (const item of input) {
            const content = item?.content ?? item;
            const url = extractImageUrlFromContent(content);
            if (url) return url;
        }
    }
    return null;
}

function filterValidChatMessages(rawMessages: any): { role: string; content: any }[] {
    if (!Array.isArray(rawMessages)) return [];
    return rawMessages.filter((msg) => msg && typeof msg.role === 'string');
}

async function handleImageGenFallbackFromChatOrResponses(params: {
    modelId: string;
    prompt: string;
    requestBody: any;
    request: Request;
    response: Response;
    source: 'chat' | 'responses';
}): Promise<void> {
    const { modelId, prompt, requestBody, request, response, source } = params;

    if (!prompt) {
        if (!response.completed) {
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

    const capsOk = await enforceModelCapabilities(modelId, ['image_output'], response);
    if (!capsOk) return;

    const provider = await pickImageGenProviderKey(modelId, ['image_output']);
    if (!provider) {
        if (!response.completed) {
            response.status(503).json({ error: 'No available provider for image generation', timestamp: new Date().toISOString() });
        }
        return;
    }

    const upstreamUrl = `${provider.baseUrl}/v1/images/generations`;
    const upstreamRes = await fetchWithTimeout(upstreamUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
            model: modelId,
            prompt,
            n: typeof requestBody?.n === 'number' ? requestBody.n : 1,
            size: typeof requestBody?.size === 'string' ? requestBody.size : '1024x1024',
            quality: typeof requestBody?.quality === 'string' ? requestBody.quality : undefined,
            style: typeof requestBody?.style === 'string' ? requestBody.style : undefined,
            response_format: typeof requestBody?.response_format === 'string' ? requestBody.response_format : undefined,
        }),
    }, UPSTREAM_TIMEOUT_MS);

    if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        if (!response.completed) {
            response.status(upstreamRes.status).json({
                error: `Image generation upstream error: ${errText || upstreamRes.statusText}`,
                timestamp: new Date().toISOString(),
            });
        }
        return;
    }

    const resJson = await upstreamRes.json();
    const first = Array.isArray(resJson?.data) ? resJson.data[0] : undefined;
    const imageUrl = typeof first?.url === 'string' ? first.url : undefined;
    const imageB64 = typeof first?.b64_json === 'string' ? first.b64_json : undefined;
    const imageDataUrl = imageB64 ? `data:image/png;base64,${imageB64}` : undefined;
    const imageRef = imageUrl || imageDataUrl;
    const content = imageRef ? `![generated image](${imageRef})` : 'Image generation completed.';

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
        const created = Math.floor(Date.now() / 1000);
        const promptTokens = Math.ceil(prompt.length / 4);
        const totalTokens = promptTokens + 1;
        response.json({
            id: `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            object: 'response',
            created,
            model: modelId,
            output: [{ content: [{ type: 'output_text', text: content }] }],
            output_text: content,
            usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: totalTokens },
        });
    }

    const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
    await updateUserTokenUsage(tokenEstimate, request.apiKey!);
}

async function handleVideoGenFallbackFromChatOrResponses(params: {
    modelId: string;
    prompt: string;
    imageUrl?: string | null;
    requestBody: any;
    request: Request;
    response: Response;
    source: 'chat' | 'responses';
}): Promise<void> {
    const { modelId, prompt, imageUrl, requestBody, response, source } = params;

    if (!prompt) {
        if (!response.completed) {
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

    const provider = await pickVideoGenProviderKey(modelId);
    if (!provider) {
        if (!response.completed) {
            response.status(503).json({ error: 'No available provider for video generation', timestamp: new Date().toISOString() });
        }
        return;
    }

    const payload: Record<string, any> = {
        model: modelId,
        prompt,
    };

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
    }, UPSTREAM_TIMEOUT_MS);

    if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        if (!response.completed) {
            response.status(upstreamRes.status).json({
                error: `Video generation upstream error: ${errText || upstreamRes.statusText}`,
                timestamp: new Date().toISOString(),
            });
        }
        return;
    }

    const resJson = await upstreamRes.json().catch(() => ({}));
    const requestId = resJson?.request_id || resJson?.id;
    if (!requestId) {
        if (!response.completed) {
            response.status(502).json({ error: 'Video generation upstream response missing request_id.', timestamp: new Date().toISOString() });
        }
        return;
    }

    setVideoRequestCache(String(requestId), provider);

    const contentText = `Video generation started. Request ID: ${requestId}. Check /v1/videos/${requestId} for status.`;
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
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: contentText,
                    },
                    logprobs: null,
                    finish_reason: "stop",
                }
            ],
            usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            }
        };

        if (!response.completed) response.json(openaiResponse);
        return;
    }

    // responses API fallback
    if (wantsStream) {
        const responseId = `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
        try { (response as any).flushHeaders?.(); } catch {}

        response.write(`event: response.created\n`);
        response.write(`data: ${JSON.stringify({ id: responseId, object: 'response', created, model: modelId, output: [], output_text: '' })}\n\n`);

        response.write(`event: response.output_text.delta\n`);
        response.write(`data: ${JSON.stringify({ id: responseId, object: 'response', created, model: modelId, output_text_delta: contentText, output: [{ content: [{ type: 'output_text', text: contentText }] }] })}\n\n`);

        response.write(`event: response.completed\n`);
        response.write(`data: ${JSON.stringify({ id: responseId, object: 'response', created, model: modelId, output_text: contentText, output: [{ content: [{ type: 'output_text', text: contentText }] }], usage: { total_tokens: 0 } })}\n\n`);
        response.write(`data: [DONE]\n\n`);
        return response.end();
    }

    const responseBody = {
        id: `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        object: 'response',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        output: [{ content: [{ type: 'output_text', text: contentText }] }],
        output_text: contentText,
        usage: { total_tokens: 0 }
    };
    if (!response.completed) response.json(responseBody);
}

function normalizeInputAudio(audio: { data: string; format: string }): { buffer: Buffer; mimeType: string; extension: string } | null {
    let { data, format } = audio;
    let mimeType = format;

    if (typeof data === 'string' && data.startsWith('data:')) {
        const match = data.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
            mimeType = match[1];
            data = match[2];
        }
    }

    if (!mimeType) mimeType = 'audio/wav';
    if (!mimeType.includes('/')) mimeType = `audio/${mimeType}`;
    const extension = mimeType.split('/')[1] || 'wav';

    try {
        const buffer = Buffer.from(data, 'base64');
        if (buffer.length === 0) return null;
        return { buffer, mimeType, extension };
    } catch {
        return null;
    }
}

function summarizeUrlForLog(rawUrl: string): string {
    try {
        const u = new URL(rawUrl);
        const host = u.host || u.hostname;
        const path = u.pathname || '/';
        return `${u.protocol}//${host}${path}`;
    } catch {
        return rawUrl.slice(0, 120);
    }
}

function hostMatchesAllowlist(host: string): boolean {
    if (!IMAGE_FETCH_ALLOWED_HOSTS || IMAGE_FETCH_ALLOWED_HOSTS.length === 0) return true;
    const needle = host.toLowerCase();
    return IMAGE_FETCH_ALLOWED_HOSTS.some((entry) => {
        const allowed = entry.toLowerCase();
        if (!allowed) return false;
        if (allowed.startsWith('.')) {
            const suffix = allowed.slice(1);
            return needle === suffix || needle.endsWith(`.${suffix}`);
        }
        return needle === allowed;
    });
}

function isLocalHostname(host: string): boolean {
    const normalized = host.toLowerCase();
    return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local');
}

function isPrivateIpv4(ip: string): boolean {
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
    const [a, b, c, d] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast/reserved
    return false;
}

function isPrivateIpv6(ip: string): boolean {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
    if (normalized.startsWith('ff')) return true; // multicast
    if (normalized.startsWith('2001:db8')) return true; // documentation
    if (normalized.startsWith('::ffff:')) {
        const ipv4 = normalized.slice('::ffff:'.length);
        if (ipv4) return isPrivateIpv4(ipv4);
    }
    return false;
}

function isPrivateIp(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 4) return isPrivateIpv4(ip);
    if (family === 6) return isPrivateIpv6(ip);
    return false;
}

async function resolveHostAddresses(host: string): Promise<string[]> {
    try {
        const results = await dns.lookup(host, { all: true, verbatim: true });
        return results.map((entry) => entry.address).filter(Boolean);
    } catch {
        return [];
    }
}

async function validateImageFetchUrl(rawUrl: string): Promise<{ ok: boolean; reason?: string; parsed?: URL }> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { ok: false, reason: 'invalid_url' };
    }

    const protocol = parsed.protocol.replace(':', '').toLowerCase();
    if (!IMAGE_FETCH_ALLOWED_PROTOCOLS.includes(protocol)) {
        return { ok: false, reason: 'protocol_not_allowed' };
    }

    const hostname = parsed.hostname;
    if (!hostname) return { ok: false, reason: 'missing_host' };
    if (!hostMatchesAllowlist(hostname)) return { ok: false, reason: 'host_not_allowed' };

    if (!IMAGE_FETCH_ALLOW_PRIVATE) {
        if (isLocalHostname(hostname)) return { ok: false, reason: 'local_hostname' };
        const directIpType = net.isIP(hostname);
        if (directIpType) {
            if (isPrivateIp(hostname)) return { ok: false, reason: 'private_ip' };
        } else {
            const addresses = await resolveHostAddresses(hostname);
            if (addresses.length === 0) return { ok: false, reason: 'dns_failed' };
            if (addresses.some((addr) => isPrivateIp(addr))) return { ok: false, reason: 'private_ip' };
        }
    }

    return { ok: true, parsed };
}

async function readResponseBodyWithLimit(
    response: globalThis.Response,
    maxBytes: number,
    controller?: AbortController
): Promise<Buffer> {
    const contentLength = response.headers.get('content-length');
    if (maxBytes > 0 && contentLength) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > maxBytes) {
            controller?.abort(new Error('Image exceeds max size.'));
            throw new Error('Image exceeds max size.');
        }
    }

    if (!response.body) {
        return Buffer.alloc(0);
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (maxBytes > 0 && total > maxBytes) {
            try { await reader.cancel(); } catch {}
            controller?.abort(new Error('Image exceeds max size.'));
            throw new Error('Image exceeds max size.');
        }
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

async function fetchImageAsDataUrl(
    imageUrl: string,
    authHeader?: string,
    refererOverride?: string
): Promise<{ dataUrl: string; contentType: string; bytes: number } | null> {
    const validation = await validateImageFetchUrl(imageUrl);
    if (!validation.ok || !validation.parsed) {
        console.warn(`[ImageProxy] Skipping image fetch (${validation.reason || 'blocked'}): ${summarizeUrlForLog(imageUrl)}`);
        return null;
    }

    const initialHost = validation.parsed.hostname.toLowerCase();
    let currentUrl = validation.parsed.toString();
    const controller = new AbortController();
    const timeoutId = IMAGE_FETCH_TIMEOUT_MS > 0
        ? setTimeout(() => controller.abort(new Error('Image fetch timed out.')), IMAGE_FETCH_TIMEOUT_MS)
        : null;

    try {
        for (let hop = 0; hop <= IMAGE_FETCH_MAX_REDIRECTS; hop++) {
            const currentValidation = hop === 0 ? validation : await validateImageFetchUrl(currentUrl);
            if (!currentValidation.ok || !currentValidation.parsed) {
                console.warn(`[ImageProxy] Redirect blocked (${currentValidation.reason || 'blocked'}): ${summarizeUrlForLog(currentUrl)}`);
                return null;
            }

            const headers: Record<string, string> = {};
            const currentHost = currentValidation.parsed.hostname.toLowerCase();
            if (IMAGE_FETCH_USER_AGENT) headers['User-Agent'] = IMAGE_FETCH_USER_AGENT;
            const effectiveReferer = refererOverride || IMAGE_FETCH_REFERER;
            if (effectiveReferer) headers['Referer'] = effectiveReferer;
            if (IMAGE_FETCH_FORWARD_AUTH && authHeader && currentHost === initialHost) {
                headers['Authorization'] = authHeader;
            }

            if (LOG_SENSITIVE_PAYLOADS) {
                console.log(`[ImageProxy] Fetching image from URL: ${currentUrl}`);
            } else {
                console.log(`[ImageProxy] Fetching image from host: ${currentHost}`);
            }

            const res = await fetch(currentUrl, {
                method: 'GET',
                headers,
                redirect: 'manual',
                signal: controller.signal,
            });

            if (res.status >= 300 && res.status < 400) {
                const location = res.headers.get('location');
                if (!location) {
                    console.warn(`[ImageProxy] Redirect without location header from ${summarizeUrlForLog(currentUrl)}`);
                    return null;
                }
                currentUrl = new URL(location, currentUrl).toString();
                continue;
            }

            if (!res.ok) {
                console.warn(`[ImageProxy] Failed to fetch image: ${res.status} ${res.statusText}`);
                return null;
            }

            const buffer = await readResponseBodyWithLimit(res, IMAGE_FETCH_MAX_BYTES, controller);
            const contentType = res.headers.get('content-type') || detectMimeTypeFromBuffer(buffer) || 'image/jpeg';
            const base64 = buffer.toString('base64');
            return {
                dataUrl: `data:${contentType};base64,${base64}`,
                contentType,
                bytes: buffer.length,
            };
        }

        console.warn(`[ImageProxy] Too many redirects for ${summarizeUrlForLog(imageUrl)}`);
        return null;
    } catch (err: any) {
        if (controller.signal.aborted) {
            console.warn(`[ImageProxy] Aborted fetch for ${summarizeUrlForLog(imageUrl)}: ${err?.message || 'aborted'}`);
        } else {
            console.error(`[ImageProxy] Error fetching image:`, err);
        }
        return null;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function inlineImageUrls(messages: any[], authHeader?: string, refererOverride?: string) {
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
        if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part && part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('http')) {
                    const result = await fetchImageAsDataUrl(part.image_url.url, authHeader, refererOverride);
                    if (result) {
                        part.image_url.url = result.dataUrl;
                        console.log(`[ImageProxy] Successfully inlined image. Type: ${result.contentType}, Size: ${result.bytes}`);
                    }
                }
            }
        }
    }
}

function detectMimeTypeFromBuffer(buffer: Buffer): string | null {
    if (buffer.length < 2) return null;
    // JPEG: FF D8 (SOI marker)
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
    // WEBP: RIFF ... WEBP (offset 8)
    if (buffer.length > 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp';
    
    return null; // No supported image signature found
}

function detectMimeTypeFromBase64(base64: string): string | null {
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('iVBORw')) return 'image/png';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    if (base64.startsWith('UklGR')) return 'image/webp';
    return null; 
}

function isLikelyBase64(buffer: Buffer): boolean {
    if (buffer.length === 0) return false;
    // Check first 100 bytes (optimization)
    const len = Math.min(buffer.length, 100);
    for (let i = 0; i < len; i++) {
        const byte = buffer[i];
        const isBase64Char = 
            (byte >= 65 && byte <= 90) || // A-Z
            (byte >= 97 && byte <= 122) || // a-z
            (byte >= 48 && byte <= 57) || // 0-9
            byte === 43 || byte === 47 || byte === 61 || // + / =
            byte === 10 || byte === 13 || byte === 32; // whitespace
        if (!isBase64Char) return false;
    }
    return true;
}

// Naive multipart parser to handle clients sending files to chat/completions
function parseMultipartBody(buffer: Buffer, boundary: string): { fields: Record<string, string>; files: { name: string; type: string; data: Buffer }[] } {
    const result = { fields: {} as Record<string, string>, files: [] as any[] };
    const delimiter = Buffer.from(`--${boundary}`);
    let start = 0;
    
    let idx = buffer.indexOf(delimiter, start);
    if (idx === -1) return result; 
    
    while (idx !== -1) {
        start = idx + delimiter.length;
        if (buffer[start] === 45 && buffer[start + 1] === 45) break; 
        
        const nextIdx = buffer.indexOf(delimiter, start);
        const end = (nextIdx === -1) ? buffer.length : nextIdx;
        
        const partBuffer = buffer.subarray(start, end);
        let headerStart = 0;
        // CRLF is 13, 10.
        // Check for CRLF at start of part (after boundary)
        if (partBuffer[0] === 13 && partBuffer[1] === 10) headerStart = 2;
        else if (partBuffer[0] === 10) headerStart = 1; // LF only handling
        
        const headerEnd = partBuffer.indexOf('\r\n\r\n', headerStart);
        if (headerEnd !== -1) {
            const headers = partBuffer.subarray(headerStart, headerEnd).toString('utf8');
            // Safely remove trailing CRLF/LF from body only if explicitly present
            // partBuffer ends exactly at the start of the next boundary sequence
            let bodyEnd = partBuffer.length;
            if (partBuffer.length >= 2 && partBuffer[bodyEnd - 2] === 13 && partBuffer[bodyEnd - 1] === 10) {
                bodyEnd -= 2;
            } else if (partBuffer.length >= 1 && partBuffer[bodyEnd - 1] === 10) {
                bodyEnd -= 1;
            }

            const body = partBuffer.subarray(headerEnd + 4, bodyEnd);
            
            const nameMatch = headers.match(/name="([^"]+)"/);
            const filenameMatch = headers.match(/filename="([^"]+)"/);
            const contentTypeMatch = headers.match(/Content-Type: (.+)/i);
            const transferEncodingMatch = headers.match(/Content-Transfer-Encoding: (.+)/i);
            
            if (filenameMatch) {
                let contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
                let fileData = body;

                console.log(`[Multipart] File part detected. Name: ${filenameMatch[1]}, Content-Type: ${contentType}, Size: ${body.length}`);

                // Handle base64 transfer encoding (decode to binary storage)
                if (transferEncodingMatch && transferEncodingMatch[1].trim().toLowerCase() === 'base64') {
                    console.log('[Multipart] Decoding base64 transfer encoding.');
                    const text = body.toString('utf8').replace(/\s+/g, '');
                    fileData = Buffer.from(text, 'base64');
                }

                if (contentType === 'application/octet-stream') {
                    contentType = detectMimeTypeFromBuffer(fileData) || 'application/octet-stream';
                    console.log(`[Multipart] Detected MIME from buffer: ${contentType}`);
                }

                result.files.push({
                    name: filenameMatch[1],
                    type: contentType,
                    data: fileData
                });
            } else if (nameMatch) {
                result.fields[nameMatch[1]] = body.toString('utf8');
            }
        }
        
        idx = nextIdx;
    }
    return result;
}

// --- Routes ---
 
// Generate Key Route - Handler becomes async
openaiRouter.post('/generate_key', authAndUsageMiddleware, async (request: Request, response: Response) => {
  // Check if middleware failed (e.g., if it didn't attach data)
  if (!request.apiKey || request.userRole === undefined) {
       await logError({ message: 'Authentication failed in /generate_key route after middleware' }, request);
       if (!response.completed) {
         return response.status(401).json({ error: 'Authentication failed', timestamp: new Date().toISOString() }); 
       } else { return; }
  }
  try {
    if (request.userRole !== 'admin') {
        await logError({ message: 'Forbidden: Non-admin attempt to generate key', userId: request.userId }, request);
        if (!response.completed) {
          return response.status(403).json({ error: 'Forbidden', timestamp: new Date().toISOString() });
        } else { return; }
    }
    const body = await request.json();
    const { userId, role = 'user', tier = 'free' } = body || {};
    if (!userId || typeof userId !== 'string') {
        await logError({ message: 'Bad Request: userId required for key generation' }, request);
        if (!response.completed) {
           return response.status(400).json({ error: 'Bad Request: userId required', timestamp: new Date().toISOString() });
        } else { return; }
    }

    const roleStr = String(role);
    if (roleStr !== 'admin' && roleStr !== 'user') {
        if (!response.completed) {
            return response.status(400).json({ error: 'Bad Request: role must be "admin" or "user"', timestamp: new Date().toISOString() });
        } else { return; }
    }

    const tierStr = String(tier);
    if (!(tierStr in tiersData)) {
        if (!response.completed) {
            return response.status(400).json({ error: `Bad Request: tier '${tierStr}' not found`, timestamp: new Date().toISOString() });
        } else { return; }
    }

    const newUserApiKey = await generateUserApiKey(userId, roleStr as 'admin' | 'user', tierStr as keyof typeof tiersData);
    response.json({ apiKey: newUserApiKey, role: roleStr, tier: tierStr });
  } catch (error: any) {
    await logError(error, request);
    console.error('Generate key error:', error);
    const timestamp = new Date().toISOString();
    let status = 500;
    let msg = 'Internal Server Error';
    let ref: string | undefined = 'Failed to generate key.';
    if (error.message.includes('already has')) { status = 409; msg = error.message; ref = undefined; }
    if (error instanceof SyntaxError) { status = 400; msg = 'Invalid JSON'; ref = undefined; }
    if (!response.completed) {
      const responseBody: { error: string; reference?: string; timestamp: string } = {
          error: msg,
          timestamp
      };
      if (ref) {
          responseBody.reference = ref;
      }
      response.status(status).json(responseBody);
    } else {
        // Cannot send response, middleware already handled it or response completed.
        // No explicit return needed here if void is acceptable.
    }
  }
});
 
 
// Apply Middlewares - order matters
// Fix: Remove '/v1' prefix since the router is already mounted at '/v1' in server.ts
openaiRouter.use('/', authAndUsageMiddleware); 
// Fix: Remove '/v1' prefix from the path
openaiRouter.use('/chat/completions', rateLimitMiddleware); 
openaiRouter.use('/responses', rateLimitMiddleware);
openaiRouter.use('/interactions', rateLimitMiddleware);
openaiRouter.use('/audio', rateLimitMiddleware);
openaiRouter.use('/images', rateLimitMiddleware);
openaiRouter.use('/videos', rateLimitMiddleware);
openaiRouter.use('/embeddings', rateLimitMiddleware);

 
// Chat Completions Route - Handler is already async
openaiRouter.post('/chat/completions', async (request: Request, response: Response) => {
   // Check if middleware failed
   if (!request.apiKey || !request.tierLimits) {
        await logError({ message: 'Authentication or configuration failed in /v1/chat/completions after middleware' }, request);
        if (!response.completed) {
           return response.status(401).json({ error: 'Authentication or configuration failed', timestamp: new Date().toISOString() }); 
        } else { return; }
   }
  try {
    const userApiKey = request.apiKey!; 
    const tierLimits = request.tierLimits!; 
    
    let requestBody: any;
    try {
        requestBody = await request.json();
    } catch (parseError) {
        // Recover from non-JSON payloads (e.g. multipart with images)
        const contentType = request.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            const boundary = contentType.split('boundary=')[1]?.trim();
            if (boundary) {
                const rawBuffer = await request.buffer();
                const parsed = parseMultipartBody(rawBuffer, boundary);
                
                // Reconstruct a valid chat request
                requestBody = {};
                if (parsed.fields.model) requestBody.model = parsed.fields.model;
                if (parsed.fields.messages) {
                    try { requestBody.messages = JSON.parse(parsed.fields.messages); } catch {}
                }
                if (parsed.fields.stream) requestBody.stream = parsed.fields.stream === 'true';

                // Inject files into the last user message
                if (parsed.files.length > 0 && requestBody.messages && Array.isArray(requestBody.messages)) {
                    const lastMsg = requestBody.messages[requestBody.messages.length - 1];
                    if (lastMsg && lastMsg.role === 'user') {
                        if (typeof lastMsg.content === 'string') {
                            lastMsg.content = [{ type: 'text', text: lastMsg.content }];
                        }
                        if (Array.isArray(lastMsg.content)) {
                            parsed.files.forEach(f => {
                                const base64Data = f.data.toString('base64');
                                if (LOG_SENSITIVE_PAYLOADS) {
                                    console.log(`[Multipart] Injecting image. Type: ${f.type}, Base64Len: ${base64Data.length}, Prefix: ${base64Data.substring(0, 50)}...`);
                                } else {
                                    console.log(`[Multipart] Injecting image. Type: ${f.type}, Size: ${f.data.length}`);
                                }
                                lastMsg.content.push({
                                    type: 'image_url',
                                    image_url: { url: `data:${f.type};base64,${base64Data}` }
                                });
                            });
                        }
                    }
                }
                if (!requestBody.model) {
                    if (!response.completed) return response.status(400).json({ error: 'Bad Request: Model field is required for multipart uploads.', timestamp: new Date().toISOString() });
                    return;
                }
                if (!requestBody.messages) requestBody.messages = [{ role: 'user', content: 'Image uploaded' }]; // Fallback
            }
        } else {
            // Check if it's raw base64 or raw binary
            try {
                const rawBuffer = await request.buffer();
                if (LOG_SENSITIVE_PAYLOADS) {
                    console.log(`[RawFallback] Buffer size: ${rawBuffer.length}, First 50 bytes: ${rawBuffer.subarray(0, 50).toString('hex')}`);
                } else {
                    console.log(`[RawFallback] Buffer size: ${rawBuffer.length}`);
                }
                if (rawBuffer.length > 10) {
                    const firstChar = rawBuffer[0];
                    // Check if JSON-like start ({ or [)
                    if (firstChar === 123 || firstChar === 91) {
                        throw parseError; // Likely malformed JSON, let it fail
                    }

                    // Check if strictly base64 text
                    let isBase64 = isLikelyBase64(rawBuffer);
                    
                    let mimeType = 'image/jpeg';
                    let base64Data = '';
                    const utf8Text = rawBuffer.toString('utf8');

                    if (utf8Text.startsWith('data:image')) {
                        console.log('[RawFallback] Detected Data URI body.');
                        // Handle raw body as Data URI
                        const commaIdx = utf8Text.indexOf(',');
                        if (commaIdx !== -1) {
                            base64Data = utf8Text.slice(commaIdx + 1).replace(/\s+/g, '');
                            const detectedMime = detectMimeTypeFromBase64(base64Data);
                            
                            if (detectedMime) {
                                mimeType = detectedMime;
                            } else {
                                const prefix = utf8Text.slice(0, commaIdx);
                                const mimeMatch = prefix.match(/data:([^;]+)/);
                                mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                            }
                        }
                    } else if (isBase64) {
                        console.log('[RawFallback] Detected Base64 text body.');
                        // Decode raw text to binary and re-encode to standard base64 to ensure validity
                        try {
                            base64Data = Buffer.from(utf8Text, 'base64').toString('base64');
                        } catch {
                            base64Data = utf8Text.replace(/\s+/g, '');
                        }
                        mimeType = detectMimeTypeFromBase64(base64Data) || 'image/jpeg';
                    } else {
                        console.log('[RawFallback] Detected Binary body.');
                        // Treat as raw binary
                        base64Data = rawBuffer.toString('base64');
                        mimeType = detectMimeTypeFromBuffer(rawBuffer) || 'image/jpeg';
                    }

                    if (LOG_SENSITIVE_PAYLOADS) {
                        console.log(`[RawFallback] Type: ${mimeType}, Base64Len: ${base64Data.length}, Prefix: ${base64Data.substring(0, 50)}...`);
                    } else {
                        console.log(`[RawFallback] Type: ${mimeType}, Base64Len: ${base64Data.length}`);
                    }

                    // Use model from query if available, otherwise fail
                    const queryModel = (request.query && typeof request.query.model === 'string' && request.query.model) 
                        ? request.query.model 
                        : null;
                    
                    if (!queryModel) {
                        if (!response.completed) response.status(400).json({ error: 'Bad Request: Model parameter is required for raw uploads.', timestamp: new Date().toISOString() });
                        return;
                    }
                    
                    requestBody = {
                        model: queryModel,
                        messages: [{
                            role: 'user',
                            content: [
                                { type: 'text', text: 'Analyze this image.' },
                                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }
                            ]
                        }]
                    };
                } else {
                    throw parseError;
                }
            } catch {
                throw parseError;
            }
        }
        if (!requestBody) throw parseError;
    }

    const modelHint = typeof requestBody?.model === 'string' ? requestBody.model : '';
    if (
        (!Array.isArray(requestBody?.messages) || requestBody.messages.length === 0) &&
        typeof requestBody?.prompt === 'string' &&
        isNonChatModel(modelHint) === 'image-gen'
    ) {
        requestBody.messages = [{ role: 'user', content: requestBody.prompt }];
    }

    const result = extractMessageFromRequestBody(requestBody);
    let { messages: rawMessages, model: modelId } = result;
    rawMessages = filterValidChatMessages(rawMessages);
    if (rawMessages.length === 0) {
        if (!response.completed) {
            return response.status(400).json({
                error: {
                    message: 'Bad Request: messages must include at least one message with a role.',
                    type: 'invalid_request_error',
                    param: 'messages',
                    code: 'invalid_messages',
                },
                timestamp: new Date().toISOString(),
            });
        }
        return;
    }

    const imageFetchReferer = normalizeImageFetchReferer(
        getHeaderValue(request.headers, 'x-image-fetch-referer') || getHeaderValue(request.headers, 'x-image-referer')
    );

    // Inline HTTP image URLs to base64 to avoid OpenAI fetching errors on private/local URLs
    await inlineImageUrls(rawMessages, request.headers['authorization'], imageFetchReferer);

    // Sanitize image URLs in messages (strip whitespace and normalize base64 to standard format)
    if (rawMessages && Array.isArray(rawMessages)) {
        rawMessages.forEach(msg => {
            if (Array.isArray(msg.content)) {
                msg.content.forEach((part: any) => {
                    if (part && part.type === 'image_url' && typeof part.image_url?.url === 'string') {
                        if (part.image_url.url.startsWith('data:')) {
                            const dataUri = part.image_url.url;
                            const commaIdx = dataUri.indexOf(',');
                            if (commaIdx !== -1) {
                                const prefix = dataUri.slice(0, commaIdx); // e.g. data:image/jpeg;base64
                                const rawBase64 = dataUri.slice(commaIdx + 1);
                                // Normalize base64: decode to binary and re-encode to standard base64 (fixes url-safe, padding, whitespace)
                                try {
                                    const cleanBase64 = Buffer.from(rawBase64, 'base64').toString('base64');
                                    // Detect actual MIME type from content (ignore client claim if incorrect)
                                    const detectedMime = detectMimeTypeFromBase64(cleanBase64);
                                    // Extract declared mime for fallback
                                    const declaredMime = prefix.split(':')[1]?.split(';')[0] || 'image/jpeg';
                                    
                                    part.image_url.url = `data:${detectedMime || declaredMime};base64,${cleanBase64}`;
                                } catch (e) {
                                    console.warn('Failed to normalize base64 image data:', e);
                                    // Fallback to simple whitespace stripping if re-encoding fails
                                    part.image_url.url = part.image_url.url.replace(/\s+/g, '');
                                }
                            }
                        }
                    }
                });
            }
        });
    }

    const stream = Boolean(requestBody.stream);

    if (requestBody?.interaction) {
        const interactionBody = requestBody.interaction;
        const input = typeof interactionBody?.input === 'string'
            ? interactionBody.input
            : (typeof interactionBody?.input === 'object' ? JSON.stringify(interactionBody.input) : '');
        const modelRaw = typeof interactionBody?.model === 'string'
            ? interactionBody.model
            : (typeof requestBody?.model === 'string' ? requestBody.model : '');
        if (!modelRaw || !input) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: model and input are required for interactions mapping', timestamp: new Date().toISOString() });
            return;
        }

        const normalized = normalizeDeepResearchModel(modelRaw, typeof interactionBody?.agent === 'string' ? interactionBody.agent : undefined);
        const interactionRequest: InteractionRequest = {
            model: normalized.model,
            input,
            tools: Array.isArray(interactionBody.tools) ? interactionBody.tools : undefined,
            response_format: interactionBody.response_format && typeof interactionBody.response_format === 'object' ? interactionBody.response_format : undefined,
            generation_config: interactionBody.generation_config && typeof interactionBody.generation_config === 'object' ? interactionBody.generation_config : undefined,
            agent: normalized.agent,
        };

        const secret = getInteractionsSigningSecret();
        const interactionId = createInteractionToken(
            interactionRequest,
            request.apiKey,
            'openai-chat',
            INTERACTIONS_TOKEN_TTL_SECONDS,
            secret,
            modelRaw
        );

        const responseBody = {
            id: `chatcmpl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelRaw,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: '' },
                finish_reason: 'in_progress',
            }],
            interaction: { id: interactionId },
        };

        return response.json(responseBody);
    }

    // --- Block non-chat models with helpful error (or auto-fallback for image generation) ---
    const nonChatType = isNonChatModel(modelId);
    if (nonChatType) {
        if (nonChatType === 'image-gen' && !isNanoBananaModel(modelId)) {
            const prompt = typeof requestBody?.prompt === 'string'
                ? requestBody.prompt
                : extractTextFromMessages(rawMessages);
            await handleImageGenFallbackFromChatOrResponses({
                modelId,
                prompt,
                requestBody,
                request,
                response,
                source: 'chat',
            });
            return;
        }
        if (nonChatType === 'video-gen') {
            const prompt = typeof requestBody?.prompt === 'string'
                ? requestBody.prompt
                : extractTextFromMessages(rawMessages);
            const imageUrl = extractImageUrlFromMessages(rawMessages);
            await handleVideoGenFallbackFromChatOrResponses({
                modelId,
                prompt,
                imageUrl,
                requestBody,
                request,
                response,
                source: 'chat',
            });
            return;
        }
        if (!(nonChatType === 'image-gen' && isNanoBananaModel(modelId))) {
            const endpointMap: Record<string, string> = {
                tts: '/v1/audio/speech',
                stt: '/v1/audio/transcriptions',
                'image-gen': '/v1/images/generations',
                'video-gen': '/v1/videos/generations',
                embedding: '/v1/embeddings',
            };
            const correctEndpoint = endpointMap[nonChatType] || 'the dedicated endpoint';
            if (!response.completed) return response.status(400).json({
                error: {
                    message: `'${modelId}' is not a chat model and cannot be used with /v1/chat/completions. Use ${correctEndpoint} instead.`,
                    type: 'invalid_request_error',
                    param: 'model',
                    code: 'model_not_supported',
                },
                timestamp: new Date().toISOString(),
            });
            return;
        }
    }

    const effectiveStream = stream && !isImageModelId(modelId);
    
    // Per-request token check logic (remains commented out or implement as needed)

    const sharedMessageOptions: Partial<IMessage> = {
        system: requestBody.system,
        response_format: requestBody.response_format,
        max_tokens: typeof requestBody.max_tokens === 'number' ? requestBody.max_tokens : undefined,
        max_output_tokens: typeof requestBody.max_output_tokens === 'number' ? requestBody.max_output_tokens : undefined,
        temperature: typeof requestBody.temperature === 'number' ? requestBody.temperature : undefined,
        top_p: typeof requestBody.top_p === 'number' ? requestBody.top_p : undefined,
        metadata: requestBody.metadata,
        modalities: Array.isArray(requestBody.modalities) ? requestBody.modalities : undefined,
        audio: requestBody.audio,
        tools: Array.isArray(requestBody.tools) ? requestBody.tools : undefined,
        tool_choice: requestBody.tool_choice,
        reasoning: requestBody.reasoning,
        instructions: requestBody.instructions,
    };
    if (isNanoBananaModel(modelId)) {
        sharedMessageOptions.modalities = ensureNanoBananaModalities(sharedMessageOptions.modalities);
    }

    const formattedMessages: IMessage[] = rawMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
        model: { id: modelId },
        ...sharedMessageOptions,
        image_fetch_referer: imageFetchReferer,
    }));
 
    if (effectiveStream) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
        
        const streamHandler = messageHandler.handleStreamingMessages(formattedMessages, modelId, userApiKey);
        const started = Date.now();
        const requestId = `chatcmpl-${Date.now()}`;
        
        let totalTokenUsage = 0;
        let passthroughHandled = false;
        let fallbackToNormalized = false;
        let promptTokensFromUsage: number | undefined;
        let completionTokensFromUsage: number | undefined;
        let streamOutputText = '';

        for await (const result of streamHandler) {
            if (result.type === 'passthrough') {
                if (result?.passthrough?.mode !== 'openai-chat-sse') {
                    console.log(`[StreamPassthrough] Fallback used for /chat/completions due to mode mismatch (${result?.passthrough?.mode || 'unknown'}).`);
                    try { result?.passthrough?.upstream?.destroy?.(); } catch {}
                    fallbackToNormalized = true;
                    break;
                }

                passthroughHandled = true;
                console.log(`[StreamPassthrough] Forwarding raw upstream SSE for /chat/completions via ${result.providerId}.`);
                let forwardedAnyBytes = false;

                const parser = createSseDataParser((dataLine) => {
                    if (!dataLine || dataLine === '[DONE]') return;
                    try {
                        const parsed = JSON.parse(dataLine);
                        const deltaText = parsed?.choices?.[0]?.delta?.content;
                        if (typeof deltaText === 'string') streamOutputText += deltaText;

                        const usage = extractUsageTokens(parsed?.usage);
                        if (typeof usage.promptTokens === 'number') promptTokensFromUsage = usage.promptTokens;
                        if (typeof usage.completionTokens === 'number') completionTokensFromUsage = usage.completionTokens;
                        if (typeof usage.totalTokens === 'number') totalTokenUsage = usage.totalTokens;
                    } catch {
                        // Ignore malformed passthrough SSE data lines for accounting sidecar parsing.
                    }
                });

                try {
                    for await (const rawChunk of result.passthrough.upstream) {
                        const chunkBuffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                        if (chunkBuffer.length > 0) forwardedAnyBytes = true;
                        response.write(chunkBuffer);
                        parser(chunkBuffer.toString('utf8'));
                    }
                } catch (passthroughPipeError: any) {
                    if (!forwardedAnyBytes) {
                        console.warn(`[StreamPassthrough] Fallback used for /chat/completions due to passthrough pipe error before first byte: ${passthroughPipeError?.message || 'unknown error'}`);
                        fallbackToNormalized = true;
                        passthroughHandled = false;
                        break;
                    }
                    throw passthroughPipeError;
                }
                break;
            } else if (result.type === 'chunk') {
                const openaiStreamChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: { content: result.chunk },
                        finish_reason: null
                    }]
                };
                response.write(`data: ${JSON.stringify(openaiStreamChunk)}\n\n`);
            } else if (result.type === 'final') {
                // Capture final metrics from the stream
                if (result.tokenUsage) totalTokenUsage = result.tokenUsage;
            }
        }

        if (fallbackToNormalized) {
            const fallbackStreamHandler = messageHandler.handleStreamingMessages(formattedMessages, modelId, userApiKey, { disablePassthrough: true });
            for await (const fallbackResult of fallbackStreamHandler) {
                if (fallbackResult.type === 'chunk') {
                    const openaiStreamChunk = {
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(started / 1000),
                        model: modelId,
                        choices: [{
                            index: 0,
                            delta: { content: fallbackResult.chunk },
                            finish_reason: null
                        }]
                    };
                    response.write(`data: ${JSON.stringify(openaiStreamChunk)}\n\n`);
                } else if (fallbackResult.type === 'final') {
                    if (fallbackResult.tokenUsage) totalTokenUsage = fallbackResult.tokenUsage;
                }
            }
        }

        if (passthroughHandled) {
            if (totalTokenUsage <= 0) {
                const promptEstimate = typeof promptTokensFromUsage === 'number' ? promptTokensFromUsage : formattedMessages.reduce((sum, msg) => {
                    return sum + estimateTokensFromContent(msg.content);
                }, 0);
                const completionEstimate = typeof completionTokensFromUsage === 'number' ? completionTokensFromUsage : estimateTokensFromText(streamOutputText);
                totalTokenUsage = promptEstimate + completionEstimate;
            }

            await updateUserTokenUsage(totalTokenUsage, userApiKey);
            if (!response.completed) return response.end();
            return;
        }
        
        await updateUserTokenUsage(totalTokenUsage, userApiKey);
        
        const finalChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(started / 1000),
            model: modelId,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop'
            }]
        };
        response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        response.write(`data: [DONE]\n\n`);
        return response.end();

    } else {
        // messageHandler call is already async
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
        const assistantContent = formatAssistantContent(result.response);
    
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const promptTokensUsed = typeof result.promptTokens === 'number' ? result.promptTokens : undefined;
        const completionTokensUsed = typeof result.completionTokens === 'number' ? result.completionTokens : undefined;
        await updateUserTokenUsage(totalTokensUsed, userApiKey); 
    
        // --- Format response strictly like OpenAI --- 
        const openaiResponse = {
            id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000), // Unix timestamp
            model: modelId,
            // system_fingerprint: null, // OpenAI typically includes this. Set to null if not available.
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: assistantContent,
                    },
                    logprobs: null, // OpenAI includes this, set to null if not applicable
                    finish_reason: "stop", // Assuming stop as default
                }
            ],
            usage: {
                prompt_tokens: promptTokensUsed,
                completion_tokens: completionTokensUsed,
                total_tokens: totalTokensUsed
            }
            // Custom fields _latency_ms and _provider_id are removed
        };

        response.json(openaiResponse);
    }
 
  } catch (error: any) { 
    await logError(error, request);
    const errorText = String(error?.message || '');
    console.error('Chat completions error:', errorText, error.stack);
    const timestamp = new Date().toISOString();
    let statusCode = 500;
    let clientMessage = 'Internal Server Error';
    let clientReference = 'An unexpected error occurred while processing your chat request.';

    if (errorText.startsWith('Invalid request') || errorText.startsWith('Failed to parse')) {
        statusCode = 400;
        clientMessage = `Bad Request: ${errorText}`;
    } else if (error instanceof SyntaxError) {
        statusCode = 400;
        clientMessage = 'Invalid JSON';
    } else if (errorText.includes('Unauthorized') || errorText.includes('limit reached')) {
        statusCode = errorText.includes('limit reached') ? 429 : 401;
        clientMessage = errorText;
    } else if (
        errorText.toLowerCase().includes('requires more credits') ||
        errorText.toLowerCase().includes('insufficient credits') ||
        errorText.toLowerCase().includes('can only afford') ||
        errorText.includes('status 402')
    ) {
        statusCode = 402;
        clientMessage = 'Payment Required: insufficient credits for the requested max_tokens. Reduce max_tokens or add credits to the provider key.';
    } else if (errorText.toLowerCase().includes('model not found') || errorText.toLowerCase().includes('model_not_found')) {
        statusCode = 404;
        clientMessage = 'Not Found: model does not exist or you do not have access to it.';
    } else if (errorText.toLowerCase().includes('image exceeds') || errorText.toLowerCase().includes('image exceeds 5 mb')) {
        statusCode = 400;
        clientMessage = 'Bad Request: image exceeds the provider size limit. Please resize or compress the image before sending.';
    } else if (errorText.includes('fetching image from URL') || errorText.includes('image_url')) {
        statusCode = 400;
        clientMessage = 'Bad Request: image_url could not be fetched by the provider. Use a public, non-expiring URL or pass the image as base64 data.';
    } else if (errorText.includes('No suitable providers')) {
        statusCode = 503;
        clientMessage = errorText;
    } else if (errorText.includes('Provider') && errorText.includes('failed')) {
        statusCode = 502;
        clientMessage = errorText;
    }
    
    if (!response.completed) {
       if (statusCode === 500) {
           response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
       } else {
           response.status(statusCode).json({ error: clientMessage, timestamp });
       }
    } else { return; }
  }
});

openaiRouter.post('/responses', async (request: Request, response: Response) => {
    if (!request.apiKey || !request.tierLimits) {
        await logError({ message: 'Authentication or configuration failed in /v1/responses after middleware' }, request);
        if (!response.completed) {
           return response.status(401).json({ error: 'Authentication or configuration failed', timestamp: new Date().toISOString() });
        } else { return; }
    }

    try {
        const userApiKey = request.apiKey!;
        const requestBody = await request.json();

        if (requestBody?.interaction) {
            const interactionBody = requestBody.interaction;
            const input = typeof interactionBody?.input === 'string'
                ? interactionBody.input
                : (typeof interactionBody?.input === 'object' ? JSON.stringify(interactionBody.input) : '');
            const modelRaw = typeof interactionBody?.model === 'string'
                ? interactionBody.model
                : (typeof requestBody?.model === 'string' ? requestBody.model : '');
            if (!modelRaw || !input) {
                if (!response.completed) return response.status(400).json({ error: 'Bad Request: model and input are required for interactions mapping', timestamp: new Date().toISOString() });
                return;
            }

            const normalized = normalizeDeepResearchModel(modelRaw, typeof interactionBody?.agent === 'string' ? interactionBody.agent : undefined);
            const responseFormat = extractOpenAIResponseFormat(requestBody?.response_format);
            const interactionRequest: InteractionRequest = {
                model: normalized.model,
                input,
                tools: Array.isArray(interactionBody.tools) ? interactionBody.tools : undefined,
                response_format: responseFormat,
                generation_config: interactionBody.generation_config && typeof interactionBody.generation_config === 'object' ? interactionBody.generation_config : undefined,
                agent: normalized.agent,
            };

            const secret = getInteractionsSigningSecret();
            const interactionId = createInteractionToken(
                interactionRequest,
                request.apiKey,
                'openai-responses',
                INTERACTIONS_TOKEN_TTL_SECONDS,
                secret,
                modelRaw
            );

            const responseBody = {
                id: `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                object: 'response',
                created: Math.floor(Date.now() / 1000),
                model: modelRaw,
                status: 'in_progress',
                interaction: { id: interactionId },
                output: [],
                output_text: '',
            };
            return response.json(responseBody);
        }

        const { message, modelId, stream } = extractResponsesRequestBody(requestBody);
        const imageFetchReferer = normalizeImageFetchReferer(
            getHeaderValue(request.headers, 'x-image-fetch-referer') || getHeaderValue(request.headers, 'x-image-referer')
        );
        if (imageFetchReferer) {
            message.image_fetch_referer = imageFetchReferer;
        }
        if (isNanoBananaModel(modelId)) {
            message.modalities = ensureNanoBananaModalities(message.modalities);
        }

        const nonChatType = isNonChatModel(modelId);
        if (nonChatType) {
            if (nonChatType === 'image-gen' && !isNanoBananaModel(modelId)) {
                const prompt = typeof requestBody?.prompt === 'string'
                    ? requestBody.prompt
                    : extractTextFromResponsesInput(requestBody?.input);
                await handleImageGenFallbackFromChatOrResponses({
                    modelId,
                    prompt,
                    requestBody,
                    request,
                    response,
                    source: 'responses',
                });
                return;
            }
            if (nonChatType === 'video-gen') {
                const prompt = typeof requestBody?.prompt === 'string'
                    ? requestBody.prompt
                    : extractTextFromResponsesInput(requestBody?.input);
                const imageUrl = extractImageUrlFromResponsesInput(requestBody?.input);
                await handleVideoGenFallbackFromChatOrResponses({
                    modelId,
                    prompt,
                    imageUrl,
                    requestBody,
                    request,
                    response,
                    source: 'responses',
                });
                return;
            }
            if (!(nonChatType === 'image-gen' && isNanoBananaModel(modelId))) {
                const endpointMap: Record<string, string> = {
                    tts: '/v1/audio/speech',
                    stt: '/v1/audio/transcriptions',
                    'image-gen': '/v1/images/generations',
                    'video-gen': '/v1/videos/generations',
                    embedding: '/v1/embeddings',
                };
                const correctEndpoint = endpointMap[nonChatType] || 'the dedicated endpoint';
                if (!response.completed) {
                    return response.status(400).json({
                        error: {
                            message: `'${modelId}' is not a responses model and cannot be used with /v1/responses. Use ${correctEndpoint} instead.`,
                            type: 'invalid_request_error',
                            param: 'model',
                            code: 'model_not_supported',
                        },
                        timestamp: new Date().toISOString(),
                    });
                }
                return;
            }
        }
        const effectiveStream = stream && !isImageModelId(modelId);

        const responseId = `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);
        const basePayload = { id: responseId, object: 'response', created, model: modelId };

        if (effectiveStream) {
            response.setHeader('Content-Type', 'text/event-stream');
            response.setHeader('Cache-Control', 'no-cache');
            response.setHeader('Connection', 'keep-alive');
            const streamHandler = messageHandler.handleStreamingMessages([message], modelId, userApiKey);
            let totalTokenUsage = 0;
            let fullText = '';
            let passthroughHandled = false;
            let fallbackToNormalized = false;
            let promptTokensFromUsage: number | undefined;
            let completionTokensFromUsage: number | undefined;
            let responsesCreatedSent = false;

            for await (const result of streamHandler) {
                if (result.type === 'passthrough') {
                    if (result?.passthrough?.mode !== 'openai-responses-sse') {
                        console.log(`[StreamPassthrough] Fallback used for /responses due to mode mismatch (${result?.passthrough?.mode || 'unknown'}).`);
                        try { result?.passthrough?.upstream?.destroy?.(); } catch {}
                        fallbackToNormalized = true;
                        break;
                    }

                    passthroughHandled = true;
                    console.log(`[StreamPassthrough] Forwarding raw upstream SSE for /responses via ${result.providerId}.`);
                    let forwardedAnyBytes = false;

                    const parser = createSseDataParser((dataLine, eventName) => {
                        if (!dataLine || dataLine === '[DONE]') return;
                        try {
                            const parsed = JSON.parse(dataLine);
                            const deltaText = parsed?.output_text_delta
                                || parsed?.delta
                                || parsed?.response?.output_text_delta
                                || parsed?.response?.delta
                                || parsed?.output?.[0]?.content?.[0]?.delta
                                || parsed?.output?.[0]?.content?.[0]?.text
                                || '';
                            if (typeof deltaText === 'string' && deltaText) fullText += deltaText;

                            if (eventName === 'response.completed') {
                                const outputText = parsed?.output_text || parsed?.response?.output_text;
                                if (typeof outputText === 'string' && outputText.length > fullText.length) {
                                    fullText = outputText;
                                }
                            }

                            const usage = extractUsageTokens(parsed?.usage || parsed?.response?.usage);
                            if (typeof usage.promptTokens === 'number') promptTokensFromUsage = usage.promptTokens;
                            if (typeof usage.completionTokens === 'number') completionTokensFromUsage = usage.completionTokens;
                            if (typeof usage.totalTokens === 'number') totalTokenUsage = usage.totalTokens;
                        } catch {
                            // Ignore malformed passthrough SSE data lines for accounting sidecar parsing.
                        }
                    });

                    try {
                        for await (const rawChunk of result.passthrough.upstream) {
                            const chunkBuffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                            if (chunkBuffer.length > 0) forwardedAnyBytes = true;
                            response.write(chunkBuffer);
                            parser(chunkBuffer.toString('utf8'));
                        }
                    } catch (passthroughPipeError: any) {
                        if (!forwardedAnyBytes) {
                            console.warn(`[StreamPassthrough] Fallback used for /responses due to passthrough pipe error before first byte: ${passthroughPipeError?.message || 'unknown error'}`);
                            fallbackToNormalized = true;
                            passthroughHandled = false;
                            break;
                        }
                        throw passthroughPipeError;
                    }

                    break;
                } else if (result.type === 'chunk') {
                    if (!responsesCreatedSent) {
                        response.write(`event: response.created\n`);
                        response.write(`data: ${JSON.stringify({ ...basePayload, output: [], output_text: '' })}\n\n`);
                        responsesCreatedSent = true;
                    }
                    fullText += result.chunk;
                    const chunkPayload = {
                        ...basePayload,
                        output_text_delta: result.chunk,
                        output: [{ content: [{ type: 'output_text', text: result.chunk }] }]
                    };
                    response.write(`event: response.output_text.delta\n`);
                    response.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
                } else if (result.type === 'final') {
                    if (!responsesCreatedSent) {
                        response.write(`event: response.created\n`);
                        response.write(`data: ${JSON.stringify({ ...basePayload, output: [], output_text: '' })}\n\n`);
                        responsesCreatedSent = true;
                    }
                    if (result.tokenUsage) totalTokenUsage = result.tokenUsage;
                }
            }

            if (fallbackToNormalized) {
                if (!responsesCreatedSent) {
                    response.write(`event: response.created\n`);
                    response.write(`data: ${JSON.stringify({ ...basePayload, output: [], output_text: '' })}\n\n`);
                    responsesCreatedSent = true;
                }

                const fallbackStreamHandler = messageHandler.handleStreamingMessages([message], modelId, userApiKey, { disablePassthrough: true });
                for await (const fallbackResult of fallbackStreamHandler) {
                    if (fallbackResult.type === 'chunk') {
                        fullText += fallbackResult.chunk;
                        const chunkPayload = {
                            ...basePayload,
                            output_text_delta: fallbackResult.chunk,
                            output: [{ content: [{ type: 'output_text', text: fallbackResult.chunk }] }]
                        };
                        response.write(`event: response.output_text.delta\n`);
                        response.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
                    } else if (fallbackResult.type === 'final') {
                        if (fallbackResult.tokenUsage) totalTokenUsage = fallbackResult.tokenUsage;
                    }
                }
            }

            if (passthroughHandled) {
                if (totalTokenUsage <= 0) {
                    const promptEstimate = typeof promptTokensFromUsage === 'number' ? promptTokensFromUsage : estimateTokensFromContent(message.content);
                    const completionEstimate = typeof completionTokensFromUsage === 'number' ? completionTokensFromUsage : estimateTokensFromText(fullText);
                    totalTokenUsage = promptEstimate + completionEstimate;
                }

                await updateUserTokenUsage(totalTokenUsage, userApiKey);
                if (!response.completed) return response.end();
                return;
            }

            await updateUserTokenUsage(totalTokenUsage, userApiKey);

            const finalPayload = {
                ...basePayload,
                output: [{ content: [{ type: 'output_text', text: fullText }] }],
                output_text: fullText,
                usage: { total_tokens: totalTokenUsage }
            };

            response.write(`event: response.completed\n`);
            response.write(`data: ${JSON.stringify(finalPayload)}\n\n`);
            response.write(`data: [DONE]\n\n`);
            return response.end();
        }

        const result = await messageHandler.handleMessages([message], modelId, userApiKey);
        const assistantContent = formatAssistantContent(result.response);
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const promptTokensUsed = typeof result.promptTokens === 'number' ? result.promptTokens : undefined;
        const completionTokensUsed = typeof result.completionTokens === 'number' ? result.completionTokens : undefined;
        await updateUserTokenUsage(totalTokensUsed, userApiKey);

        const responseBody = {
            ...basePayload,
            output: [{ content: [{ type: 'output_text', text: assistantContent }] }],
            output_text: assistantContent,
            usage: { prompt_tokens: promptTokensUsed, completion_tokens: completionTokensUsed, total_tokens: totalTokensUsed }
        };

        return response.json(responseBody);
    } catch (error: any) {
        await logError(error, request);
        const errorText = String(error?.message || '');
        console.error('Responses API error:', errorText, error.stack);
        const timestamp = new Date().toISOString();
        let statusCode = 500;
        let clientMessage = 'Internal Server Error';
        let clientReference = 'An unexpected error occurred while processing your responses request.';

        if (errorText.startsWith('Invalid request') || errorText.startsWith('Failed to parse') || errorText.includes('input is required')) {
            statusCode = 400;
            clientMessage = `Bad Request: ${errorText}`;
        } else if (error instanceof SyntaxError) {
            statusCode = 400;
            clientMessage = 'Invalid JSON';
        } else if (errorText.includes('Unauthorized') || errorText.includes('limit reached')) {
            statusCode = errorText.includes('limit reached') ? 429 : 401;
            clientMessage = errorText;
        } else if (
            errorText.toLowerCase().includes('requires more credits') ||
            errorText.toLowerCase().includes('insufficient credits') ||
            errorText.toLowerCase().includes('can only afford') ||
            errorText.includes('status 402')
        ) {
            statusCode = 402;
            clientMessage = 'Payment Required: insufficient credits for the requested max_tokens. Reduce max_tokens or add credits to the provider key.';
        } else if (errorText.toLowerCase().includes('image exceeds') || errorText.toLowerCase().includes('image exceeds 5 mb')) {
            statusCode = 400;
            clientMessage = 'Bad Request: image exceeds the provider size limit. Please resize or compress the image before sending.';
        } else if (errorText.includes('fetching image from URL') || errorText.includes('image_url')) {
            statusCode = 400;
            clientMessage = 'Bad Request: image_url could not be fetched by the provider. Use a public, non-expiring URL or pass the image as base64 data.';
        } else if (errorText.includes('No suitable providers') || errorText.includes('supports model') || errorText.includes('No provider')) {
            statusCode = 404;
            clientMessage = errorText;
        }

        if (!response.completed) {
            if (statusCode === 500) {
                response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
            } else {
                response.status(statusCode).json({ error: clientMessage, timestamp });
            }
        } else { return; }
    }
});

// --- Interactions (OpenAI-style mapping) ---
openaiRouter.post('/interactions', async (request: Request, response: Response) => {
    if (!request.apiKey || !request.tierLimits) {
        await logError({ message: 'Authentication or configuration failed in /v1/interactions after middleware' }, request);
        if (!response.completed) return response.status(401).json({ error: 'Authentication or configuration failed', timestamp: new Date().toISOString() });
        return;
    }

    try {
        const body = await request.json();
        const model = typeof body?.model === 'string' ? body.model.trim() : '';
        const input = typeof body?.input === 'string'
            ? body.input
            : (typeof body?.input === 'object' ? JSON.stringify(body.input) : '');
        if (!model || !input) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: model and input are required', timestamp: new Date().toISOString() });
            return;
        }

        const normalized = normalizeDeepResearchModel(model, typeof body?.agent === 'string' ? body.agent : undefined);
        const interactionRequest: InteractionRequest = {
            model: normalized.model,
            input,
            tools: Array.isArray(body.tools) ? body.tools : undefined,
            response_format: body.response_format && typeof body.response_format === 'object' ? body.response_format : undefined,
            generation_config: body.generation_config && typeof body.generation_config === 'object' ? body.generation_config : undefined,
            agent: normalized.agent,
        };

        const secret = getInteractionsSigningSecret();
        const interactionId = createInteractionToken(
            interactionRequest,
            request.apiKey,
            'openai-responses',
            INTERACTIONS_TOKEN_TTL_SECONDS,
            secret,
            model
        );

        const responseBody = {
            id: interactionId,
            status: 'processing',
        };
        return response.json(responseBody);
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(500).json({ error: 'Internal Server Error', reference: 'Failed to create interaction.', timestamp: new Date().toISOString() });
        }
    }
});

openaiRouter.get('/interactions/:interactionId', async (request: Request, response: Response) => {
    if (!request.apiKey || !request.tierLimits || !request.params.interactionId) {
        await logError({ message: 'Authentication or configuration failed in /v1/interactions poll after middleware' }, request);
        if (!response.completed) return response.status(401).json({ error: 'Authentication or configuration failed', timestamp: new Date().toISOString() });
        return;
    }

    try {
        const secret = getInteractionsSigningSecret();
        const payload = verifyInteractionToken(request.params.interactionId, request.apiKey, secret);
        const result = await executeGeminiInteraction(payload.request);
        const outputs = Array.isArray(result?.outputs) ? result.outputs : [];
        const outputText = typeof outputs?.[0]?.text === 'string' ? outputs[0].text : '';
        const usage = result?.usage || {};
        const totalTokensUsed = typeof usage.total_tokens === 'number'
            ? usage.total_tokens
            : (typeof result?.usageMetadata?.totalTokenCount === 'number' ? result.usageMetadata.totalTokenCount : 0);
        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, request.apiKey);
        }

        const responseBody = {
            id: request.params.interactionId,
            status: 'completed',
            outputs,
            output_text: outputText,
            usage,
        };
        return response.json(responseBody);
    } catch (error: any) {
        await logError(error, request);
        let statusCode = 500;
        let clientMessage = 'Internal Server Error';
        if (String(error?.message || '').includes('expired')) statusCode = 410;
        if (String(error?.message || '').includes('Invalid')) statusCode = 400;
        if (!response.completed) {
            response.status(statusCode).json({ error: clientMessage, timestamp: new Date().toISOString() });
        }
    }
});

// --- Azure OpenAI Compatible Route ---
openaiRouter.post('/deployments/:deploymentId/chat/completions', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
    // Middleware should have attached these if successful
    if (!request.apiKey || !request.tierLimits || !request.params.deploymentId) {
        await logError({ message: 'Authentication or configuration failed (Azure route) after middleware' }, request);
        if (!response.completed) {
           return response.status(401).json({ error: 'Authentication or configuration failed (Azure route).', timestamp: new Date().toISOString() }); 
        } else { return; }
    }

    // Check for api-version query parameter (required by Azure)
    const apiVersion = request.query['api-version'];
    if (!apiVersion || typeof apiVersion !== 'string') {
         await logError({ message: 'Bad Request: Missing or invalid api-version query parameter (Azure route)' }, request);
         if (!response.completed) {
           return response.status(400).json({ error: 'Bad Request: Missing or invalid \'api-version\' query parameter.', timestamp: new Date().toISOString() });
         } else { return; }
    }

    const userApiKey = request.apiKey!;
    const deploymentId = request.params.deploymentId; // Use deploymentId as the modelId
    const tierLimits = request.tierLimits!;

    try {
        // Extract messages using the same logic as the standard route
        const requestBody = await request.json();
        let { messages: rawMessages } = extractMessageFromRequestBody(requestBody); 
        rawMessages = filterValidChatMessages(rawMessages);
        if (rawMessages.length === 0) {
            return response.status(400).json({
                error: {
                    message: 'Bad Request: messages must include at least one message with a role.',
                    type: 'invalid_request_error',
                    param: 'messages',
                    code: 'invalid_messages',
                },
                timestamp: new Date().toISOString(),
            });
        }

        // Use deploymentId as model identifier for the handler
        const formattedMessages: IMessage[] = rawMessages.map(msg => ({ role: msg.role, content: msg.content, model: { id: deploymentId } }));
 
        // Call the central message handler
        const result = await messageHandler.handleMessages(formattedMessages, deploymentId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const promptTokensUsed = typeof result.promptTokens === 'number' ? result.promptTokens : undefined;
        const completionTokensUsed = typeof result.completionTokens === 'number' ? result.completionTokens : undefined;
        await updateUserTokenUsage(totalTokensUsed, userApiKey); 
 
        // --- Format response strictly like OpenAI --- 
        const openaiResponse = {
            id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`, 
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: deploymentId, // Use deployment ID here as the model identifier
            // system_fingerprint: null, // Set to null if not available.
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.response,
                    },
                    logprobs: null, // Set to null if not applicable
                    finish_reason: "stop", 
                }
            ],
            usage: {
                prompt_tokens: promptTokensUsed,
                completion_tokens: completionTokensUsed,
                total_tokens: totalTokensUsed
            }
            // Custom fields _latency_ms and _provider_id are removed
        };

        response.json(openaiResponse);

    } catch (error: any) {
        await logError(error, request);
        console.error('Azure Chat completions error:', error.message, error.stack);
        const timestamp = new Date().toISOString();
        let statusCode = 500;
        let clientMessage = 'Internal Server Error';
        let clientReference = 'An unexpected error occurred while processing your Azure chat request.';

        if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse')) {
            statusCode = 400;
            clientMessage = `Bad Request: ${error.message}`;
        } else if (error instanceof SyntaxError) {
            statusCode = 400;
            clientMessage = 'Invalid JSON';
        } else if (error.message.includes('Unauthorized') || error.message.includes('limit reached')) {
            statusCode = error.message.includes('limit reached') ? 429 : 401;
            clientMessage = error.message;
        } else if (error.message.includes('No suitable providers') || error.message.includes('supports model') || error.message.includes('No provider')) {
             statusCode = 404;
             clientMessage = `Deployment not found or model unsupported: ${deploymentId}`;
        } else if (error.message.includes('Provider') && error.message.includes('failed')) {
            statusCode = 502;
            clientMessage = error.message;
        } else if (error.message.includes('Failed to process request')) { 
            statusCode = 503;
            clientMessage = 'Service temporarily unavailable after multiple provider attempts.';
        }
        
        if (!response.completed) {
            if (statusCode === 500) {
                response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
            } else {
                response.status(statusCode).json({ error: clientMessage, timestamp });
            }
        } else { return; }
    }
});

// --- Helper: pick an OpenAI provider key that supports the requested model ---
function extractOrigin(urlStr: string): string {
    try {
        const u = new URL(urlStr);
        return u.origin; // e.g. "https://api.openai.com"
    } catch {
        return 'https://api.openai.com';
    }
}

const MODEL_CAPS_CACHE_MS = Math.max(1000, Number(process.env.MODEL_CAPS_CACHE_MS ?? 5000));
let modelCapsCache: { expiresAt: number; map: Map<string, ModelCapability[]> } | null = null;

function normalizeModelIdVariants(modelId: string): string[] {
    const raw = String(modelId || '').trim();
    if (!raw) return [];
    const variants = new Set<string>([raw]);
    const slashIndex = raw.indexOf('/');
    if (slashIndex > 0 && slashIndex + 1 < raw.length) {
        variants.add(raw.slice(slashIndex + 1));
    }
    return Array.from(variants);
}

async function getModelCapabilities(modelId: string): Promise<ModelCapability[] | null> {
    const now = Date.now();
    if (!modelCapsCache || now > modelCapsCache.expiresAt) {
        const modelsFile = await dataManager.load<ModelsFileStructure>('models');
        const map = new Map<string, ModelCapability[]>();
        for (const model of modelsFile.data || []) {
            const caps = Array.isArray(model.capabilities) ? model.capabilities as ModelCapability[] : [];
            if (caps.length > 0 && model.id) {
                map.set(model.id, caps);
            }
        }
        modelCapsCache = { map, expiresAt: now + MODEL_CAPS_CACHE_MS };
    }

    for (const variant of normalizeModelIdVariants(modelId)) {
        const caps = modelCapsCache.map.get(variant);
        if (caps) return caps;
    }
    return null;
}

async function enforceModelCapabilities(
    modelId: string,
    requiredCaps: ModelCapability[],
    response: Response
): Promise<boolean> {
    if (!requiredCaps || requiredCaps.length === 0) return true;
    const caps = await getModelCapabilities(modelId);
    if (!caps || caps.length === 0) return true;
    const missing = requiredCaps.filter((cap) => !caps.includes(cap));
    if (missing.length === 0) return true;
    if (!response.completed) {
        response.status(400).json({
            error: `Model ${modelId} missing required capabilities: ${missing.join(', ')}`,
            timestamp: new Date().toISOString()
        });
    }
    return false;
}

async function pickOpenAIProviderKey(
    modelId: string,
    requiredCaps: ModelCapability[] = []
): Promise<{ apiKey: string; baseUrl: string } | null> {
    const providers = await dataManager.load<LoadedProviders>('providers');
    const requiresCaps = Array.isArray(requiredCaps) && requiredCaps.length > 0;
    const matches = providers.filter((p: LoadedProviderData) =>
        !p.disabled &&
        p.id.includes('openai') &&
        p.apiKey &&
        p.models &&
        modelId in p.models
    );
    const candidates = requiresCaps
        ? matches.filter((p: LoadedProviderData) => {
            const modelData = p.models?.[modelId];
            const skips = (modelData as any)?.capability_skips as Partial<Record<ModelCapability, string>> | undefined;
            if (!skips) return true;
            return !requiredCaps.some((cap) => Boolean(skips[cap]));
        })
        : matches;

    if (candidates.length === 0) {
        if (matches.length > 0) return null;
        // Fallback: any non-disabled openai provider with an API key
        const fallback = providers.find((p: LoadedProviderData) =>
            !p.disabled && p.id.includes('openai') && p.apiKey
        );
        if (!fallback) return null;
        return { apiKey: fallback.apiKey!, baseUrl: extractOrigin(fallback.provider_url || 'https://api.openai.com') };
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || 'https://api.openai.com') };
}

async function pickImageGenProviderKey(
    modelId: string,
    requiredCaps: ModelCapability[] = []
): Promise<{ apiKey: string; baseUrl: string } | null> {
    const providers = await dataManager.load<LoadedProviders>('providers');
    const requiresCaps = Array.isArray(requiredCaps) && requiredCaps.length > 0;
    const matches = providers.filter((p: LoadedProviderData) =>
        !p.disabled &&
        (p.id.includes('openai') || p.id.includes('xai')) &&
        p.apiKey &&
        p.models &&
        modelId in p.models
    );
    const candidates = requiresCaps
        ? matches.filter((p: LoadedProviderData) => {
            const modelData = p.models?.[modelId];
            const skips = (modelData as any)?.capability_skips as Partial<Record<ModelCapability, string>> | undefined;
            if (!skips) return true;
            return !requiredCaps.some((cap) => Boolean(skips[cap]));
        })
        : matches;

    const pickFrom = candidates.length > 0 ? candidates : matches;
    if (pickFrom.length === 0) return null;
    const pick = pickFrom[Math.floor(Math.random() * pickFrom.length)];
    const defaultBase = pick.id.includes('xai') ? 'https://api.x.ai' : 'https://api.openai.com';
    return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || defaultBase) };
}

async function pickVideoGenProviderKey(
    modelId: string
): Promise<{ apiKey: string; baseUrl: string } | null> {
    const providers = await dataManager.load<LoadedProviders>('providers');
    const matches = providers.filter((p: LoadedProviderData) =>
        !p.disabled &&
        p.id.includes('xai') &&
        p.apiKey &&
        p.models &&
        modelId in p.models
    );
    if (matches.length === 0) return null;
    const pick = matches[Math.floor(Math.random() * matches.length)];
    return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || 'https://api.x.ai') };
}

async function pickAnyXaiProviderKey(): Promise<{ apiKey: string; baseUrl: string } | null> {
    const providers = await dataManager.load<LoadedProviders>('providers');
    const pick = providers.find((p: LoadedProviderData) => !p.disabled && p.id.includes('xai') && p.apiKey);
    if (!pick) return null;
    return { apiKey: pick.apiKey!, baseUrl: extractOrigin(pick.provider_url || 'https://api.x.ai') };
}
// --- Audio format content-type map ---
const AUDIO_CONTENT_TYPES: Record<string, string> = {
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
};

async function forwardTtsToOpenAI(options: {
    modelId: string;
    input: string;
    voice?: string;
    responseFormat?: string;
    speed?: number;
    stream?: boolean;
    userApiKey: string;
    response: Response;
}) {
    const { modelId, input, voice, responseFormat, speed, stream, userApiKey, response } = options;

    if (!input) {
        if (!response.completed) response.status(400).json({ error: 'Bad Request: input is required for TTS', timestamp: new Date().toISOString() });
        return;
    }

    const capsOk = await enforceModelCapabilities(modelId, ['audio_output'], response);
    if (!capsOk) return;

    const provider = await pickOpenAIProviderKey(modelId, ['audio_output']);
    if (!provider) {
        if (!response.completed) response.status(503).json({ error: 'No available provider for TTS', timestamp: new Date().toISOString() });
        return;
    }

    const upstreamUrl = `${provider.baseUrl}/v1/audio/speech`;
    const upstreamRes = await fetchWithTimeout(upstreamUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
            model: modelId,
            input,
            voice: voice || 'alloy',
            response_format: responseFormat || 'mp3',
            speed,
            stream: Boolean(stream),
        }),
    }, UPSTREAM_TIMEOUT_MS);

    if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        if (!response.completed) response.status(upstreamRes.status).json({ error: `TTS upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
        return;
    }

    const upstreamContentType = upstreamRes.headers.get('content-type');
    const contentType = upstreamContentType || AUDIO_CONTENT_TYPES[(responseFormat || 'mp3').toLowerCase()] || 'audio/mpeg';
    response.setHeader('Content-Type', contentType);

    if (stream && upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) response.write(Buffer.from(value));
        }
        response.end();
    } else {
        const arrayBuffer = await upstreamRes.arrayBuffer();
        response.end(Buffer.from(arrayBuffer));
    }

    await updateUserTokenUsage(Math.ceil(input.length / 4), userApiKey);
}

async function forwardSttToOpenAI(options: {
    modelId: string;
    audio: { data: string; format: string };
    language?: string;
    prompt?: string;
    temperature?: number;
    responseFormat?: string;
    userApiKey: string;
    response: Response;
}) {
    const { modelId, audio, language, prompt, temperature, responseFormat, userApiKey, response } = options;

    const normalized = normalizeInputAudio(audio);
    if (!normalized) {
        if (!response.completed) response.status(400).json({ error: 'Bad Request: invalid input audio', timestamp: new Date().toISOString() });
        return;
    }

    const capsOk = await enforceModelCapabilities(modelId, ['audio_input'], response);
    if (!capsOk) return;

    const provider = await pickOpenAIProviderKey(modelId, ['audio_input']);
    if (!provider) {
        if (!response.completed) response.status(503).json({ error: 'No available provider for STT', timestamp: new Date().toISOString() });
        return;
    }


    const FormDataCtor = (globalThis as any).FormData;
    const BlobCtor = (globalThis as any).Blob;
    if (!FormDataCtor || !BlobCtor) {
        throw new Error('FormData/Blob not available in this Node runtime.');
    }
    const form = new FormDataCtor();
    form.append('model', modelId);
    form.append('file', new BlobCtor([normalized.buffer], { type: normalized.mimeType }), `audio.${normalized.extension}`);
    if (typeof language === 'string') form.append('language', language);
    if (typeof prompt === 'string') form.append('prompt', prompt);
    if (typeof temperature === 'number') form.append('temperature', temperature.toString());
    if (typeof responseFormat === 'string') form.append('response_format', responseFormat);

    const upstreamUrl = `${provider.baseUrl}/v1/audio/transcriptions`;
    const upstreamRes = await fetchWithTimeout(upstreamUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: form,
    }, UPSTREAM_TIMEOUT_MS);

    const resContentType = upstreamRes.headers.get('content-type') || 'application/json';
    response.setHeader('Content-Type', resContentType);

    if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        if (!response.completed) response.status(upstreamRes.status).end(errText || upstreamRes.statusText);
        return;
    }

    const resBody = await upstreamRes.text();
    response.end(resBody);

    await updateUserTokenUsage(100, userApiKey);
}

// --- TTS: /v1/audio/speech ---
openaiRouter.post('/audio/speech', async (request: Request, response: Response) => {
    try {
        let body: any;
        try {
            body = await request.json();
        } catch (parseErr: any) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: invalid or missing JSON body', timestamp: new Date().toISOString() });
            return;
        }

        if (!body.model || typeof body.model !== 'string') {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: model is required', timestamp: new Date().toISOString() });
            return;
        }
        const model = body.model;
        const nonChatType = isNonChatModel(model);
        if (nonChatType !== 'tts') {
            if (!response.completed) {
                return response.status(400).json({
                    error: `Bad Request: '${model}' is not a TTS model. Use /v1/chat/completions or /v1/responses for text models.`,
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }
        const input = typeof body?.input === 'string' ? body.input : '';
        const voice = typeof body?.voice === 'string' ? body.voice : 'alloy';
        const responseFormat = typeof body?.response_format === 'string' ? body.response_format : 'mp3';
        const speed = typeof body?.speed === 'number' ? body.speed : undefined;
        const stream = Boolean(body?.stream);

        if (!input) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: input is required', timestamp: new Date().toISOString() });
            return;
        }

        const capsOk = await enforceModelCapabilities(model, ['audio_output'], response);
        if (!capsOk) return;

        const provider = await pickOpenAIProviderKey(model, ['audio_output']);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for TTS', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/audio/speech`;
        const upstreamRes = await fetchWithTimeout(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({ model, input, voice, response_format: responseFormat, speed, stream }),
        }, UPSTREAM_TIMEOUT_MS);

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            if (!response.completed) return response.status(upstreamRes.status).json({ error: `TTS upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
            return;
        }

        const upstreamContentType = upstreamRes.headers.get('content-type');
        const contentType = upstreamContentType || AUDIO_CONTENT_TYPES[responseFormat] || 'audio/mpeg';
        response.setHeader('Content-Type', contentType);

        if (stream && upstreamRes.body) {
            const reader = upstreamRes.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.length > 0) {
                    response.write(Buffer.from(value));
                }
            }
            response.end();
        } else {
            const arrayBuffer = await upstreamRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            response.end(buffer);
        }

        await updateUserTokenUsage(Math.ceil(input.length / 4), request.apiKey!);
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
    }
});

// --- STT: /v1/audio/transcriptions ---
openaiRouter.post('/audio/transcriptions', async (request: Request, response: Response) => {
    try {
        // For multipart/form-data, we need to forward the raw body
        const contentType = request.headers['content-type'] || '';
        const model = request.query?.model;

        if (!model || typeof model !== 'string') {
             if (!response.completed) return response.status(400).json({ error: 'Bad Request: model is required (query param)', timestamp: new Date().toISOString() });
             return;
        }
        const nonChatType = isNonChatModel(model);
        if (nonChatType !== 'stt') {
            if (!response.completed) {
                return response.status(400).json({
                    error: `Bad Request: '${model}' is not a transcription model. Use /v1/chat/completions or /v1/responses for text models.`,
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        const capsOk = await enforceModelCapabilities(model, ['audio_input'], response);
        if (!capsOk) return;

        const provider = await pickOpenAIProviderKey(model, ['audio_input']);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for STT', timestamp: new Date().toISOString() });
            return;
        }

        // Read raw body as Buffer via the buffer() method
        const rawBody = await request.buffer();
        const upstreamUrl = `${provider.baseUrl}/v1/audio/transcriptions`;
        const upstreamRes = await fetchWithTimeout(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': contentType,
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: rawBody as any,
        }, UPSTREAM_TIMEOUT_MS);

        const resContentType = upstreamRes.headers.get('content-type') || 'application/json';
        response.setHeader('Content-Type', resContentType);

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            if (!response.completed) { response.status(upstreamRes.status).end(errText); return; }
            return;
        }

        const resBody = await upstreamRes.text();
        response.end(resBody);

        await updateUserTokenUsage(100, request.apiKey!); // Flat estimate for audio transcription
    } catch (error: any) {
        await logError(error, request);
        console.error('STT route error:', error.message);
        if (!response.completed) response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
    }
});

// --- Image Generation: /v1/images/generations ---
openaiRouter.post('/images/generations', async (request: Request, response: Response) => {
    try {
        const body = await request.json();
        const model = typeof body?.model === 'string' ? body.model : '';
        const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
        if (!model) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: model is required', timestamp: new Date().toISOString() });
            return;
        }
        const nonChatType = isNonChatModel(model);
        if (nonChatType !== 'image-gen') {
            if (!response.completed) {
                return response.status(400).json({
                    error: `Bad Request: '${model}' is not an image generation model. Use /v1/chat/completions or /v1/responses for text models.`,
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }
        if (!prompt) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: prompt is required', timestamp: new Date().toISOString() });
            return;
        }

        const capsOk = await enforceModelCapabilities(model, ['image_output'], response);
        if (!capsOk) return;

        const provider = await pickImageGenProviderKey(model, ['image_output']);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for image generation', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/images/generations`;
        const upstreamRes = await fetchWithTimeout(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({
                model,
                prompt,
                n: typeof body?.n === 'number' ? body.n : 1,
                size: typeof body?.size === 'string' ? body.size : '1024x1024',
                quality: typeof body?.quality === 'string' ? body.quality : undefined,
                style: typeof body?.style === 'string' ? body.style : undefined,
                response_format: typeof body?.response_format === 'string' ? body.response_format : undefined,
            }),
        }, UPSTREAM_TIMEOUT_MS);

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            if (!response.completed) return response.status(upstreamRes.status).json({ error: `Image generation upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
            return;
        }

        const resJson = await upstreamRes.json();
        response.json(resJson);

        const tokenEstimate = Math.ceil(prompt.length / 4) + 500; // prompt + generation cost estimate
        await updateUserTokenUsage(tokenEstimate, request.apiKey!);
    } catch (error: any) {
        await logError(error, request);
        console.error('Image generation route error:', error.message);
        if (!response.completed) response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
    }
});

// --- Video Generation: /v1/videos/generations ---
openaiRouter.post('/videos/generations', async (request: Request, response: Response) => {
    try {
        const body = await request.json();
        const model = typeof body?.model === 'string' ? body.model : '';
        const prompt = typeof body?.prompt === 'string'
            ? body.prompt
            : (typeof body?.input === 'string' ? body.input : '');
        if (!model) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: model is required', timestamp: new Date().toISOString() });
            return;
        }
        const nonChatType = isNonChatModel(model);
        if (nonChatType !== 'video-gen') {
            if (!response.completed) {
                return response.status(400).json({
                    error: `Bad Request: '${model}' is not a video generation model. Use /v1/chat/completions or /v1/responses for text models.`,
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }
        if (!prompt) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: prompt is required', timestamp: new Date().toISOString() });
            return;
        }

        const provider = await pickVideoGenProviderKey(model);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for video generation', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/videos/generations`;
        const payload: Record<string, any> = {
            model,
            prompt,
        };
        if (typeof body?.image_url === 'string') payload.image_url = body.image_url;
        if (typeof body?.video_url === 'string') payload.video_url = body.video_url;
        if (typeof body?.duration === 'number') payload.duration = body.duration;
        if (typeof body?.aspect_ratio === 'string') payload.aspect_ratio = body.aspect_ratio;
        if (typeof body?.resolution === 'string') payload.resolution = body.resolution;
        if (typeof body?.seed === 'number') payload.seed = body.seed;

        const upstreamRes = await fetchWithTimeout(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify(payload),
        }, UPSTREAM_TIMEOUT_MS);

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            if (!response.completed) return response.status(upstreamRes.status).json({ error: `Video generation upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
            return;
        }

        const resJson = await upstreamRes.json();
        const requestId = resJson?.request_id || resJson?.id;
        if (requestId) setVideoRequestCache(String(requestId), provider);
        response.json(resJson);

        const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
        await updateUserTokenUsage(tokenEstimate, request.apiKey!);
    } catch (error: any) {
        await logError(error, request);
        console.error('Video generation route error:', error.message);
        if (!response.completed) response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
    }
});

// --- Video Status: /v1/videos/{requestId} ---
openaiRouter.get('/videos/:requestId', async (request: Request, response: Response) => {
    try {
        const requestId = typeof request.params?.requestId === 'string' ? request.params.requestId : '';
        if (!requestId) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: requestId is required', timestamp: new Date().toISOString() });
            return;
        }

        const cached = getVideoRequestCache(requestId);
        const provider = cached ?? await pickAnyXaiProviderKey();
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for video status', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/videos/${requestId}`;
        const upstreamRes = await fetchWithTimeout(upstreamUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${provider.apiKey}`,
            },
        }, UPSTREAM_TIMEOUT_MS);

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            if (!response.completed) return response.status(upstreamRes.status).json({ error: `Video status upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
            return;
        }

        const resJson = await upstreamRes.json();
        response.json(resJson);
    } catch (error: any) {
        await logError(error, request);
        console.error('Video status route error:', error.message);
        if (!response.completed) response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
    }
});

// --- Embeddings: /v1/embeddings ---
openaiRouter.post('/embeddings', async (request: Request, response: Response) => {
    if (!(await authAndUsageMiddleware(request, response, () => {})) && !request.apiKey) return;
    try {
        let body: any;
        try {
            body = await request.json();
        } catch (e) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: invalid JSON', timestamp: new Date().toISOString() });
            return;
        }

        const model = typeof body?.model === 'string' ? body.model : '';
        const input = body?.input;

        if (!model) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: model is required', timestamp: new Date().toISOString() });
            return;
        }

        if (!input) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: input is required', timestamp: new Date().toISOString() });
            return;
        }

        const provider = await pickOpenAIProviderKey(model);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for embeddings', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/embeddings`;
        const upstreamRes = await fetchWithTimeout(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({ model, input, encoding_format: body.encoding_format, dimensions: body.dimensions, user: body.user }),
        }, UPSTREAM_TIMEOUT_MS);

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            if (!response.completed) return response.status(upstreamRes.status).json({ error: `Embeddings upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
            return;
        }

        const resJson = await upstreamRes.json();
        response.json(resJson);

        // Estimate usage if upstream didn't provide it, otherwise use upstream
        const tokensUsed = resJson.usage?.total_tokens || (Array.isArray(input)
            ? input.reduce((acc: number, s: string) => acc + estimateTokensFromText(String(s), 'input'), 0)
            : estimateTokensFromText(String(input), 'input'));
        await updateUserTokenUsage(tokensUsed, request.apiKey!);

    } catch (error: any) {
        await logError(error, request);
        console.error('Embeddings route error:', error.message);
        if (!response.completed) response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
    }
});
 
// --- Image Edits: /v1/images/edits ---
openaiRouter.post('/images/edits', async (request: Request, response: Response) => {
    try {
        const contentType = request.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: multipart/form-data required', timestamp: new Date().toISOString() });
            return;
        }

        const rawBody = await request.buffer();
        const boundary = contentType.split('boundary=')[1]?.trim();
        if (!boundary) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: boundary missing', timestamp: new Date().toISOString() });
            return;
        }

        // Parse just to extract model/validation, but forward raw buffer
        const parsed = parseMultipartBody(rawBody, boundary);
        const model = parsed.fields['model']; 
        const prompt = parsed.fields['prompt'];
        
        if (!model) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: model is required', timestamp: new Date().toISOString() });
            return;
        }
        const nonChatType = isNonChatModel(model);
        if (nonChatType !== 'image-gen') {
            if (!response.completed) {
                return response.status(400).json({
                    error: `Bad Request: '${model}' is not an image generation model. Use /v1/chat/completions or /v1/responses for text models.`,
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        if (!prompt) {
             if (!response.completed) return response.status(400).json({ error: 'Bad Request: prompt is required', timestamp: new Date().toISOString() });
             return;
        }

        // Check for image file
        if (!parsed.files.some(f => f.name === 'image')) {
             if (!response.completed) return response.status(400).json({ error: 'Bad Request: image file is required', timestamp: new Date().toISOString() });
             return;
        }

        const capsOk = await enforceModelCapabilities(model, ['image_input', 'image_output'], response);
        if (!capsOk) return;

        const provider = await pickOpenAIProviderKey(model, ['image_input', 'image_output']);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for image edits', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/images/edits`;
        
        // Forward raw body directly to preserve binary integrity
        const upstreamRes = await fetchWithTimeout(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': contentType, // Pass original content-type with boundary
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: rawBody as any,
        }, UPSTREAM_TIMEOUT_MS);

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            if (!response.completed) return response.status(upstreamRes.status).json({ error: `Image edits upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
            return;
        }

        const resJson = await upstreamRes.json();
        response.json(resJson);

        const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
        await updateUserTokenUsage(tokenEstimate, request.apiKey!);

    } catch (error: any) {
        await logError(error, request);
        console.error('Image edits route error:', error.message);
        if (!response.completed) response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
    }
});

// --- Audio Voices: /v1/audio/voices ---
openaiRouter.get('/audio/voices', async (request: Request, response: Response) => {
    // Basic response simulating OpenAI-compatible voice list
    const voices = [
        { voice_id: 'alloy', name: 'Alloy', category: 'openai' },
        { voice_id: 'echo', name: 'Echo', category: 'openai' },
        { voice_id: 'fable', name: 'Fable', category: 'openai' },
        { voice_id: 'onyx', name: 'Onyx', category: 'openai' },
        { voice_id: 'nova', name: 'Nova', category: 'openai' },
        { voice_id: 'shimmer', name: 'Shimmer', category: 'openai' }
    ];
    response.json({ voices });
});

// --- Audio Models: /v1/audio/models ---
openaiRouter.get('/audio/models', async (request: Request, response: Response) => {
    const models = [
        { id: 'tts-1', object: 'model', created: 1699046015, owned_by: 'openai' },
        { id: 'tts-1-hd', object: 'model', created: 1699046015, owned_by: 'openai' },
        { id: 'whisper-1', object: 'model', created: 1677610602, owned_by: 'openai' }
    ];
    response.json({ object: 'list', data: models });
});
 
export default openaiRouter;
