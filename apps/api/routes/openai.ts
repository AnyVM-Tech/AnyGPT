import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler.js'; 
import { IMessage } from '../providers/interfaces.js'; 
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
import { dataManager, LoadedProviders, LoadedProviderData } from '../modules/dataManager.js';
 
dotenv.config();
 
const openaiRouter = new HyperExpress.Router();
 
// --- Rate Limiting Store --- 
const requestTimestamps: RequestTimestampStore = {};
const RATE_LIMIT_KEY_PREFIX = 'api:ratelimit:';

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
    console.log(`[AuthMiddleware] Request received at ${request.path} with method ${request.method}`);
    console.log(`[AuthMiddleware] Authorization header: ${request.headers['authorization'] || 'None'}`);
    console.log(`[AuthMiddleware] x-api-key header: ${request.headers['x-api-key'] || 'None'}`);

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
            await logError({ message: errorMessage, statusCode: details.statusCode, apiKey: details.apiKey }, req);
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
                logError({ message: `Rate limit exceeded: Max ${details.limit} ${windowLabel}.`, apiKey: req.apiKey }, req).catch(e => console.error('Failed background log:', e));
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

function estimateTokens(text: string): number {
    return Math.ceil((text || '').length / 4);
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

function isNonChatModel(modelId: string): 'tts' | 'stt' | 'image-gen' | 'embedding' | false {
    const n = String(modelId || '').toLowerCase();
    if (n.startsWith('tts-') || n.includes('-tts')) return 'tts';
    if (n.startsWith('whisper') || n.includes('transcribe')) return 'stt';
    if (n.startsWith('dall-e')) return 'image-gen';
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

async function inlineImageUrls(messages: any[], authHeader?: string) {
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
        if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part && part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('http')) {
                    try {
                        console.log(`[ImageProxy] Fetching image from URL: ${part.image_url.url}`);
                        const headers: Record<string, string> = {};
                        if (authHeader) headers['Authorization'] = authHeader;
                        
                        const res = await fetch(part.image_url.url, { headers });
                        if (res.ok) {
                            const arrayBuffer = await res.arrayBuffer();
                            const buffer = Buffer.from(arrayBuffer);
                            const contentType = res.headers.get('content-type') || detectMimeTypeFromBuffer(buffer) || 'image/jpeg';
                            const base64 = buffer.toString('base64');
                            part.image_url.url = `data:${contentType};base64,${base64}`;
                            console.log(`[ImageProxy] Successfully inlined image. Type: ${contentType}, Size: ${buffer.length}`);
                        } else {
                            console.warn(`[ImageProxy] Failed to fetch image: ${res.status} ${res.statusText}`);
                        }
                    } catch (err) {
                        console.error(`[ImageProxy] Error fetching image:`, err);
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
openaiRouter.use('/audio', rateLimitMiddleware);
openaiRouter.use('/images', rateLimitMiddleware);
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
                                console.log(`[Multipart] Injecting image. Type: ${f.type}, Base64Len: ${base64Data.length}, Prefix: ${base64Data.substring(0, 50)}...`);
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
                console.log(`[RawFallback] Buffer size: ${rawBuffer.length}, First 50 bytes: ${rawBuffer.subarray(0, 50).toString('hex')}`);
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

                    console.log(`[RawFallback] Type: ${mimeType}, Base64Len: ${base64Data.length}, Prefix: ${base64Data.substring(0, 50)}...`);

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

    const result = extractMessageFromRequestBody(requestBody);
    const { messages: rawMessages, model: modelId } = result;

    // Inline HTTP image URLs to base64 to avoid OpenAI fetching errors on private/local URLs
    await inlineImageUrls(rawMessages, request.headers['authorization']);

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

    // --- Block non-chat models with helpful error ---
    const nonChatType = isNonChatModel(modelId);
    if (nonChatType) {
        // Allow image generation models to work in chat by adapting the request
        if (nonChatType === 'image-gen') {
            try {
                const lastUserMessage = rawMessages.filter(m => m.role === 'user').pop();
                const prompt = typeof lastUserMessage?.content === 'string' 
                    ? lastUserMessage.content 
                    : (Array.isArray(lastUserMessage?.content) 
                        ? (lastUserMessage.content as any[]).find((p: any) => p.type === 'text')?.text 
                        : '');

                if (!prompt) {
                    if (!response.completed) return response.status(400).json({ error: 'Bad Request: No prompt found in user messages for image generation.', timestamp: new Date().toISOString() });
                    return;
                }

                const provider = await pickOpenAIProviderKey(modelId);
                if (!provider) {
                    if (!response.completed) return response.status(503).json({ error: 'No available provider for image generation', timestamp: new Date().toISOString() });
                    return;
                }

                const upstreamUrl = `${provider.baseUrl}/v1/images/generations`;
                const upstreamRes = await fetch(upstreamUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${provider.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: modelId,
                        prompt,
                        n: 1,
                        size: '1024x1024'
                    }),
                });

                if (!upstreamRes.ok) {
                    const errText = await upstreamRes.text().catch(() => '');
                    if (!response.completed) return response.status(upstreamRes.status).json({ error: `Image generation upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
                    return;
                }

                const resJson = await upstreamRes.json();
                const imageUrl = resJson.data?.[0]?.url;
                const revisedPrompt = resJson.data?.[0]?.revised_prompt;
                
                const assistantContent = imageUrl 
                    ? `![Generated Image](${imageUrl})\n\n*${revisedPrompt || prompt}*`
                    : 'Failed to generate image URL.';

                const tokenEstimate = Math.ceil(prompt.length / 4) + 500;
                await updateUserTokenUsage(tokenEstimate, userApiKey);

                const openaiResponse = {
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        message: { role: "assistant", content: assistantContent },
                        finish_reason: "stop"
                    }],
                    usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 0, total_tokens: tokenEstimate }
                };
                response.json(openaiResponse);
                return;

            } catch (adapterError: any) {
                console.error('Chat-to-Image adapter error:', adapterError);
                if (!response.completed) return response.status(500).json({ error: 'Internal Server Error during image generation adapter.', timestamp: new Date().toISOString() });
                return;
            }
        }

        const endpointMap: Record<string, string> = {
            tts: '/v1/audio/speech',
            stt: '/v1/audio/transcriptions',
            'image-gen': '/v1/images/generations',
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

    const formattedMessages: IMessage[] = rawMessages.map(msg => ({
        role: msg.role,
        content: msg.content,
        model: { id: modelId },
        ...sharedMessageOptions,
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
                    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                    return sum + estimateTokens(content);
                }, 0);
                const completionEstimate = typeof completionTokensFromUsage === 'number' ? completionTokensFromUsage : estimateTokens(streamOutputText);
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
    console.error('Chat completions error:', error.message, error.stack);
    const timestamp = new Date().toISOString();
    let statusCode = 500;
    let clientMessage = 'Internal Server Error';
    let clientReference = 'An unexpected error occurred while processing your chat request.';

    if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse')) {
        statusCode = 400;
        clientMessage = `Bad Request: ${error.message}`;
    } else if (error instanceof SyntaxError) {
        statusCode = 400;
        clientMessage = 'Invalid JSON';
    } else if (error.message.includes('Unauthorized') || error.message.includes('limit reached')) {
        statusCode = error.message.includes('limit reached') ? 429 : 401;
        clientMessage = error.message;
    } else if (error.message.includes('No suitable providers')) {
        statusCode = 503;
        clientMessage = error.message;
    } else if (error.message.includes('Provider') && error.message.includes('failed')) {
        statusCode = 502;
        clientMessage = error.message;
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
        const { message, modelId, stream } = extractResponsesRequestBody(requestBody);
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
                    const promptEstimate = typeof promptTokensFromUsage === 'number' ? promptTokensFromUsage : estimateTokens(JSON.stringify(message.content));
                    const completionEstimate = typeof completionTokensFromUsage === 'number' ? completionTokensFromUsage : estimateTokens(fullText);
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
        console.error('Responses API error:', error.message, error.stack);
        const timestamp = new Date().toISOString();
        let statusCode = 500;
        let clientMessage = 'Internal Server Error';
        let clientReference = 'An unexpected error occurred while processing your responses request.';

        if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse') || error.message.includes('input is required')) {
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
            clientMessage = error.message;
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
        const { messages: rawMessages } = extractMessageFromRequestBody(requestBody); 

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

async function pickOpenAIProviderKey(modelId: string): Promise<{ apiKey: string; baseUrl: string } | null> {
    const providers = await dataManager.load<LoadedProviders>('providers');
    const candidates = providers.filter((p: LoadedProviderData) =>
        !p.disabled &&
        p.id.includes('openai') &&
        p.apiKey &&
        p.models &&
        modelId in p.models
    );
    if (candidates.length === 0) {
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

// --- Audio format content-type map ---
const AUDIO_CONTENT_TYPES: Record<string, string> = {
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
};

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
        const input = typeof body?.input === 'string' ? body.input : '';
        const voice = typeof body?.voice === 'string' ? body.voice : 'alloy';
        const responseFormat = typeof body?.response_format === 'string' ? body.response_format : 'mp3';
        const speed = typeof body?.speed === 'number' ? body.speed : undefined;
        const stream = Boolean(body?.stream);

        if (!input) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: input is required', timestamp: new Date().toISOString() });
            return;
        }

        const provider = await pickOpenAIProviderKey(model);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for TTS', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/audio/speech`;
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({ model, input, voice, response_format: responseFormat, speed, stream }),
        });

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

        const provider = await pickOpenAIProviderKey(model);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for STT', timestamp: new Date().toISOString() });
            return;
        }

        // Read raw body as Buffer via the buffer() method
        const rawBody = await request.buffer();
        const upstreamUrl = `${provider.baseUrl}/v1/audio/transcriptions`;
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': contentType,
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: rawBody as any,
        });

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
        if (!prompt) {
            if (!response.completed) return response.status(400).json({ error: 'Bad Request: prompt is required', timestamp: new Date().toISOString() });
            return;
        }

        const provider = await pickOpenAIProviderKey(model);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for image generation', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/images/generations`;
        const upstreamRes = await fetch(upstreamUrl, {
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
        });

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
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({ model, input, encoding_format: body.encoding_format, dimensions: body.dimensions, user: body.user }),
        });

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            if (!response.completed) return response.status(upstreamRes.status).json({ error: `Embeddings upstream error: ${errText || upstreamRes.statusText}`, timestamp: new Date().toISOString() });
            return;
        }

        const resJson = await upstreamRes.json();
        response.json(resJson);

        // Estimate usage if upstream didn't provide it, otherwise use upstream
        const tokensUsed = resJson.usage?.total_tokens || (Array.isArray(input) ? input.reduce((acc: number, s: string) => acc + estimateTokens(s), 0) : estimateTokens(String(input)));
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

        if (!prompt) {
             if (!response.completed) return response.status(400).json({ error: 'Bad Request: prompt is required', timestamp: new Date().toISOString() });
             return;
        }

        // Check for image file
        if (!parsed.files.some(f => f.name === 'image')) {
             if (!response.completed) return response.status(400).json({ error: 'Bad Request: image file is required', timestamp: new Date().toISOString() });
             return;
        }

        const provider = await pickOpenAIProviderKey(model);
        if (!provider) {
            if (!response.completed) return response.status(503).json({ error: 'No available provider for image edits', timestamp: new Date().toISOString() });
            return;
        }

        const upstreamUrl = `${provider.baseUrl}/v1/images/edits`;
        
        // Forward raw body directly to preserve binary integrity
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
                'Content-Type': contentType, // Pass original content-type with boundary
                'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: rawBody as any,
        });

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
