import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler.js';
import { IMessage } from '../providers/interfaces.js';
import {
    generateUserApiKey, // Now async
    updateUserTokenUsage, // Now async
    TierData, // Import TierData type
    extractMessageFromRequestBody // Import helper
} from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js'; // Changed import
import { RequestTimestampStore } from '../modules/rateLimit.js';
import { runAuthMiddleware, runRateLimitMiddleware } from '../modules/middlewareFactory.js';
import { redactToken } from '../modules/redaction.js';

dotenv.config();

const router = new HyperExpress.Router(); // Use Router for modularity

// --- Rate Limiting Store (Separate or Centralized?) ---
const requestTimestamps: RequestTimestampStore = {}; // Local store for this route for now

// --- Request Extension --- 
// Assumed globally declared

// --- Middleware --- 

// AUTH Middleware (OpenAI/Groq Style: Authorization Bearer)
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const timestamp = new Date().toISOString();

    return runAuthMiddleware(request, response, next, {
        extractApiKey: (req) => {
            const authHeader = req.headers['authorization'] || req.headers['Authorization'];
            return authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        },
        onMissingApiKey: async (req) => {
            const errDetail = { message: 'Incorrect API key provided. You can find your API key at https://console.groq.com/keys.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' };
            await logError({ message: errDetail.message, type: errDetail.type, code: errDetail.code }, req);
            return { status: 401, body: { error: errDetail, timestamp } };
        },
        onInvalidApiKey: async (req, details) => {
            const errorType = 'invalid_request_error';
            const code = details.statusCode === 429 ? 'rate_limit_exceeded' : 'invalid_api_key';
            const clientMessage = `${details.error || 'Invalid API Key'}`;
            await logError({ message: clientMessage, details: details.error, type: errorType, code, apiKey: redactToken(details.apiKey) }, req);
            return { status: details.statusCode, body: { error: { message: clientMessage, type: errorType, param: null, code }, timestamp } };
        },
        onInternalError: async (req, error) => {
            await logError(error, req);
            console.error('Groq Route - Error during auth/usage check:', error);
            return { status: 500, body: { error: 'Internal Server Error', reference: 'Error during authentication processing.', timestamp } };
        },
    });
}

// RATE LIMIT Middleware (Standard RPM/RPS/RPD checks)
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    const timestamp = new Date().toISOString(); // For error responses
        return runRateLimitMiddleware(request, response, next, requestTimestamps, {
            onMissingContext: (req) => {
                const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (Groq rateLimitMiddleware).';
                logError({ message: errMsg, requestPath: req.path }, req).catch(e => console.error('Failed background log:', e));
                console.error(errMsg);
                return { status: 500, body: { error: 'Internal Server Error', reference: 'Configuration error for rate limiting.', timestamp } };
            },
            onDenied: (req, details) => {
                const errDetail = {
                    message: `Rate limit exceeded for model. Limit: ${details.limit} ${details.window.toUpperCase()}.`,
                    type: 'invalid_request_error',
                    code: 'rate_limit_exceeded',
                    param: null
                };
                logError(errDetail, req).catch(e => console.error('Failed background log:', e));
                return { status: 429, body: { error: errDetail, timestamp } };
            }
        });
}
 
// --- Routes ---
 
// Groq Chat Completions Route (uses OpenAI path)
router.post('/v4/chat/completions', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
   const routeTimestamp = new Date().toISOString();
   if (!request.apiKey || !request.tierLimits) {
        const errDetail = { message: 'Internal Server Error: Auth data missing after middleware.', type: 'api_error', code: 'internal_server_error' };
        await logError(errDetail, request); // Renamed and added await
        if (!response.completed) {
           return response.status(500).json({ error: 'Internal Server Error', reference: errDetail.message, timestamp: routeTimestamp }); 
        } else { return; }
   }

   const userApiKey = request.apiKey!;
   let modelId: string = '';
    let requestBody: any; // For error logging if needed

   try {
       requestBody = await request.json();
       const { messages: rawMessages, model } = extractMessageFromRequestBody(requestBody);
        
        if (!model) {
             const errDetail = { message: 'Missing \'model\' field in request body.', type: 'invalid_request_error', code: 'missing_field' };
             await logError(errDetail, request); // Renamed and added await
             if (!response.completed) {
                return response.status(400).json({ error: errDetail, timestamp: new Date().toISOString() });
             } else { return; }
        }
        modelId = model;
        
        const formattedMessages: IMessage[] = rawMessages.map((msg: any) => ({ content: msg.content, model: { id: modelId } }));
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const outputTokens = typeof result.completionTokens === 'number' ? result.completionTokens : Math.ceil(result.response.length / 4);
        const promptTokens = typeof result.promptTokens === 'number' ? result.promptTokens : Math.max(0, totalTokensUsed - outputTokens);

        await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        
        const groqResponse = {
            id: `chatcmpl-${Date.now()}${Math.random().toString(16).slice(2)}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: result.response },
                    finish_reason: "stop"
                }
            ],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: outputTokens,
                total_tokens: totalTokensUsed,
                prompt_time: 0, 
                completion_time: result.latency / 1000, 
                total_time: result.latency / 1000
            },
            system_fingerprint: null,
            x_groq: { id: `req_${Date.now()}${Math.random().toString(16).slice(2)}` }
        };
 
        response.json(groqResponse);
 
   } catch (error: any) { 
        await logError(error, request); // Renamed and added await
        console.error('Groq Route - Chat Completions Error:', error.message, error.stack);
        const responseTimestamp = new Date().toISOString();
        let statusCode = 500;
        let errorType = 'api_error';
        let errorCode = 'internal_server_error';
        let clientMessage = 'Internal server error.';
        let reference = 'An unexpected error occurred processing the Groq request.';

        if (error instanceof SyntaxError) {
            statusCode = 400; errorType = 'invalid_request_error'; errorCode = 'invalid_json'; clientMessage = 'Invalid JSON payload.';
        } else if (error.message.includes('Unauthorized') || error.message.includes('Invalid API Key')) {
            statusCode = 401; errorType = 'invalid_request_error'; errorCode = 'invalid_api_key'; clientMessage = error.message;
        } else if (error.message.includes('limit reached') || error.message.includes('Rate limit exceeded')) {
            statusCode = 429; errorType = 'invalid_request_error'; errorCode = 'rate_limit_exceeded'; clientMessage = error.message;
        } else if (error.message.includes('No currently active provider supports model') || error.message.includes('No provider (active or disabled) supports model')) {
            statusCode = 404; errorType = 'invalid_request_error'; errorCode = 'model_not_found'; clientMessage = `The model \`${modelId || requestBody?.model || 'unknown'}\` does not exist or you do not have access to it.`;
        } else if (error.message.includes('Failed to process request')) {
            statusCode = 503; errorType = 'api_error'; errorCode = 'service_unavailable'; clientMessage = 'Service temporarily unavailable. Please try again later.';
        }

        if (statusCode === 500) {
            response.status(statusCode).json({ error: 'Internal Server Error', reference, timestamp: responseTimestamp });
        } else {
            response.status(statusCode).json({ error: { message: clientMessage, type: errorType, param: null, code: errorCode }, timestamp: responseTimestamp });
        }
        if (!response.completed) { return; }
   }
});

const groqRouter = router;
export default groqRouter;
