import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler.js'; 
import { ContentPart, IMessage } from '../providers/interfaces.js'; 
import { 
    generateUserApiKey, // Now async
    updateUserTokenUsage, // Now async
    TierData // Import TierData type
} from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js'; // Changed import
import { RequestTimestampStore } from '../modules/rateLimit.js';
import { runAuthMiddleware, runRateLimitMiddleware } from '../modules/middlewareFactory.js';
import { redactToken } from '../modules/redaction.js';
import {
    createInteractionToken,
    executeGeminiInteraction,
    getInteractionsSigningSecret,
    normalizeDeepResearchModel,
    verifyInteractionToken,
    InteractionRequest,
} from '../modules/interactions.js';

dotenv.config();

const router = new HyperExpress.Router(); // Use Router for modularity

// --- Rate Limiting Store (Consider sharing or centralizing if needed across routes) --- 
const requestTimestamps: RequestTimestampStore = {};
const INTERACTIONS_TOKEN_TTL_SECONDS = 15 * 60;

function mapGeminiInputPart(part: any): ContentPart | null {
    if (!part || typeof part !== 'object') return null;

    if (typeof part.text === 'string') {
        return { type: 'text', text: part.text };
    }

    if (part.inlineData && typeof part.inlineData === 'object') {
        const base64Data = typeof part.inlineData.data === 'string' ? part.inlineData.data : '';
        const mimeType = typeof part.inlineData.mimeType === 'string' ? part.inlineData.mimeType : '';
        if (!base64Data || !mimeType) return null;

        if (mimeType.toLowerCase().startsWith('audio/')) {
            return {
                type: 'input_audio',
                input_audio: {
                    data: base64Data,
                    format: mimeType,
                },
            };
        }

        if (mimeType.toLowerCase().startsWith('image/')) {
            return {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Data}` },
            };
        }
    }

    if (part.fileData && typeof part.fileData === 'object') {
        const fileUri = typeof part.fileData.fileUri === 'string' ? part.fileData.fileUri : '';
        const mimeType = typeof part.fileData.mimeType === 'string' ? part.fileData.mimeType : 'image/jpeg';
        if (fileUri && mimeType.toLowerCase().startsWith('image/')) {
            return {
                type: 'image_url',
                image_url: { url: fileUri },
            };
        }
    }

    return null;
}

function mapGeminiOutputParts(providerResponse: string): any[] {
    if (typeof providerResponse !== 'string' || providerResponse.length === 0) {
        return [{ text: '' }];
    }

    const dataUriMatch = providerResponse.match(/^data:([^;]+);base64,(.+)$/);
    if (!dataUriMatch) {
        return [{ text: providerResponse }];
    }

    const mimeType = dataUriMatch[1];
    const data = dataUriMatch[2];
    return [{ inlineData: { mimeType, data } }];
}

// --- Request Extension (Already declared globally in openai.ts, should be accessible) ---
// If running routes separately, this might need re-declaration or centralizing.

// --- Middleware (Assume shared middleware setup from server.ts or copied/adapted) ---

// AUTH Middleware (Copied and adapted - MUST BE ASYNC)
// NOTE: Ideally, middleware should be defined centrally and imported.
// This is a temporary copy for self-containment.
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const timestamp = new Date().toISOString();

    return runAuthMiddleware(request, response, next, {
        extractApiKey: (req) => req.headers['x-goog-api-key'] as string || null,
        onMissingApiKey: async (req) => {
            const errDetail = { message: "API key missing. Please pass an API key in 'x-goog-api-key' header.", code: 401, status: 'UNAUTHENTICATED' };
            await logError(errDetail, req);
            return { status: 401, body: { error: { code: 401, message: errDetail.message, status: 'UNAUTHENTICATED' }, timestamp } };
        },
        onInvalidApiKey: async (req, details) => {
            const statusText = details.statusCode === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAUTHENTICATED';
            const logMsg = `API key not valid. ${details.error || 'Please pass a valid API key.'}`;
            await logError({ message: logMsg, details: details.error, apiKey: redactToken(details.apiKey), code: details.statusCode, status: statusText }, req);
            return { status: details.statusCode, body: { error: { code: details.statusCode, message: logMsg, status: statusText }, timestamp } };
        },
        onInternalError: async (req, error) => {
            await logError(error, req);
            console.error('Gemini Route - Error during auth/usage check:', error);
            return { status: 500, body: { error: 'Internal Server Error', reference: 'Error during authentication processing.', timestamp } };
        },
    });
}

// RATE LIMIT Middleware (Copied and adapted - Synchronous)
// NOTE: Ideally, middleware should be defined centrally and imported.
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    const timestamp = new Date().toISOString(); // For error responses
        return runRateLimitMiddleware(request, response, next, requestTimestamps, {
            onMissingContext: (req) => {
                const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (Gemini rateLimitMiddleware).';
                logError({ message: errMsg, requestPath: req.path }, req).catch(e => console.error('Failed background log:', e));
                console.error(errMsg);
                return { status: 500, body: { error: 'Internal Server Error', reference: 'Configuration error for rate limiting.', timestamp } };
            },
            onDenied: (req, details) => {
                const errDetail = {
                    message: `Rate limit exceeded: Max ${details.limit} ${details.window.toUpperCase()}. Please try again later.`,
                    code: 429,
                    status: 'RESOURCE_EXHAUSTED'
                };
                logError(errDetail, req).catch(e => console.error('Failed background log:', e));
                return { status: 429, body: { error: errDetail, timestamp } };
            }
        });
}
 
// --- Routes ---
 
// Gemini Generate Content Route (router mounted at /v2 in server.ts, so keep path relative here)
router.post('/models/:modelId/generateContent', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
   const routeTimestamp = new Date().toISOString(); // Timestamp for this specific route handler context
   if (!request.apiKey || !request.tierLimits || !request.params.modelId) {
        const errDetail = { message: 'Bad Request: Missing API key, tier limits, or model ID after middleware.', code: 400, status: 'INVALID_ARGUMENT' };
        await logError(errDetail, request); // Renamed and added await
        if (!response.completed) {
          return response.status(400).json({ error: errDetail, timestamp: routeTimestamp }); 
        } else { return; }
   }

   const userApiKey = request.apiKey!;
   const modelId = request.params.modelId;

   let body: any; // For use in error handling if body parsing fails or modelId isn't found from body

   try {
        body = await request.json(); 
        
        if (!body || !Array.isArray(body.contents) || body.contents.length === 0) {
            const errDetail = { message: "Invalid request body: Missing or invalid 'contents' array.", code: 400, status: 'INVALID_ARGUMENT' };
            await logError(errDetail, request); // Renamed and added await
            if (!response.completed) {
               return response.status(400).json({ error: errDetail, timestamp: new Date().toISOString() });
            } else { return; }
        }

        const lastUserContent = [...body.contents]
            .reverse()
            .find((contentEntry: any) => contentEntry && contentEntry.role === 'user' && Array.isArray(contentEntry.parts));

        if (!lastUserContent || !Array.isArray(lastUserContent.parts) || lastUserContent.parts.length === 0) {
             const errDetail = { message: "Invalid request body: Could not extract valid user parts from 'contents'.", code: 400, status: 'INVALID_ARGUMENT' };
             await logError(errDetail, request); // Renamed and added await
             if (!response.completed) {
                return response.status(400).json({ error: errDetail, timestamp: new Date().toISOString() });
             } else { return; }
        }

        const mappedParts = lastUserContent.parts
            .map((part: any) => mapGeminiInputPart(part))
            .filter((part: ContentPart | null): part is ContentPart => part !== null);

        if (mappedParts.length === 0) {
            const errDetail = { message: "Invalid request body: Unsupported or empty user parts in 'contents'.", code: 400, status: 'INVALID_ARGUMENT' };
            await logError(errDetail, request);
            if (!response.completed) {
                return response.status(400).json({ error: errDetail, timestamp: new Date().toISOString() });
            } else { return; }
        }

        const messageContent: string | ContentPart[] =
            mappedParts.length === 1 && mappedParts[0].type === 'text'
                ? mappedParts[0].text
                : mappedParts;

        const generationConfig = body?.generationConfig && typeof body.generationConfig === 'object'
            ? body.generationConfig
            : undefined;

        const responseModalities = Array.isArray(generationConfig?.responseModalities)
            ? generationConfig.responseModalities
            : undefined;

        const responseMimeType = typeof generationConfig?.responseMimeType === 'string'
            ? generationConfig.responseMimeType
            : undefined;

        const voiceName = generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName;

        const formattedMessages: IMessage[] = [{
            content: messageContent,
            model: { id: modelId },
            modalities: responseModalities,
            audio: {
                format: responseMimeType,
                voice: typeof voiceName === 'string' ? voiceName : undefined,
            },
            temperature: typeof generationConfig?.temperature === 'number' ? generationConfig.temperature : undefined,
            top_p: typeof generationConfig?.topP === 'number' ? generationConfig.topP : undefined,
            max_output_tokens: typeof generationConfig?.maxOutputTokens === 'number' ? generationConfig.maxOutputTokens : undefined,
        }];
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const promptTokensUsed = typeof result.promptTokens === 'number' ? result.promptTokens : undefined;
        const completionTokensUsed = typeof result.completionTokens === 'number' ? result.completionTokens : undefined;
        await updateUserTokenUsage(totalTokensUsed, userApiKey); 

        const usageMetadata: Record<string, number> = {
            totalTokenCount: totalTokensUsed,
        };
        if (typeof promptTokensUsed === 'number') usageMetadata.promptTokenCount = promptTokensUsed;
        if (typeof completionTokensUsed === 'number') usageMetadata.candidatesTokenCount = completionTokensUsed;
        
        const geminiResponse = {
            candidates: [
                {
                    content: { parts: mapGeminiOutputParts(result.response), role: "model" },
                    finishReason: "STOP", 
                    index: 0,
                    safetyRatings: [
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "NEGLIGIBLE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" },
                        { category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "NEGLIGIBLE" }
                    ]
                }
            ],
             usageMetadata
        };
        response.json(geminiResponse);
 
   } catch (error: any) { 
        await logError(error, request); // Renamed and added await
        console.error('Gemini Route - generateContent error:', error.message, error.stack);
        const responseTimestamp = new Date().toISOString();
        let statusCode = 500;
        let statusText = 'INTERNAL'; // Default for Gemini-style error object
        let clientMessage = 'Internal server error.';
        let reference = 'An unexpected error occurred processing the Gemini request.'; // For generic 500

        if (error instanceof SyntaxError) {
            statusCode = 400; statusText = 'INVALID_ARGUMENT'; clientMessage = 'Invalid JSON payload.';
        } else if (error.message.includes('Unauthorized') || error.message.includes('API key not valid')) {
            statusCode = 401; statusText = 'UNAUTHENTICATED'; clientMessage = error.message;
        } else if (error.message.includes('limit reached')) {
            statusCode = 429; statusText = 'RESOURCE_EXHAUSTED'; clientMessage = error.message;
        } else if (error.message.includes('No currently active provider supports model') || error.message.includes('No provider (active or disabled) supports model')) {
            statusCode = 404; statusText = 'NOT_FOUND'; clientMessage = `Model ${modelId} not found or is not supported.`;
        } else if (error.message.includes('Failed to process request')) {
            statusCode = 503; statusText = 'UNAVAILABLE'; clientMessage = 'The service is currently unavailable. Please try again later.';
        } else if (error.message.includes("Invalid request body: Could not extract valid user parts")) {
            statusCode = 400; statusText = 'INVALID_ARGUMENT'; clientMessage = error.message;
        }
        // Add more specific error message mappings if needed

        if (!response.completed) {
          if (statusCode === 500) {
               response.status(statusCode).json({ error: 'Internal Server Error', reference, timestamp: responseTimestamp });
          } else {
               response.status(statusCode).json({ error: { code: statusCode, message: clientMessage, status: statusText }, timestamp: responseTimestamp });
          }
        } else { return; }
   }
});

// --- Gemini Interactions API ---
router.post('/interactions', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
    const timestamp = new Date().toISOString();
    if (!request.apiKey || !request.tierLimits) {
        const errDetail = { message: 'Bad Request: Missing API key or tier limits after middleware.', code: 400, status: 'INVALID_ARGUMENT' };
        await logError(errDetail, request);
        if (!response.completed) return response.status(400).json({ error: errDetail, timestamp });
        return;
    }

    try {
        const body = await request.json();
        if (!body || typeof body !== 'object') {
            const errDetail = { message: 'Invalid request body.', code: 400, status: 'INVALID_ARGUMENT' };
            await logError(errDetail, request);
            if (!response.completed) return response.status(400).json({ error: errDetail, timestamp });
            return;
        }

        const model = typeof body.model === 'string' ? body.model.trim() : '';
        const input = typeof body.input === 'string' ? body.input : '';
        if (!model || !input) {
            const errDetail = { message: 'model and input are required.', code: 400, status: 'INVALID_ARGUMENT' };
            await logError(errDetail, request);
            if (!response.completed) return response.status(400).json({ error: errDetail, timestamp });
            return;
        }

        const agent = typeof body.agent === 'string' ? body.agent : undefined;
        const normalized = normalizeDeepResearchModel(model, agent);

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
            'gemini',
            INTERACTIONS_TOKEN_TTL_SECONDS,
            secret,
            model
        );

        // Stateless: respond with processing and interaction_id; polling will execute.
        const responseBody = {
            id: interactionId,
            status: 'processing',
        };
        return response.json(responseBody);
    } catch (error: any) {
        await logError(error, request);
        const responseTimestamp = new Date().toISOString();
        if (!response.completed) {
            response.status(500).json({ error: 'Internal Server Error', reference: 'Failed to create interaction.', timestamp: responseTimestamp });
        }
    }
});

router.get('/interactions/:interactionId', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
    const timestamp = new Date().toISOString();
    if (!request.apiKey || !request.tierLimits || !request.params.interactionId) {
        const errDetail = { message: 'Bad Request: Missing API key or interaction id.', code: 400, status: 'INVALID_ARGUMENT' };
        await logError(errDetail, request);
        if (!response.completed) return response.status(400).json({ error: errDetail, timestamp });
        return;
    }

    try {
        const secret = getInteractionsSigningSecret();
        const payload = verifyInteractionToken(request.params.interactionId, request.apiKey, secret);
        const result = await executeGeminiInteraction(payload.request);

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
            outputs: Array.isArray(result?.outputs) ? result.outputs : [],
            usage: result?.usage,
        };
        return response.json(responseBody);
    } catch (error: any) {
        await logError(error, request);
        const responseTimestamp = new Date().toISOString();
        let statusCode = 500;
        let statusText = 'INTERNAL';
        let clientMessage = 'Internal server error.';

        if (error instanceof SyntaxError || String(error?.message || '').includes('Invalid')) {
            statusCode = 400; statusText = 'INVALID_ARGUMENT'; clientMessage = error.message;
        } else if (String(error?.message || '').includes('expired')) {
            statusCode = 410; statusText = 'FAILED_PRECONDITION'; clientMessage = error.message;
        } else if (String(error?.message || '').includes('Unauthorized') || String(error?.message || '').includes('API key not valid')) {
            statusCode = 401; statusText = 'UNAUTHENTICATED'; clientMessage = error.message;
        }

        if (!response.completed) {
            response.status(statusCode).json({
                error: { code: statusCode, message: clientMessage, status: statusText },
                timestamp: responseTimestamp,
            });
        }
    }
});

const geminiRouter = router;
export default geminiRouter;
