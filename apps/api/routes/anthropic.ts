import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler'; 
import { IMessage } from '../providers/interfaces'; 
import { 
    generateUserApiKey, // Now async
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage, // Now async
    TierData // Import TierData type
} from '../modules/userData';
import { logError } from '../modules/errorLogger'; // Changed import

dotenv.config();

const router = new HyperExpress.Router(); // Use Router for modularity

// --- Rate Limiting Store (Separate or Centralized?) ---
interface RequestTimestamps { [apiKey: string]: number[]; }
const requestTimestamps: RequestTimestamps = {}; // Local store for this route for now

// --- Request Extension --- 
// Assumed globally declared, otherwise re-declare or centralize

// --- Middleware --- 

// AUTH Middleware (Adapted for Anthropic x-api-key)
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const apiKey = request.headers['x-api-key'] as string; // Anthropic uses x-api-key
  const timestamp = new Date().toISOString();

  if (!apiKey) {
     const errDetail = { message: 'Missing API key (x-api-key header required).' };
     await logError(errDetail, request); // Renamed and added await
     if (!response.completed) {
       return response.status(401).json({ type: 'error', error: { type: 'authentication_error', message: errDetail.message }, timestamp }); 
     } else { return; }
  }
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          const errorType = statusCode === 429 ? 'rate_limit_error' : 'authentication_error';
          const clientMessage = statusCode === 429 ? 'Rate limit reached' : 'Invalid API Key';
          const logMsg = `${clientMessage}. ${validationResult.error || ''}`.trim();
          await logError({ message: logMsg, details: validationResult.error, apiKey }, request); // Renamed and added await
          if (!response.completed) {
            return response.status(statusCode).json({ type: 'error', error: { type: errorType, message: logMsg }, timestamp }); 
          } else { return; }
      }

      // Attach data
      request.apiKey = apiKey;
      request.userId = validationResult.userData.userId;
      request.userRole = validationResult.userData.role;
      request.userTokenUsage = validationResult.userData.tokenUsage; 
      request.userTier = validationResult.userData.tier; 
      request.tierLimits = validationResult.tierLimits; 
      
      // Let flow continue
      next();

  } catch (error: any) {
       await logError(error, request); // Renamed and added await
       console.error("Anthropic Route - Error during auth/usage check:", error);
       if (!response.completed) {
          return response.status(500).json({ 
             error: 'Internal Server Error', 
             reference: 'Error during authentication processing.',
             timestamp 
          }); 
       } else { return; }
  }
}

// RATE LIMIT Middleware (Adapted for Anthropic)
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    const timestamp = new Date().toISOString();
    if (!request.apiKey || !request.tierLimits) { 
        const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (Anthropic rateLimitMiddleware).';
        logError({ message: errMsg, requestPath: request.path }, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
        console.error(errMsg);
        if (!response.completed) {
          return response.status(500).json({ 
             error: 'Internal Server Error', 
             reference: 'Configuration error for rate limiting.', 
             timestamp 
          });
        } else { return; }
    }
    const apiKey = request.apiKey;
    const tierLimits = request.tierLimits; 
    const now = Date.now();
    requestTimestamps[apiKey] = requestTimestamps[apiKey] || [];
    const currentApiKeyTimestamps = requestTimestamps[apiKey];
    
    // Filter timestamps for RPD, RPM, RPS checks
    const oneDayAgo = now - 86400000; // 24 * 60 * 60 * 1000
    const oneMinuteAgo = now - 60000;
    const oneSecondAgo = now - 1000;

    // Keep only relevant timestamps to avoid memory leak
    const relevantTimestamps = currentApiKeyTimestamps.filter(ts => ts > oneDayAgo);
    requestTimestamps[apiKey] = relevantTimestamps;

    const requestsLastDay = relevantTimestamps.length; // Count for RPD directly from already filtered
    const requestsLastMinute = relevantTimestamps.filter(ts => ts > oneMinuteAgo).length;
    const requestsLastSecond = relevantTimestamps.filter(ts => ts > oneSecondAgo).length;

    if (tierLimits.rps > 0 && requestsLastSecond >= tierLimits.rps) {
         const errDetail = { message: `Rate limit exceeded: Max ${tierLimits.rps} RPS.`, type: 'rate_limit_error'};
         logError(errDetail, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
         response.setHeader('Retry-After', '1'); 
         if (!response.completed) {
           return response.status(429).json({ type: 'error', error: errDetail, timestamp });
         } else { return; }
    }
    if (tierLimits.rpm > 0 && requestsLastMinute >= tierLimits.rpm) {
        const errDetail = { message: `Rate limit exceeded: Max ${tierLimits.rpm} RPM.`, type: 'rate_limit_error'};
        logError(errDetail, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
        // Calculate Retry-After for RPM if possible, though Anthropic might not use it
        const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0, (relevantTimestamps.find(ts => ts > oneMinuteAgo) || now) + 60000 - now) / 1000));
        response.setHeader('Retry-After', String(retryAfterSeconds));
        if (!response.completed) {
          return response.status(429).json({ type: 'error', error: errDetail, timestamp });
        } else { return; }
    }
    if (tierLimits.rpd > 0 && requestsLastDay >= tierLimits.rpd) {
        const errDetail = { message: `Rate limit exceeded: Max ${tierLimits.rpd} RPD.`, type: 'rate_limit_error'};
        logError(errDetail, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
        const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0,(relevantTimestamps[0] || now) + 86400000 - now) / 1000));
        response.setHeader('Retry-After', String(retryAfterSeconds)); 
        if (!response.completed) {
          return response.status(429).json({ type: 'error', error: errDetail, timestamp });
        } else { return; }
    }
    
    requestTimestamps[apiKey].push(now);
    next(); 
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
        // TODO: Get separate input/output tokens if handler provides them later
        const inputTokens = Math.ceil(lastUserContent.length / 4); // Rough estimate
        const outputTokens = Math.max(0, totalTokensUsed - inputTokens); // Rough estimate

        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        } else {
            console.warn(`Anthropic Route - Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
        }
        
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