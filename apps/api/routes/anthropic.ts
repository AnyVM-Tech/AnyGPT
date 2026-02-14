import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler.js'; 
import { IMessage } from '../providers/interfaces.js'; 
import { 
    generateUserApiKey, // Now async
    updateUserTokenUsage, // Now async
    TierData // Import TierData type
} from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js'; // Changed import
import { RequestTimestampStore } from '../modules/rateLimit.js';
import { runAuthMiddleware, runRateLimitMiddleware } from '../modules/middlewareFactory.js';

dotenv.config();

const router = new HyperExpress.Router(); // Use Router for modularity

// --- Rate Limiting Store (Separate or Centralized?) ---
const requestTimestamps: RequestTimestampStore = {}; // Local store for this route for now

// --- Request Extension --- 
// Assumed globally declared, otherwise re-declare or centralize

// --- Middleware --- 

// AUTH Middleware (Adapted for Anthropic x-api-key)
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const timestamp = new Date().toISOString();

  return runAuthMiddleware(request, response, next, {
    extractApiKey: (req) => req.headers['x-api-key'] as string || null,
    onMissingApiKey: async (req) => {
      const errDetail = { message: 'Missing API key (x-api-key header required).' };
      await logError(errDetail, req);
      return { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: errDetail.message }, timestamp } };
    },
    onInvalidApiKey: async (req, details) => {
      const errorType = details.statusCode === 429 ? 'rate_limit_error' : 'authentication_error';
      const clientMessage = details.statusCode === 429 ? 'Rate limit reached' : 'Invalid API Key';
      const logMsg = `${clientMessage}. ${details.error || ''}`.trim();
      await logError({ message: logMsg, details: details.error, apiKey: details.apiKey }, req);
      return { status: details.statusCode, body: { type: 'error', error: { type: errorType, message: logMsg }, timestamp } };
    },
    onInternalError: async (req, error) => {
      await logError(error, req);
      console.error('Anthropic Route - Error during auth/usage check:', error);
      return { status: 500, body: { error: 'Internal Server Error', reference: 'Error during authentication processing.', timestamp } };
    },
  });
}

// RATE LIMIT Middleware (Adapted for Anthropic)
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    const timestamp = new Date().toISOString();
    return runRateLimitMiddleware(request, response, next, requestTimestamps, {
      onMissingContext: (req) => {
        const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (Anthropic rateLimitMiddleware).';
        logError({ message: errMsg, requestPath: req.path }, req).catch(e => console.error('Failed background log:', e));
        console.error(errMsg);
        return { status: 500, body: { error: 'Internal Server Error', reference: 'Configuration error for rate limiting.', timestamp } };
      },
      onDenied: (req, details) => {
        const errDetail = { message: `Rate limit exceeded: Max ${details.limit} ${details.window.toUpperCase()}.`, type: 'rate_limit_error' };
        logError(errDetail, req).catch(e => console.error('Failed background log:', e));
        return { status: 429, body: { type: 'error', error: errDetail, timestamp } };
      }
    });
}
 
// --- Routes ---
 
// Anthropic Messages Route
router.post('/v3/messages', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
   const timestamp = new Date().toISOString();
   if (!request.apiKey || !request.tierLimits) {
        const errDetail = { message: 'Internal Server Error: Auth data missing after middleware.', type: 'api_error' };
        await logError(errDetail, request); // Renamed and added await
        if (!response.completed) {
          return response.status(500).json({ error: 'Internal Server Error', reference: errDetail.message, timestamp }); 
        } else { return; }
   }

   const userApiKey = request.apiKey!;
   let body: any; // Define body outside try block for error handling scope

   try {
        body = await request.json();
        
        // --- Basic Input Validation ---
        if (!body || !body.model || typeof body.model !== 'string') {
             const errDetail = { message: 'Missing or invalid model parameter.', type: 'invalid_request_error' };
             await logError(errDetail, request); // Renamed and added await
             if (!response.completed) {
               return response.status(400).json({ type: 'error', error: errDetail, timestamp });
             } else { return; }
        }
         if (!Array.isArray(body.messages) || body.messages.length === 0) {
             const errDetail = { message: 'Missing or invalid messages array.', type: 'invalid_request_error' };
             await logError(errDetail, request); // Manually ensure this uses logError
             if (!response.completed) {
               return response.status(400).json({ type: 'error', error: errDetail, timestamp });
             } else { return; }
        }
        // Anthropic requires alternating user/assistant roles, starting with user.
        if (body.messages[0].role !== 'user') {
             const errDetail = { message: 'First message must have role \'user\'.', type: 'invalid_request_error' };
             await logError(errDetail, request);
             if (!response.completed) {
               return response.status(400).json({ type: 'error', error: errDetail, timestamp });
             } else { return; }
        }
        // We'll primarily use the *last* user message for our simple handler
        const lastMessage = body.messages[body.messages.length - 1];
         if (!lastMessage || lastMessage.role !== 'user' || typeof lastMessage.content !== 'string' || !lastMessage.content.trim()) {
              const errDetail = { message: 'Invalid or empty content in the last user message.', type: 'invalid_request_error' };
              await logError(errDetail, request);
              if (!response.completed) {
                 return response.status(400).json({ type: 'error', error: errDetail, timestamp });
              } else { return; }
         }

        const modelId = body.model;
        const lastUserContent = lastMessage.content;
        
        // --- Map to internal format ---
        const formattedMessages: IMessage[] = [{ content: lastUserContent, model: { id: modelId } }];
 
        // --- Call the central message handler ---
        // Assuming handleMessages now returns { response: string; latency: number; tokenUsage: number; providerId: string; }
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const inputTokens = typeof result.promptTokens === 'number' ? result.promptTokens : Math.ceil(lastUserContent.length / 4);
        const outputTokens = typeof result.completionTokens === 'number' ? result.completionTokens : Math.max(0, totalTokensUsed - inputTokens);

        await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        
        // --- Format response like Anthropic ---
        const anthropicResponse = {
            id: `msg_${Date.now()}${Math.random().toString(36).substring(2, 10)}`, // Generate a pseudo-random ID
            type: "message",
            role: "assistant",
            model: modelId, // Echo the requested model
            content: [
                { type: "text", text: result.response }
            ],
            stop_reason: "end_turn", // Assuming normal stop
            stop_sequence: null,
            usage: {
                input_tokens: inputTokens, 
                output_tokens: outputTokens,
            }
        };
 
        response.json(anthropicResponse);
 
   } catch (error: any) { 
        await logError(error, request);
        console.error('Anthropic Route - /v3/messages error:', error.message, error.stack);
        const responseTimestamp = new Date().toISOString();
        let statusCode = 500;
        let errorType = 'api_error';
        let clientMessage = 'Internal server error.';
        let reference = 'An unexpected error occurred processing the Anthropic request.';

        if (error instanceof SyntaxError) {
            statusCode = 400; errorType = 'invalid_request_error'; clientMessage = 'Invalid JSON payload.';
        } else if (error.message.includes('Unauthorized') || error.message.includes('Invalid API Key')) {
            statusCode = 401; errorType = 'authentication_error'; clientMessage = error.message;
        } else if (error.message.includes('limit reached') || error.message.includes('Rate limit exceeded')) {
            statusCode = 429; errorType = 'rate_limit_error'; clientMessage = error.message;
        } else if (error.message.includes('No currently active provider supports model') || error.message.includes('No provider (active or disabled) supports model')) {
            statusCode = 404; errorType = 'not_found_error'; clientMessage = `The requested model '${body?.model ?? 'unknown'}' does not exist or you do not have access to it.`;
        } else if (error.message.includes('Failed to process request')) {
            statusCode = 503; errorType = 'api_error'; clientMessage = 'The service is temporarily overloaded. Please try again later.';
        }

        if (statusCode === 500) {
             response.status(statusCode).json({ error: 'Internal Server Error', reference, timestamp: responseTimestamp });
        } else {
             response.status(statusCode).json({ type: 'error', error: { type: errorType, message: clientMessage }, timestamp: responseTimestamp });
        }
   }
});

const anthropicRouter = router;
export default anthropicRouter;