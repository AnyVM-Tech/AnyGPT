import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import dotenv from 'dotenv';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { messageHandler } from '../providers/handler.js';
import { IMessage, type ModelCapability } from '../providers/interfaces.js';
import {
    type StoredResponsesHistoryEntry,
    cloneResponsesHistoryValue,
    loadResponsesHistoryEntry,
    saveResponsesHistoryEntry,
    buildStoredResponsesHistoryOutput,
    mergeResponsesHistoryInput,
} from '../modules/responsesHistory.js';
import {
    buildResponsesCompletedEvent,
    buildResponsesContentPartAddedEvent,
    buildResponsesContentPartDoneEvent,
    buildResponsesCreatedEvent,
    buildResponsesFunctionCallArgumentsDoneEvent,
    buildResponsesOutputItemAddedEvent,
    buildResponsesOutputItemDoneEvent,
    buildResponsesOutputTextDeltaEvent,
    buildResponsesOutputTextDoneEvent,
    buildResponsesResponseObject,
    createResponsesItemId,
    createResponsesMessageItem,
    createResponsesReasoningItem,
} from '../modules/openaiResponsesFormat.js';
import {
    extractTextFromContent,
    extractInputAudioFromContent,
    extractImageUrlFromContent,
    extractTextFromMessages,
    extractInputAudioFromMessages,
    extractImageUrlFromMessages,
    extractTextFromResponsesInput,
    extractInputAudioFromResponsesInput,
    extractImageUrlFromResponsesInput,
} from '../modules/contentExtraction.js';
import {
    normalizeInputAudio,
    detectMimeTypeFromBuffer,
    detectMimeTypeFromBase64,
    isLikelyBase64,
    parseMultipartBody,
} from '../modules/mediaParsing.js';
import { inlineImageUrls as inlineImageUrlsShared } from '../modules/imageFetch.js';
import {
    isImageModelId,
    isNanoBananaModel,
    ensureNanoBananaModalities,
    isNonChatModel,
    composeAssistantContent,
    inferToolCallsFromJsonText,
    filterValidChatMessages,
} from '../modules/openaiRouteUtils.js';
import {
    generateUserApiKey, // Now async
    extractMessageFromRequestBody,
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage, // Now async
} from '../modules/userData.js';
// Import TierData type for Request extension
import { TierData, type KeysFile } from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js';
import redis from '../modules/db.js';
import tiersData from '../tiers.json' with { type: 'json' };
import { buildKeyDetailsPayload, loadKeysLiveSnapshot } from '../modules/keyUsage.js';
import { incrementSharedRateLimitCounters } from '../modules/rateLimitRedis.js';
import { enforceInMemoryRateLimit, evaluateSharedRateLimit, RequestTimestampStore } from '../modules/rateLimit.js';
import { runAuthMiddleware, runRateLimitMiddleware, extractBearerToken, normalizeApiKey } from '../modules/middlewareFactory.js';
import { dataManager, LoadedProviders, LoadedProviderData, type ModelsFileStructure } from '../modules/dataManager.js';
import { logger } from '../modules/logger.js';
import { redactAuthorizationHeader, redactToken, hashToken } from '../modules/redaction.js';
import { fetchWithTimeout } from '../modules/http.js';
import { RequestQueue, QueueOverloadedError, requestQueue } from '../modules/requestQueue.js';
import {
    getHeaderValue,
    normalizeImageFetchReferer,
    extractUsageTokens,
    createSseDataParser,
} from '../modules/openaiRequestSupport.js';
import {
    authAndUsageMiddleware,
    authKeyOnlyMiddleware,
    createRateLimitMiddleware,
    formatRateLimitMessage,
    getServiceTierForUserTier,
    isGeminiFreeTierZeroQuota,
} from '../modules/openaiRouteSupport.js';
import {
    enforceModelCapabilities,
    pickOpenAIProviderKey,
    pickImageGenProviderKey,
    pickVideoGenProviderKey,
    pickAnyXaiProviderKey,
} from '../modules/openaiProviderSelection.js';
import { AUDIO_CONTENT_TYPES, forwardTtsToOpenAI, forwardSttToOpenAI } from '../modules/openaiAudio.js';
import { handleImageGenFallbackFromChatOrResponses, handleVideoGenFallbackFromChatOrResponses } from '../modules/openaiFallbacks.js';
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
import {
    readEnvNumber,
    readEnvBool,
    readEnvCsv,
    BASE64_DATA_URL_GLOBAL,
    IMAGE_INPUT_TOKENS_PER_KB,
    IMAGE_OUTPUT_TOKENS_PER_KB,
    AUDIO_INPUT_TOKENS_PER_KB,
    AUDIO_OUTPUT_TOKENS_PER_KB,
    IMAGE_URL_FALLBACK_TOKENS,
    AUDIO_DATA_FALLBACK_TOKENS,
    IMAGE_MIN_TOKENS,
    AUDIO_MIN_TOKENS,
    estimateTokensFromBase64Payload,
    estimateTokensFromDataUrl,
    estimateTokensFromText,
    estimateTokensFromContent,
} from '../modules/tokenEstimation.js';
import {
    isRateLimitOrQuotaError as isRateLimitError,
    extractRetryAfterSeconds,
} from '../modules/errorClassification.js';
 
dotenv.config();
 
const openaiRouter = new HyperExpress.Router();
 
// --- Rate Limiting Store --- 
const requestTimestamps: RequestTimestampStore = {};
const INTERACTIONS_TOKEN_TTL_SECONDS = 15 * 60;
const rateLimitMiddleware = createRateLimitMiddleware(requestTimestamps);

function writeResponsesSseEvent(response: Response, payload: Record<string, any>): void {
    response.write(`event: ${payload.type}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeToolCallsForStream(toolCalls: any[] | undefined): any[] | undefined {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
    return toolCalls.map((call: any, index: number) => {
        const normalizedCall = call && typeof call === 'object' ? { ...call } : { type: 'function' };
        normalizedCall.index = typeof normalizedCall.index === 'number' ? normalizedCall.index : index;
        if (normalizedCall.function && typeof normalizedCall.function === 'object') {
            normalizedCall.function = {
                ...normalizedCall.function,
                arguments: typeof normalizedCall.function.arguments === 'string'
                    ? normalizedCall.function.arguments
                    : JSON.stringify(normalizedCall.function.arguments ?? {}),
            };
        }
        return normalizedCall;
    });
}

function extractResponsesRequestBody(requestBody: any): { message: IMessage; modelId: string; stream: boolean } {
    if (!requestBody || typeof requestBody !== 'object') {
        throw new Error('Invalid request body.');
    }

    if (requestBody.reasoning === undefined && requestBody.reasoning_effort !== undefined) {
        requestBody.reasoning = requestBody.reasoning_effort;
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
    const previousResponseId = typeof requestBody.previous_response_id === 'string' && requestBody.previous_response_id.trim()
        ? requestBody.previous_response_id.trim()
        : undefined;

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
        instructions: requestBody.instructions,
        previous_response_id: previousResponseId,
        stream_options: (requestBody.stream_options && typeof requestBody.stream_options === 'object')
            ? requestBody.stream_options
            : undefined
    };

    return { message, modelId, stream: Boolean(requestBody.stream) };
}

// Token estimation constants now imported from '../modules/tokenEstimation.js'
const LOG_SENSITIVE_PAYLOADS = readEnvBool('LOG_SENSITIVE_PAYLOADS', false);
if (LOG_SENSITIVE_PAYLOADS) {
    console.warn('[Security] LOG_SENSITIVE_PAYLOADS is enabled. Disable in production to avoid logging sensitive data.');
}

function getBaselineTierRps(): number {
    const values = Object.values(tiersData as Record<string, any>)
        .map((tier) => Number(tier?.rps))
        .filter((value) => Number.isFinite(value) && value > 0);
    if (values.length === 0) return 20;
    return Math.floor(Math.min(...values));
}

const BASELINE_TIER_RPS = getBaselineTierRps();
const UPSTREAM_TIMEOUT_MS = readEnvNumber('UPSTREAM_TIMEOUT_MS', 120_000);
const EMBEDDINGS_QUEUE_CONCURRENCY = Math.max(1, readEnvNumber('EMBEDDINGS_QUEUE_CONCURRENCY', Math.max(1, Math.min(8, Math.floor(BASELINE_TIER_RPS / 10)))));
const EMBEDDINGS_QUEUE_MAX_PENDING = Math.max(0, readEnvNumber('EMBEDDINGS_QUEUE_MAX_PENDING', Math.max(8, Math.min(64, BASELINE_TIER_RPS))));
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

export function getOpenAiAdmissionQueueSnapshots(): Array<Record<string, unknown>> {
    return [
        {
            lane: 'shared-request-handler',
            routes: ['/v1/chat/completions', '/v1/responses'],
            shared: true,
            ...requestQueue.snapshot(),
        }, {
            lane: 'embeddings',
            route: '/v1/embeddings',
            shared: false,
            ...embeddingsQueue.snapshot(),
        },
    ];
}

const embeddingsQueue = new RequestQueue(EMBEDDINGS_QUEUE_CONCURRENCY, {
    label: 'embeddings-admission',
    maxPending: EMBEDDINGS_QUEUE_MAX_PENDING,
});

function attachQueueOverloadMetadata(error: unknown, queue: RequestQueue, extra: Record<string, unknown> = {}): void {
    if (!(error instanceof QueueOverloadedError) && typeof error !== 'object') return;
    const target = error as Record<string, unknown>;
    const snapshot = queue.snapshot();
    target.queueLabel = typeof target.queueLabel === 'string' && String(target.queueLabel).trim()
        ? target.queueLabel
        : snapshot.label;
    target.queue = {
        label: snapshot.label,
        concurrency: snapshot.concurrency,
        maxPending: snapshot.maxPending,
        inFlight: snapshot.inFlight,
        pending: snapshot.pending,
        overloadCount: snapshot.overloadCount,
        lastOverloadedAt: snapshot.lastOverloadedAt,
        ...extra,
    };
}

// readEnvNumber, readEnvBool, readEnvCsv now imported from '../modules/tokenEstimation.js'

const videoRequestCache = new Map<string, { apiKey: string; baseUrl: string; expiresAt: number }>();
const VIDEO_CACHE_EVICTION_INTERVAL_MS = 5 * 60 * 1000;

// Periodic eviction to prevent unbounded Map growth
const _videoCacheEvictionTimer = setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of videoRequestCache) {
        if (entry.expiresAt < now) {
            videoRequestCache.delete(key);
            evicted++;
        }
    }
    if (evicted > 0) {
        console.log(`[VideoCacheEviction] Swept ${evicted} expired entries. Remaining: ${videoRequestCache.size}`);
    }
}, VIDEO_CACHE_EVICTION_INTERVAL_MS);
if (typeof (_videoCacheEvictionTimer as any).unref === 'function') (_videoCacheEvictionTimer as any).unref();

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

// estimateTokensFromBase64Payload, estimateTokensFromDataUrl, estimateTokensFromText,
// estimateTokensFromContent now imported from '../modules/tokenEstimation.js'

// --- Routes ---
 
// Generate Key Route - Handler becomes async
openaiRouter.post('/generate_key', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
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

 
// Key Details Route (no token-usage enforcement)
openaiRouter.get('/keys/me', authKeyOnlyMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
    try {
        const apiKey = request.apiKey;
        if (!apiKey) {
            if (!response.completed) {
                return response.status(401).json({ error: 'Unauthorized: Missing API key', timestamp: new Date().toISOString() });
            }
            return;
        }

        const keys = await dataManager.load<KeysFile>('keys');
        const userData = keys[apiKey];
        if (!userData) {
            if (!response.completed) {
                return response.status(401).json({ error: 'Unauthorized: Invalid API key', timestamp: new Date().toISOString() });
            }
            return;
        }

        const tierLimits = request.tierLimits || tiersData[userData.tier as keyof typeof tiersData];
        return response.json(buildKeyDetailsPayload(apiKey, userData, tierLimits, 'cache'));
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
        }
    }
});

openaiRouter.get('/keys/me/live', authKeyOnlyMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
    try {
        const apiKey = request.apiKey;
        if (!apiKey) {
            if (!response.completed) {
                return response.status(401).json({ error: 'Unauthorized: Missing API key', timestamp: new Date().toISOString() });
            }
            return;
        }

        const { keys, source } = await loadKeysLiveSnapshot();
        const userData = keys[apiKey];
        if (!userData) {
            if (!response.completed) {
                return response.status(401).json({ error: 'Unauthorized: Invalid API key', timestamp: new Date().toISOString() });
            }
            return;
        }

        const tierLimits = request.tierLimits || tiersData[userData.tier as keyof typeof tiersData];
        return response.json(buildKeyDetailsPayload(apiKey, userData, tierLimits, source));
    } catch (error: any) {
        await logError(error, request);
        if (!response.completed) {
            response.status(500).json({ error: 'Internal Server Error', timestamp: new Date().toISOString() });
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
                                console.log(`[Multipart] Injecting image. Type: ${f.type}, Size: ${f.data.length}`);
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
                console.log(`[RawFallback] Buffer size: ${rawBuffer.length}`);
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

                    console.log(`[RawFallback] Type: ${mimeType}, Base64Len: ${base64Data.length}`);

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

    const normalizedMaxTokens = typeof requestBody?.max_tokens === 'number'
        ? requestBody.max_tokens
        : (typeof requestBody?.max_tokens === 'string' ? Number(requestBody.max_tokens) : undefined);
    if (normalizedMaxTokens !== undefined) {
        const maxTokensLimit = Math.max(0, Number(process.env.MAX_MAX_TOKENS || 0) || 0);
        if (!Number.isFinite(normalizedMaxTokens) || normalizedMaxTokens <= 0) {
            return response.status(400).json({ error: 'Invalid max_tokens value.', timestamp: new Date().toISOString() });
        }
        if (maxTokensLimit > 0 && normalizedMaxTokens > maxTokensLimit) {
            return response.status(400).json({ error: `max_tokens exceeds limit (${maxTokensLimit}).`, timestamp: new Date().toISOString() });
        }
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
    await inlineImageUrlsShared(rawMessages, request.headers['authorization'], imageFetchReferer, {
        allowedHosts: IMAGE_FETCH_ALLOWED_HOSTS,
        allowedProtocols: IMAGE_FETCH_ALLOWED_PROTOCOLS,
        allowPrivate: IMAGE_FETCH_ALLOW_PRIVATE,
        forwardAuth: IMAGE_FETCH_FORWARD_AUTH,
        userAgent: IMAGE_FETCH_USER_AGENT,
        referer: IMAGE_FETCH_REFERER,
        timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
        maxRedirects: IMAGE_FETCH_MAX_REDIRECTS,
        maxBytes: IMAGE_FETCH_MAX_BYTES,
        logSensitivePayloads: LOG_SENSITIVE_PAYLOADS,
    });

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

    if (requestBody?.reasoning === undefined && requestBody?.reasoning_effort !== undefined) {
        requestBody.reasoning = requestBody.reasoning_effort;
    }

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
                reasoning: interactionBody.reasoning ?? interactionBody.reasoning_effort ?? requestBody.reasoning,
            };

        const secret = getInteractionsSigningSecret();
        const interactionId = createInteractionToken(
            interactionRequest,
            userApiKey,
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
                upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
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
                response,
                source: 'chat',
                upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
                setVideoRequestCache,
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
    const includeUsageInStream = Boolean(requestBody?.stream_options?.include_usage);
    
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
        stream_options: (requestBody.stream_options && typeof requestBody.stream_options === 'object')
            ? requestBody.stream_options
            : undefined,
    };
    if (isNanoBananaModel(modelId)) {
        sharedMessageOptions.modalities = ensureNanoBananaModalities(sharedMessageOptions.modalities);
    }

        const formattedMessages: IMessage[] = rawMessages.map(msg => ({
            ...msg,
            model: { id: modelId },
            ...sharedMessageOptions,
            image_fetch_referer: imageFetchReferer,
        }));
 
    if (effectiveStream) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');

        if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
            const started = Date.now();
            const requestId = `chatcmpl-${Date.now()}`;
            const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey, { requestId: request.requestId });
            const inferredToolCalls = (!result.tool_calls || result.tool_calls.length === 0)
                ? inferToolCallsFromJsonText(result.response, requestBody.tools, requestBody.tool_choice)
                : undefined;
            const effectiveToolCalls = (result.tool_calls && result.tool_calls.length > 0)
                ? result.tool_calls
                : inferredToolCalls;
            const assistantContent = effectiveToolCalls?.length ? null : composeAssistantContent(result.response, result.reasoning);
            if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && (!assistantContent || assistantContent.trim().length === 0)) {
                throw new Error('Empty chat completion output from provider.');
            }
            const streamingToolCalls = normalizeToolCallsForStream(effectiveToolCalls);

            const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
            const promptTokensUsed = typeof result.promptTokens === 'number' ? result.promptTokens : undefined;
            const completionTokensUsed = typeof result.completionTokens === 'number' ? result.completionTokens : undefined;
            await updateUserTokenUsage(totalTokensUsed, userApiKey, { modelId, promptTokens: promptTokensUsed, completionTokens: completionTokensUsed });

            const roleChunk = {
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(started / 1000),
                model: modelId,
                choices: [{
                    index: 0,
                    delta: { role: 'assistant' },
                    finish_reason: null
                }]
            };
            response.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

            if (streamingToolCalls?.length) {
                const toolChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: { tool_calls: streamingToolCalls },
                        finish_reason: null
                    }]
                };
                response.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
            } else if (assistantContent) {
                const contentChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: { content: assistantContent },
                        finish_reason: null
                    }]
                };
                response.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
            }

            const finalChunk = {
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(started / 1000),
                model: modelId,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: effectiveToolCalls?.length ? 'tool_calls' : (result.finish_reason || 'stop')
                }]
            };
            if (includeUsageInStream) {
                (finalChunk as any).usage = {
                    prompt_tokens: promptTokensUsed,
                    completion_tokens: completionTokensUsed,
                    total_tokens: totalTokensUsed
                };
            }
            response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            response.write(`data: [DONE]\n\n`);
            return response.end();
        }
        
        const shouldDisableChatPassthrough =
            (Array.isArray(requestBody.tools) && requestBody.tools.length > 0)
            || typeof requestBody.tool_choice !== 'undefined'
            || typeof requestBody.reasoning !== 'undefined';
        const streamHandler = messageHandler.handleStreamingMessages(formattedMessages, modelId, userApiKey, {
            disablePassthrough: shouldDisableChatPassthrough,
            requestId: request.requestId,
        });
        const started = Date.now();
        const requestId = `chatcmpl-${Date.now()}`;
        
        let totalTokenUsage = 0;
        let passthroughHandled = false;
        let fallbackToNormalized = false;
        let promptTokensFromUsage: number | undefined;
        let completionTokensFromUsage: number | undefined;
        let promptTokensFinal: number | undefined;
        let completionTokensFinal: number | undefined;
        let streamOutputText = '';
        let toolCallsFromStream: any[] | undefined;
        let finishReasonFromStream: string | undefined;
        let sentAssistantRoleChunk = false;
        const canInferToolCallsFromText = Array.isArray(requestBody.tools) && requestBody.tools.length > 0;
        let bufferingStructuredJson = false;
        let pendingReasoningText = '';

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
                if (typeof result.reasoning === 'string' && result.reasoning) {
                    pendingReasoningText += result.reasoning;
                }
                const hasToolCallChunk = Array.isArray(result.tool_calls) && result.tool_calls.length > 0;
                let chunkContent = hasToolCallChunk
                    ? ''
                    : (typeof result.chunk === 'string' ? result.chunk : '');
                if (chunkContent && pendingReasoningText) {
                    chunkContent = composeAssistantContent(chunkContent, pendingReasoningText);
                    pendingReasoningText = '';
                }
                if (hasToolCallChunk) toolCallsFromStream = result.tool_calls;
                if (result.finish_reason) finishReasonFromStream = result.finish_reason;
                if (chunkContent) streamOutputText += chunkContent;
                if (!toolCallsFromStream && canInferToolCallsFromText) {
                    const trimmedSoFar = streamOutputText.trimStart();
                    if (bufferingStructuredJson || trimmedSoFar.startsWith('{') || trimmedSoFar.startsWith('[')) {
                        bufferingStructuredJson = true;
                    }
                }
                if (!sentAssistantRoleChunk) {
                    const roleChunk = {
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(started / 1000),
                        model: modelId,
                        choices: [{
                            index: 0,
                            delta: { role: 'assistant' },
                            finish_reason: null
                        }]
                    };
                    response.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
                    sentAssistantRoleChunk = true;
                }
                if (bufferingStructuredJson && !toolCallsFromStream) {
                    continue;
                }
                const hasContentChunk = chunkContent.length > 0;
                const streamedToolCalls = hasToolCallChunk ? normalizeToolCallsForStream(result.tool_calls) : undefined;
                if (!hasContentChunk && !hasToolCallChunk) {
                    continue;
                }
                const openaiStreamChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: {
                            ...(hasContentChunk ? { content: chunkContent } : {}),
                            ...(streamedToolCalls && streamedToolCalls.length > 0
                                ? { tool_calls: streamedToolCalls }
                                : {}),
                        },
                        finish_reason: result.finish_reason || null
                    }]
                };
                response.write(`data: ${JSON.stringify(openaiStreamChunk)}\n\n`);
            } else if (result.type === 'final') {
                // Capture final metrics from the stream
                if (typeof result.tokenUsage === 'number') totalTokenUsage = result.tokenUsage;
                if (typeof result.promptTokens === 'number') promptTokensFinal = result.promptTokens;
                if (typeof result.completionTokens === 'number') completionTokensFinal = result.completionTokens;
                if (typeof result.response === 'string' && result.response) streamOutputText = result.response;
                if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) toolCallsFromStream = result.tool_calls;
                if (result.finish_reason) finishReasonFromStream = result.finish_reason;
            }
        }

        if (fallbackToNormalized) {
                const fallbackStreamHandler = messageHandler.handleStreamingMessages(formattedMessages, modelId, userApiKey, { disablePassthrough: true, requestId: request.requestId });
            for await (const fallbackResult of fallbackStreamHandler) {
                if (fallbackResult.type === 'chunk') {
                    if (typeof fallbackResult.reasoning === 'string' && fallbackResult.reasoning) {
                        pendingReasoningText += fallbackResult.reasoning;
                    }
                    const hasFallbackToolCallChunk = Array.isArray(fallbackResult.tool_calls) && fallbackResult.tool_calls.length > 0;
                    let fallbackChunkContent = hasFallbackToolCallChunk
                        ? ''
                        : (typeof fallbackResult.chunk === 'string' ? fallbackResult.chunk : '');
                    if (fallbackChunkContent && pendingReasoningText) {
                        fallbackChunkContent = composeAssistantContent(fallbackChunkContent, pendingReasoningText);
                        pendingReasoningText = '';
                    }
                    if (hasFallbackToolCallChunk) toolCallsFromStream = fallbackResult.tool_calls;
                    if (fallbackResult.finish_reason) finishReasonFromStream = fallbackResult.finish_reason;
                    if (fallbackChunkContent) streamOutputText += fallbackChunkContent;
                    if (!toolCallsFromStream && canInferToolCallsFromText) {
                        const trimmedSoFar = streamOutputText.trimStart();
                        if (bufferingStructuredJson || trimmedSoFar.startsWith('{') || trimmedSoFar.startsWith('[')) {
                            bufferingStructuredJson = true;
                        }
                    }
                    if (!sentAssistantRoleChunk) {
                        const roleChunk = {
                            id: requestId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(started / 1000),
                            model: modelId,
                            choices: [{
                                index: 0,
                                delta: { role: 'assistant' },
                                finish_reason: null
                            }]
                        };
                        response.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
                        sentAssistantRoleChunk = true;
                    }
                    if (bufferingStructuredJson && !toolCallsFromStream) {
                        continue;
                    }
                    const hasFallbackContentChunk = fallbackChunkContent.length > 0;
                    const streamedFallbackToolCalls = hasFallbackToolCallChunk ? normalizeToolCallsForStream(fallbackResult.tool_calls) : undefined;
                    if (!hasFallbackContentChunk && !hasFallbackToolCallChunk) {
                        continue;
                    }
                    const openaiStreamChunk = {
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(started / 1000),
                        model: modelId,
                        choices: [{
                            index: 0,
                            delta: {
                                ...(hasFallbackContentChunk ? { content: fallbackChunkContent } : {}),
                                ...(streamedFallbackToolCalls && streamedFallbackToolCalls.length > 0
                                    ? { tool_calls: streamedFallbackToolCalls }
                                    : {}),
                            },
                            finish_reason: fallbackResult.finish_reason || null
                        }]
                    };
                    response.write(`data: ${JSON.stringify(openaiStreamChunk)}\n\n`);
                } else if (fallbackResult.type === 'final') {
                    if (fallbackResult.tokenUsage) totalTokenUsage = fallbackResult.tokenUsage;
                    if (typeof fallbackResult.promptTokens === 'number') promptTokensFinal = fallbackResult.promptTokens;
                    if (typeof fallbackResult.completionTokens === 'number') completionTokensFinal = fallbackResult.completionTokens;
                    if (typeof fallbackResult.response === 'string' && fallbackResult.response) streamOutputText = fallbackResult.response;
                    if (Array.isArray(fallbackResult.tool_calls) && fallbackResult.tool_calls.length > 0) toolCallsFromStream = fallbackResult.tool_calls;
                    if (fallbackResult.finish_reason) finishReasonFromStream = fallbackResult.finish_reason;
                }
            }
        }

        if (pendingReasoningText && (!toolCallsFromStream || toolCallsFromStream.length === 0)) {
            if (!sentAssistantRoleChunk) {
                const roleChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: { role: 'assistant' },
                        finish_reason: null
                    }]
                };
                response.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
                sentAssistantRoleChunk = true;
            }
            const bufferedReasoningContent = composeAssistantContent('', pendingReasoningText);
            streamOutputText += bufferedReasoningContent;
            response.write(`data: ${JSON.stringify({
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(started / 1000),
                model: modelId,
                choices: [{
                    index: 0,
                    delta: { content: bufferedReasoningContent },
                    finish_reason: null
                }]
            })}\n\n`);
            pendingReasoningText = '';
        }

        if (passthroughHandled) {
            if (totalTokenUsage <= 0) {
                const promptEstimate = typeof promptTokensFromUsage === 'number' ? promptTokensFromUsage : formattedMessages.reduce((sum, msg) => {
                    return sum + estimateTokensFromContent(msg.content);
                }, 0);
                const completionEstimate = typeof completionTokensFromUsage === 'number' ? completionTokensFromUsage : estimateTokensFromText(streamOutputText);
                totalTokenUsage = promptEstimate + completionEstimate;
            }

            await updateUserTokenUsage(totalTokenUsage, userApiKey, { modelId });
            if (!response.completed) return response.end();
            return;
        }
        
        const finalPromptTokens = typeof promptTokensFinal === 'number'
            ? promptTokensFinal
            : (typeof promptTokensFromUsage === 'number'
                ? promptTokensFromUsage
                : formattedMessages.reduce((sum, msg) => sum + estimateTokensFromContent(msg.content), 0));
        const finalCompletionTokens = typeof completionTokensFinal === 'number'
            ? completionTokensFinal
            : (typeof completionTokensFromUsage === 'number'
                ? completionTokensFromUsage
                : estimateTokensFromText(streamOutputText));
        if (totalTokenUsage <= 0) {
            totalTokenUsage = finalPromptTokens + finalCompletionTokens;
        }

        await updateUserTokenUsage(totalTokenUsage, userApiKey, { modelId, promptTokens: finalPromptTokens, completionTokens: finalCompletionTokens });

        if ((!toolCallsFromStream || toolCallsFromStream.length === 0) && streamOutputText) {
            const inferredToolCalls = inferToolCallsFromJsonText(streamOutputText, requestBody.tools, requestBody.tool_choice);
            if (inferredToolCalls && inferredToolCalls.length > 0) {
                toolCallsFromStream = inferredToolCalls;
                finishReasonFromStream = 'tool_calls';
                const inferredToolChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: normalizeToolCallsForStream(inferredToolCalls),
                        },
                        finish_reason: null
                    }]
                };
                response.write(`data: ${JSON.stringify(inferredToolChunk)}\n\n`);
            } else if (bufferingStructuredJson && streamOutputText) {
                const bufferedContentChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(started / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: {
                            content: streamOutputText,
                        },
                        finish_reason: null
                    }]
                };
                response.write(`data: ${JSON.stringify(bufferedContentChunk)}\n\n`);
            }
        }
         
        const finalChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(started / 1000),
            model: modelId,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReasonFromStream || (toolCallsFromStream?.length ? 'tool_calls' : 'stop')
            }]
        };
        if (includeUsageInStream) {
            (finalChunk as any).usage = {
                prompt_tokens: finalPromptTokens,
                completion_tokens: finalCompletionTokens,
                total_tokens: totalTokenUsage
            };
        }
        response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        response.write(`data: [DONE]\n\n`);
        return response.end();

    } else {
        // messageHandler call is already async
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey, { requestId: request.requestId });
        const inferredToolCalls = (!result.tool_calls || result.tool_calls.length === 0)
            ? inferToolCallsFromJsonText(result.response, requestBody.tools, requestBody.tool_choice)
            : undefined;
        const effectiveToolCalls = (result.tool_calls && result.tool_calls.length > 0)
            ? result.tool_calls
            : inferredToolCalls;
        const assistantContent = effectiveToolCalls?.length ? null : composeAssistantContent(result.response, result.reasoning);
        if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && (!assistantContent || assistantContent.trim().length === 0)) {
            throw new Error('Empty chat completion output from provider.');
        }
    
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const promptTokensUsed = typeof result.promptTokens === 'number' ? result.promptTokens : undefined;
        const completionTokensUsed = typeof result.completionTokens === 'number' ? result.completionTokens : undefined;
        await updateUserTokenUsage(totalTokensUsed, userApiKey, { modelId, promptTokens: promptTokensUsed, completionTokens: completionTokensUsed });
    
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
                            ...(effectiveToolCalls && effectiveToolCalls.length > 0
                                ? { tool_calls: effectiveToolCalls }
                                : {}),
                        },
                        logprobs: null, // OpenAI includes this, set to null if not applicable
                        finish_reason: effectiveToolCalls?.length ? 'tool_calls' : (result.finish_reason || "stop"),
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
    attachQueueOverloadMetadata(error, requestQueue, {
        route: '/v1/chat/completions',
        lane: 'chat-completions',
    });
    await logError(error, request);
    const errorText = String(error?.message || '');
    console.error('Chat completions error:', errorText, error.stack);
    const timestamp = new Date().toISOString();
    let statusCode = 500;
    let clientMessage = 'Internal Server Error';
    let clientReference = 'An unexpected error occurred while processing your chat request.';
    const errorMeta = error as any;
    const retryAfterSeconds = extractRetryAfterSeconds(errorText);
    const rateLimitMessage = formatRateLimitMessage(retryAfterSeconds);
    const isFreeTierZeroQuota = isGeminiFreeTierZeroQuota(errorText);
    const errorModelId = errorMeta?.modelId;

    // All providers rate-limited — return 429 with Retry-After
    if (typeof errorMeta?.statusCode === 'number' && errorMeta.statusCode >= 400 && errorMeta.statusCode < 600) {
        statusCode = errorMeta.statusCode;
        clientMessage = errorText || clientMessage;
    } else if (isFreeTierZeroQuota) {
        statusCode = 403;
        clientMessage = errorModelId
            ? `Model ${errorModelId} is not available for Gemini free-tier keys. Use a different model or a paid Gemini key.`
            : 'This model is not available for Gemini free-tier keys. Use a different model or a paid Gemini key.';
    } else if (errorMeta?.allSkippedByRateLimit) {
        statusCode = 429;
        clientMessage = rateLimitMessage;
    } else if (errorMeta?.code === 'INPUT_TOKENS_EXCEEDED' && errorMeta?.hasImageInput) {
        statusCode = 400;
        clientMessage = 'Bad Request: image input too large for the model limit. Reduce image size or use a smaller image URL.';
    } else if (errorText.startsWith('Invalid request') || errorText.startsWith('Failed to parse')) {
        statusCode = 400;
        clientMessage = `Bad Request: ${errorText}`;
    } else if (error instanceof SyntaxError) {
        statusCode = 400;
        clientMessage = 'Invalid JSON';
    } else if (isRateLimitError(errorText)) {
        statusCode = 429;
        clientMessage = rateLimitMessage;
    } else if (errorText.includes('Unauthorized') || errorText.includes('limit reached')) {
        statusCode = errorText.includes('limit reached') ? 429 : 401;
        clientMessage = errorText.includes('limit reached') ? rateLimitMessage : errorText;
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
    } else if (
        errorText.toLowerCase().includes('input token count exceeds') ||
        errorText.toLowerCase().includes('maximum number of tokens allowed')
    ) {
        statusCode = 400;
        clientMessage = 'Bad Request: input token count exceeds the model limit. Reduce the prompt size or truncate history.';
    } else if (
        errorText.includes('fetching image from URL') ||
        errorText.includes('image_url') ||
        errorText.toLowerCase().includes('cannot fetch content from the provided url')
    ) {
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
       if (statusCode === 429 && retryAfterSeconds) {
           response.setHeader('Retry-After', String(retryAfterSeconds));
       }
       if (statusCode === 500) {
            response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
       } else {
            const payload: Record<string, any> = { error: clientMessage, timestamp };
            if (statusCode === 429 && retryAfterSeconds) {
                payload.retry_after_seconds = retryAfterSeconds;
            }
            response.status(statusCode).json(payload);
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
        const requestBody = await request.json();
        const userApiKey = request.apiKey!;

    if (requestBody?.reasoning === undefined && requestBody?.reasoning_effort !== undefined) {
        requestBody.reasoning = requestBody.reasoning_effort;
    }

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
                reasoning: interactionBody.reasoning ?? interactionBody.reasoning_effort ?? requestBody.reasoning,
            };

            const secret = getInteractionsSigningSecret();
            const interactionId = createInteractionToken(
                interactionRequest,
                userApiKey,
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
        const localPreviousResponseId = typeof message.previous_response_id === 'string' && message.previous_response_id.trim()
            ? message.previous_response_id.trim()
            : undefined;
        if (localPreviousResponseId) {
            const previousEntry = await loadResponsesHistoryEntry(localPreviousResponseId);
            if (previousEntry) {
                const nextInput = Array.isArray(message.content) ? message.content : [message.content];
                message.content = mergeResponsesHistoryInput(previousEntry, nextInput);
            } else {
                console.warn(`[ResponsesHistory] previous_response_id ${localPreviousResponseId} was not found locally; continuing with request input only.`);
            }
            delete (message as any).previous_response_id;
        }
        const responsesHistoryInput = Array.isArray(message.content)
            ? cloneResponsesHistoryValue(message.content)
            : [cloneResponsesHistoryValue(message.content)];
        message.service_tier = getServiceTierForUserTier(request.userTier);
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
                    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
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
                    response,
                    source: 'responses',
                    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
                    setVideoRequestCache,
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
        if (message.tools || message.tool_choice) {
            const capsOk = await enforceModelCapabilities(modelId, ['tool_calling'], response);
            if (!capsOk) return;
        }

        const responseId = `resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);
        const responseMessageId = createResponsesItemId('msg');
        const basePayload = { id: responseId, object: 'response', created, model: modelId };

        if (effectiveStream) {
            response.setHeader('Content-Type', 'text/event-stream');
            response.setHeader('Cache-Control', 'no-cache');
            response.setHeader('Connection', 'keep-alive');
            const shouldDisableResponsesPassthrough =
                (Array.isArray(message.tools) && message.tools.length > 0)
                || typeof message.tool_choice !== 'undefined'
                || typeof message.reasoning !== 'undefined';
            const streamHandler = messageHandler.handleStreamingMessages([message], modelId, userApiKey, {
                disablePassthrough: shouldDisableResponsesPassthrough,
                requestId: request.requestId,
            });
            let totalTokenUsage = 0;
            let fullText = '';
            let toolCallsFromStream: any[] | undefined;
            let finishReasonFromStream: string | undefined;
            let passthroughHandled = false;
            let fallbackToNormalized = false;
            let promptTokensFromUsage: number | undefined;
            let completionTokensFromUsage: number | undefined;
            let promptTokensFinal: number | undefined;
            let completionTokensFinal: number | undefined;
            let responsesCreatedSent = false;
            let responsesTextItemStarted = false;
            let pendingReasoningText = '';
            let streamedReasoningText = '';
            const canInferResponsesToolCallsFromText = Array.isArray(message.tools) && message.tools.length > 0;
            let bufferingStructuredJson = false;
            const reasoningItemId = createResponsesItemId('msg');
            let reasoningItemStarted = false;

            const persistResponsesStreamSideEffects = (
                outputText: string,
                totalTokens: number,
                promptTokens: number | undefined,
                completionTokens: number | undefined,
                toolCalls: any[] | undefined,
            ) => {
                void (async () => {
                    try {
                        await saveResponsesHistoryEntry({
                            id: responseId,
                            model: modelId,
                            input: responsesHistoryInput,
                            output: buildStoredResponsesHistoryOutput(outputText, toolCalls),
                            output_text: outputText,
                            created,
                        });
                    } catch (historyError: any) {
                        await logError({
                            message: 'Failed to persist responses history entry after stream completion',
                            errorMessage: historyError?.message,
                            errorStack: historyError?.stack,
                            context: { modelId, responseId, requestId: request.requestId }
                        }, request);
                    }

                    try {
                        await updateUserTokenUsage(totalTokens, userApiKey, { modelId, promptTokens, completionTokens });
                    } catch (usageError: any) {
                        await logError({
                            message: 'Failed to update token usage after responses stream completion',
                            errorMessage: usageError?.message,
                            errorStack: usageError?.stack,
                            context: { modelId, responseId, requestId: request.requestId, totalTokens }
                        }, request);
                    }
                })();
            };

            const getAssistantOutputIndex = () => (reasoningItemStarted ? 1 : 0);

            const ensureResponsesCreated = () => {
                if (responsesCreatedSent) return;
                writeResponsesSseEvent(response, buildResponsesCreatedEvent({
                    ...basePayload,
                    status: 'in_progress',
                    output: [],
                    output_text: '',
                }));
                responsesCreatedSent = true;
            };

            const ensureResponsesTextItemStarted = () => {
                ensureResponsesCreated();
                if (responsesTextItemStarted) return;
                writeResponsesSseEvent(response, buildResponsesOutputItemAddedEvent({
                    responseId,
                    outputIndex: getAssistantOutputIndex(),
                    item: createResponsesMessageItem('', { id: responseMessageId, status: 'in_progress' }),
                }));
                writeResponsesSseEvent(response, buildResponsesContentPartAddedEvent({
                    responseId,
                    itemId: responseMessageId,
                    outputIndex: getAssistantOutputIndex(),
                    contentIndex: 0,
                    part: { type: 'output_text', text: '' },
                }));
                responsesTextItemStarted = true;
            };

            const ensureResponsesReasoningItemStarted = () => {
                ensureResponsesCreated();
                if (reasoningItemStarted) return;
                writeResponsesSseEvent(response, buildResponsesOutputItemAddedEvent({
                    responseId,
                    outputIndex: 0,
                    item: createResponsesReasoningItem('', { id: reasoningItemId, status: 'in_progress' }),
                }));
                writeResponsesSseEvent(response, {
                    type: 'response.reasoning_summary_part.added',
                    response_id: responseId,
                    item_id: reasoningItemId,
                    output_index: 0,
                    summary_index: 0,
                    part: { type: 'summary_text', text: '' },
                });
                reasoningItemStarted = true;
            };

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
                    if (typeof result.reasoning === 'string' && result.reasoning) {
                        ensureResponsesReasoningItemStarted();
                        streamedReasoningText += result.reasoning;
                        writeResponsesSseEvent(response, {
                            type: 'response.reasoning_summary_text.delta',
                            response_id: responseId,
                            item_id: reasoningItemId,
                            output_index: 0,
                            summary_index: 0,
                            delta: result.reasoning,
                        });
                    }
                    if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
                        toolCallsFromStream = result.tool_calls;
                    }
                    if (result.finish_reason) finishReasonFromStream = result.finish_reason;
                    if (typeof result.chunk === 'string' && result.chunk.length > 0) {
                        let deltaText = result.chunk;
                        fullText += deltaText;
                        if (!toolCallsFromStream && canInferResponsesToolCallsFromText) {
                            const inferred = inferToolCallsFromJsonText(fullText, message.tools, message.tool_choice);
                            const trimmedSoFar = fullText.trimStart();
                            if (inferred && inferred.length > 0) {
                                toolCallsFromStream = inferred;
                                finishReasonFromStream = 'tool_calls';
                                bufferingStructuredJson = true;
                                continue;
                            }
                            if (bufferingStructuredJson || trimmedSoFar.startsWith('{') || trimmedSoFar.startsWith('[')) {
                                bufferingStructuredJson = true;
                                continue;
                            }
                        }
                        ensureResponsesTextItemStarted();
                        writeResponsesSseEvent(response, buildResponsesOutputTextDeltaEvent({
                            responseId,
                            itemId: responseMessageId,
                            outputIndex: 0,
                            contentIndex: 0,
                            delta: deltaText,
                        }));
                    }
                } else if (result.type === 'final') {
                    ensureResponsesCreated();
                    if (typeof result.tokenUsage === 'number') totalTokenUsage = result.tokenUsage;
                    if (typeof result.promptTokens === 'number') promptTokensFinal = result.promptTokens;
                    if (typeof result.completionTokens === 'number') completionTokensFinal = result.completionTokens;
                    if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
                        toolCallsFromStream = result.tool_calls;
                    }
                    if (result.finish_reason) finishReasonFromStream = result.finish_reason;
                }
            }

            if (fallbackToNormalized) {
                ensureResponsesCreated();

                const fallbackStreamHandler = messageHandler.handleStreamingMessages([message], modelId, userApiKey, { disablePassthrough: true, requestId: request.requestId });
                for await (const fallbackResult of fallbackStreamHandler) {
                    if (fallbackResult.type === 'chunk') {
                        if (typeof fallbackResult.reasoning === 'string' && fallbackResult.reasoning) {
                            ensureResponsesReasoningItemStarted();
                            streamedReasoningText += fallbackResult.reasoning;
                            writeResponsesSseEvent(response, {
                                type: 'response.reasoning_summary_text.delta',
                                response_id: responseId,
                                item_id: reasoningItemId,
                                output_index: 0,
                                summary_index: 0,
                                delta: fallbackResult.reasoning,
                            });
                        }
                        if (typeof fallbackResult.chunk !== 'string' || fallbackResult.chunk.length === 0) {
                            continue;
                        }
                        if (Array.isArray(fallbackResult.tool_calls) && fallbackResult.tool_calls.length > 0) {
                            toolCallsFromStream = fallbackResult.tool_calls;
                        }
                        if (fallbackResult.finish_reason) finishReasonFromStream = fallbackResult.finish_reason;
                        let fallbackDeltaText = fallbackResult.chunk;
                        fullText += fallbackDeltaText;
                        if (!toolCallsFromStream && canInferResponsesToolCallsFromText) {
                            const inferred = inferToolCallsFromJsonText(fullText, message.tools, message.tool_choice);
                            const trimmedSoFar = fullText.trimStart();
                            if (inferred && inferred.length > 0) {
                                toolCallsFromStream = inferred;
                                finishReasonFromStream = 'tool_calls';
                                bufferingStructuredJson = true;
                                continue;
                            }
                            if (bufferingStructuredJson || trimmedSoFar.startsWith('{') || trimmedSoFar.startsWith('[')) {
                                bufferingStructuredJson = true;
                                continue;
                            }
                        }
                        ensureResponsesTextItemStarted();
                        writeResponsesSseEvent(response, buildResponsesOutputTextDeltaEvent({
                            responseId,
                            itemId: responseMessageId,
                            outputIndex: 0,
                            contentIndex: 0,
                            delta: fallbackDeltaText,
                        }));
                    } else if (fallbackResult.type === 'final') {
                        if (typeof fallbackResult.tokenUsage === 'number') totalTokenUsage = fallbackResult.tokenUsage;
                        if (typeof fallbackResult.promptTokens === 'number') promptTokensFinal = fallbackResult.promptTokens;
                        if (typeof fallbackResult.completionTokens === 'number') completionTokensFinal = fallbackResult.completionTokens;
                        if (Array.isArray(fallbackResult.tool_calls) && fallbackResult.tool_calls.length > 0) {
                            toolCallsFromStream = fallbackResult.tool_calls;
                        }
                        if (fallbackResult.finish_reason) finishReasonFromStream = fallbackResult.finish_reason;
                    }
                }
            }

            if ((!toolCallsFromStream || toolCallsFromStream.length === 0) && fullText && canInferResponsesToolCallsFromText) {
                const inferred = inferToolCallsFromJsonText(fullText, message.tools, message.tool_choice);
                if (inferred && inferred.length > 0) {
                    toolCallsFromStream = inferred;
                    finishReasonFromStream = 'tool_calls';
                    bufferingStructuredJson = true;
                }
            }

            if (bufferingStructuredJson && (!toolCallsFromStream || toolCallsFromStream.length === 0) && fullText) {
                ensureResponsesTextItemStarted();
                writeResponsesSseEvent(response, buildResponsesOutputTextDeltaEvent({
                    responseId,
                    itemId: responseMessageId,
                    outputIndex: getAssistantOutputIndex(),
                    contentIndex: 0,
                    delta: fullText,
                }));
            }

            if (passthroughHandled) {
                const finalPromptTokensForPassthrough = typeof promptTokensFromUsage === 'number'
                    ? promptTokensFromUsage
                    : estimateTokensFromContent(message.content);
                const finalCompletionTokensForPassthrough = typeof completionTokensFromUsage === 'number'
                    ? completionTokensFromUsage
                    : estimateTokensFromText(fullText);
                if (totalTokenUsage <= 0) {
                    totalTokenUsage = finalPromptTokensForPassthrough + finalCompletionTokensForPassthrough;
                }

                persistResponsesStreamSideEffects(
                    fullText,
                    totalTokenUsage,
                    finalPromptTokensForPassthrough,
                    finalCompletionTokensForPassthrough,
                    toolCallsFromStream,
                );
                if (!response.completed) response.end();
                return;
            }

            const finalInputTokens = typeof promptTokensFinal === 'number'
                ? promptTokensFinal
                : (typeof promptTokensFromUsage === 'number'
                    ? promptTokensFromUsage
                    : estimateTokensFromContent(message.content));
            const finalOutputTokens = typeof completionTokensFinal === 'number'
                ? completionTokensFinal
                : (typeof completionTokensFromUsage === 'number'
                    ? completionTokensFromUsage
                    : estimateTokensFromText(fullText));
            if (totalTokenUsage <= 0) {
                totalTokenUsage = finalInputTokens + finalOutputTokens;
            }

            const finalPayload = buildResponsesResponseObject({
                id: responseId,
                created,
                model: modelId,
                outputText: toolCallsFromStream && toolCallsFromStream.length > 0 ? '' : fullText,
                toolCalls: toolCallsFromStream,
                reasoningText: streamedReasoningText,
                reasoningId: streamedReasoningText ? reasoningItemId : undefined,
                reasoningStatus: streamedReasoningText ? 'completed' : undefined,
                status: 'completed',
                messageId: responseMessageId,
                messageStatus: 'completed',
                functionCallStatus: 'completed',
                usage: {
                    input_tokens: finalInputTokens,
                    output_tokens: finalOutputTokens,
                    total_tokens: totalTokenUsage
                }
            });

            const finalOutputItems = Array.isArray(finalPayload.output) ? finalPayload.output : [];
            if (reasoningItemStarted && streamedReasoningText) {
                writeResponsesSseEvent(response, {
                    type: 'response.reasoning_summary_text.done',
                    response_id: responseId,
                    item_id: reasoningItemId,
                    output_index: 0,
                    summary_index: 0,
                    text: streamedReasoningText,
                });
                writeResponsesSseEvent(response, {
                    type: 'response.reasoning_summary_part.done',
                    response_id: responseId,
                    item_id: reasoningItemId,
                    output_index: 0,
                    summary_index: 0,
                    part: { type: 'summary_text', text: streamedReasoningText },
                });
                writeResponsesSseEvent(response, buildResponsesOutputItemDoneEvent({
                    responseId,
                    outputIndex: 0,
                    item: createResponsesReasoningItem(streamedReasoningText, { id: reasoningItemId, status: 'completed' }),
                }));
            }
            const assistantOutputIndex = finalOutputItems.findIndex((item: any) => item?.type === 'message' && item?.role === 'assistant');
            if (assistantOutputIndex >= 0) {
                const assistantItem = finalOutputItems[assistantOutputIndex];
                const assistantItemId = typeof assistantItem?.id === 'string' && assistantItem.id.trim()
                    ? assistantItem.id.trim()
                    : responseMessageId;
                const assistantPart = Array.isArray(assistantItem?.content) && assistantItem.content.length > 0
                    ? assistantItem.content[0]
                    : { type: 'output_text', text: fullText };
                ensureResponsesTextItemStarted();
                writeResponsesSseEvent(response, buildResponsesOutputTextDoneEvent({
                    responseId,
                    itemId: assistantItemId,
                    outputIndex: assistantOutputIndex,
                    contentIndex: 0,
                    text: fullText,
                }));
                writeResponsesSseEvent(response, buildResponsesContentPartDoneEvent({
                    responseId,
                    itemId: assistantItemId,
                    outputIndex: assistantOutputIndex,
                    contentIndex: 0,
                    part: assistantPart,
                }));
                writeResponsesSseEvent(response, buildResponsesOutputItemDoneEvent({
                    responseId,
                    outputIndex: assistantOutputIndex,
                    item: assistantItem,
                }));
            }

            for (const [index, item] of finalOutputItems.entries()) {
                if (item?.type !== 'function_call') continue;
                ensureResponsesCreated();
                writeResponsesSseEvent(response, buildResponsesOutputItemAddedEvent({
                    responseId,
                    outputIndex: index,
                    item: { ...item, status: 'in_progress' },
                }));
                writeResponsesSseEvent(response, buildResponsesFunctionCallArgumentsDoneEvent({
                    responseId,
                    itemId: typeof item?.id === 'string' ? item.id : createResponsesItemId('fc'),
                    outputIndex: index,
                    callId: typeof item?.call_id === 'string' ? item.call_id : undefined,
                    name: typeof item?.name === 'string' ? item.name : undefined,
                    argumentsText: typeof item?.arguments === 'string' ? item.arguments : undefined,
                }));
                writeResponsesSseEvent(response, buildResponsesOutputItemDoneEvent({
                    responseId,
                    outputIndex: index,
                    item,
                }));
            }

            writeResponsesSseEvent(response, buildResponsesCompletedEvent(finalPayload));
            response.write(`data: [DONE]\n\n`);
            if (!response.completed) response.end();
            persistResponsesStreamSideEffects(
                fullText,
                totalTokenUsage,
                finalInputTokens,
                finalOutputTokens,
                toolCallsFromStream,
            );
            return;
        }

        const result = await messageHandler.handleMessages([message], modelId, userApiKey, { requestId: request.requestId });
        const inferredToolCalls = (!result.tool_calls || result.tool_calls.length === 0)
            ? inferToolCallsFromJsonText(result.response, Array.isArray(message.tools) ? message.tools : undefined, message.tool_choice)
            : undefined;
        const effectiveToolCalls = (result.tool_calls && result.tool_calls.length > 0)
            ? result.tool_calls
            : inferredToolCalls;
        const assistantContent = effectiveToolCalls?.length ? '' : result.response;
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const promptTokensUsed = typeof result.promptTokens === 'number' ? result.promptTokens : undefined;
        const completionTokensUsed = typeof result.completionTokens === 'number' ? result.completionTokens : undefined;
        await updateUserTokenUsage(totalTokensUsed, userApiKey, { modelId, promptTokens: promptTokensUsed, completionTokens: completionTokensUsed });

        const outputText = (effectiveToolCalls && effectiveToolCalls.length > 0) ? '' : assistantContent;
        if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && (!outputText || outputText.trim().length === 0)) {
            throw new Error('Empty responses output from provider.');
        }
        const responseBody = buildResponsesResponseObject({
            id: responseId,
            created,
            model: modelId,
            outputText,
            toolCalls: effectiveToolCalls,
            reasoningText: typeof result.reasoning === 'string' ? result.reasoning : undefined,
            status: 'completed',
            usage: { input_tokens: promptTokensUsed, output_tokens: completionTokensUsed, total_tokens: totalTokensUsed }
        });

        await saveResponsesHistoryEntry({
            id: responseId,
            model: modelId,
            input: responsesHistoryInput,
            output: buildStoredResponsesHistoryOutput(outputText, effectiveToolCalls),
            output_text: outputText,
            created,
        });
        return response.json(responseBody);
    } catch (error: any) {
        attachQueueOverloadMetadata(error, requestQueue, {
            route: '/v1/responses',
            lane: 'responses',
        });
        await logError(error, request);
        const errorText = String(error?.message || '');
        console.error('Responses API error:', errorText, error.stack);
        const timestamp = new Date().toISOString();
        let statusCode = 500;
        let clientMessage = 'Internal Server Error';
        let clientReference = 'An unexpected error occurred while processing your responses request.';
        const errorMeta = error as any;
        const retryAfterSeconds = extractRetryAfterSeconds(errorText);
        const rateLimitMessage = formatRateLimitMessage(retryAfterSeconds);
        const isFreeTierZeroQuota = isGeminiFreeTierZeroQuota(errorText);
        const errorModelId = errorMeta?.modelId;

        // All providers rate-limited — return 429 with Retry-After
        if (typeof errorMeta?.statusCode === 'number' && errorMeta.statusCode >= 400 && errorMeta.statusCode < 600) {
            statusCode = errorMeta.statusCode;
            clientMessage = errorText || clientMessage;
        } else if (isFreeTierZeroQuota) {
            statusCode = 403;
            clientMessage = errorModelId
                ? `Model ${errorModelId} is not available for Gemini free-tier keys. Use a different model or a paid Gemini key.`
                : 'This model is not available for Gemini free-tier keys. Use a different model or a paid Gemini key.';
        } else if (errorMeta?.allSkippedByRateLimit) {
            statusCode = 429;
            clientMessage = rateLimitMessage;
        } else if (errorMeta?.code === 'INPUT_TOKENS_EXCEEDED' && errorMeta?.hasImageInput) {
            statusCode = 400;
            clientMessage = 'Bad Request: image input too large for the model limit. Reduce image size or use a smaller image URL.';
        } else if (errorText.startsWith('Invalid request') || errorText.startsWith('Failed to parse') || errorText.includes('input is required')) {
            statusCode = 400;
            clientMessage = `Bad Request: ${errorText}`;
        } else if (error instanceof SyntaxError) {
            statusCode = 400;
            clientMessage = 'Invalid JSON';
        } else if (isRateLimitError(errorText)) {
            statusCode = 429;
            clientMessage = rateLimitMessage;
        } else if (errorText.includes('Unauthorized') || errorText.includes('limit reached')) {
            statusCode = errorText.includes('limit reached') ? 429 : 401;
            clientMessage = errorText.includes('limit reached') ? rateLimitMessage : errorText;
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
        } else if (
            errorText.toLowerCase().includes('input token count exceeds') ||
            errorText.toLowerCase().includes('maximum number of tokens allowed')
        ) {
            statusCode = 400;
            clientMessage = 'Bad Request: input token count exceeds the model limit. Reduce the prompt size or truncate history.';
        } else if (
            errorText.includes('fetching image from URL') ||
            errorText.includes('image_url') ||
            errorText.toLowerCase().includes('cannot fetch content from the provided url')
        ) {
            statusCode = 400;
            clientMessage = 'Bad Request: image_url could not be fetched by the provider. Use a public, non-expiring URL or pass the image as base64 data.';
        } else if (errorText.includes('No suitable providers') || errorText.includes('supports model') || errorText.includes('No provider')) {
            statusCode = 404;
            clientMessage = errorText;
        }

        if (!response.completed) {
            if (statusCode === 429 && retryAfterSeconds) {
                response.setHeader('Retry-After', String(retryAfterSeconds));
            }
            if (statusCode === 500) {
                response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
            } else {
                const payload: Record<string, any> = { error: clientMessage, timestamp };
                if (statusCode === 429 && retryAfterSeconds) {
                    payload.retry_after_seconds = retryAfterSeconds;
                }
                response.status(statusCode).json(payload);
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
        if (body?.reasoning === undefined && body?.reasoning_effort !== undefined) {
            body.reasoning = body.reasoning_effort;
        }
        const interactionRequest: InteractionRequest = {
            model: normalized.model,
            input,
            tools: Array.isArray(body.tools) ? body.tools : undefined,
            response_format: body.response_format && typeof body.response_format === 'object' ? body.response_format : undefined,
            generation_config: body.generation_config && typeof body.generation_config === 'object' ? body.generation_config : undefined,
            agent: normalized.agent,
            reasoning: body.reasoning,
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
        const formattedMessages: IMessage[] = rawMessages.map(msg => ({ ...msg, model: { id: deploymentId } }));
 
        // Call the central message handler
        const result = await messageHandler.handleMessages(formattedMessages, deploymentId, userApiKey, { requestId: request.requestId });
 
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
        const explicitStatusCode = typeof (error as any)?.statusCode === 'number' ? (error as any).statusCode : null;

        if (explicitStatusCode && explicitStatusCode >= 400 && explicitStatusCode < 600) {
            statusCode = explicitStatusCode;
            clientMessage = error.message || clientMessage;
        } else if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse')) {
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
                    response.write(value);
                }
            }
            response.end();
        } else {
            const arrayBuffer = await upstreamRes.arrayBuffer();
            response.end(new Uint8Array(arrayBuffer));
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
        return await embeddingsQueue.run(async () => {
            let body: any;
            try {
                body = await request.json();
            } catch (e) {
                if (!response.completed) return response.status(400).json({ error: 'Bad Request: invalid JSON', timestamp: new Date().toISOString() });
                return;
            }

            const model = typeof body?.model === 'string' ? body.model : '';
            let input: any = body?.input;

            if (!model) {
                if (!response.completed) return response.status(400).json({ error: 'Bad Request: model is required', timestamp: new Date().toISOString() });
                return;
            }

            if (!input) {
                if (!response.completed) return response.status(400).json({ error: 'Bad Request: input is required', timestamp: new Date().toISOString() });
                return;
            }

            const tokensUsed = Array.isArray(input)
                ? input.reduce((acc: number, s: string) => acc + estimateTokensFromText(String(s), 'input'), 0)
                : estimateTokensFromText(String(input), 'input');

            const provider = await pickOpenAIProviderKey(model);
            if (!provider) {
                if (!response.completed) return response.status(503).json({ error: 'No available provider for embeddings', timestamp: new Date().toISOString() });
                return;
            }

            const upstreamPayload = JSON.stringify({
                model,
                input,
                encoding_format: body.encoding_format,
                dimensions: body.dimensions,
                user: body.user,
            });
            body = undefined;

            const upstreamUrl = `${provider.baseUrl}/v1/embeddings`;
            const upstreamRes = await fetchWithTimeout(upstreamUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${provider.apiKey}`,
                },
                body: upstreamPayload,
            }, UPSTREAM_TIMEOUT_MS);
            input = undefined;

            if (!upstreamRes.ok) {
                const errText = await upstreamRes.text().catch(() => '');
                if (!response.completed) return response.status(upstreamRes.status).json({ error: `Embeddings upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
                return;
            }

            response.status(upstreamRes.status);
            response.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json');

            if (upstreamRes.body) {
                const reader = upstreamRes.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value && value.length > 0) response.write(value);
                }
                response.end();
            } else {
                response.end(await upstreamRes.text());
            }

            await updateUserTokenUsage(tokensUsed, request.apiKey!);
        });

    } catch (error: any) {
        await logError(error, request);
        console.error('Embeddings route error:', error.message);
        const statusCode = typeof error?.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
            ? error.statusCode
            : 500;
        const message = statusCode === 500 ? 'Internal Server Error' : (String(error?.message || '') || 'Request failed');
        if (!response.completed) response.status(statusCode).json({ error: message, timestamp: new Date().toISOString() });
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
