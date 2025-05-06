import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler'; 
import { IMessage } from '../providers/interfaces'; 
import { 
    generateUserApiKey, // Now async
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage, // Now async
    TierData, // Import TierData type
    extractMessageFromRequest // Import helper
} from '../modules/userData';
import { logErrorToFile } from '../modules/errorLogger'; // Import the logger

dotenv.config();

const router = new HyperExpress.Router(); // Use Router for modularity

// --- Rate Limiting Store (Separate or Centralized?) ---
interface RequestTimestamps { [apiKey: string]: number[]; }
const requestTimestamps: RequestTimestamps = {}; // Local store for this route for now

// --- Request Extension --- 
// Assumed globally declared

// --- Middleware --- 

// AUTH Middleware (OpenAI/Groq Style: Authorization Bearer)
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const authHeader = request.headers['authorization'] || request.headers['Authorization'];
  const timestamp = new Date().toISOString();

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
     const errDetail = { message: 'Incorrect API key provided. You can find your API key at https://console.groq.com/keys.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' };
     logErrorToFile({ message: errDetail.message, type: errDetail.type, code: errDetail.code }, request);
     return response.status(401).json({ error: errDetail, timestamp });
  }
  const apiKey = authHeader.slice(7);
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          const errorType = 'invalid_request_error'; // Groq uses this for both
          const code = statusCode === 429 ? 'rate_limit_exceeded' : 'invalid_api_key';
          const clientMessage = `${validationResult.error || 'Invalid API Key'}`;
          logErrorToFile({ message: clientMessage, details: validationResult.error, type: errorType, code, apiKey }, request);
          return response.status(statusCode).json({ error: { message: clientMessage, type: errorType, param: null, code: code }, timestamp }); 
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
       logErrorToFile(error, request);
       console.error("Groq Route - Error during auth/usage check:", error);
       return response.status(500).json({ 
           error: 'Internal Server Error', 
           reference: 'Error during authentication processing.',
           timestamp 
       }); 
  }
}

// RATE LIMIT Middleware (Standard RPM/RPS/RPD checks)
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    const timestamp = new Date().toISOString(); // For error responses
    if (!request.apiKey || !request.tierLimits) { 
        const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (Groq rateLimitMiddleware).';
        logErrorToFile({ message: errMsg, requestPath: request.path }, request);
        console.error(errMsg);
        return response.status(500).json({ 
            error: 'Internal Server Error', 
            reference: 'Configuration error for rate limiting.', 
            timestamp 
        });
    }
    const apiKey = request.apiKey;
    const tierLimits = request.tierLimits; 
    const now = Date.now();
    requestTimestamps[apiKey] = requestTimestamps[apiKey] || [];
    const currentApiKeyTimestamps = requestTimestamps[apiKey];
    
    const oneDayAgo = now - 86400000; 
    const oneMinuteAgo = now - 60000;
    const oneSecondAgo = now - 1000;
    
    const relevantTimestamps = currentApiKeyTimestamps.filter(ts => ts > oneDayAgo);
    requestTimestamps[apiKey] = relevantTimestamps;

    const requestsLastSecond = relevantTimestamps.filter(ts => ts > oneSecondAgo).length;
    const errorType = 'invalid_request_error'; // Groq specific
    const errorCode = 'rate_limit_exceeded';   // Groq specific

    if (tierLimits.rps > 0 && requestsLastSecond >= tierLimits.rps) {
         const errDetail = { message: `Rate limit exceeded for model. Limit: ${tierLimits.rps} RPS.`, type: errorType, code: errorCode, param: null };
         logErrorToFile(errDetail, request);
         response.setHeader('Retry-After', '1'); 
         return response.status(429).json({ error: errDetail, timestamp });
    }
    
    const requestsLastMinute = relevantTimestamps.filter(ts => ts > oneMinuteAgo).length;
     if (tierLimits.rpm > 0 && requestsLastMinute >= tierLimits.rpm) {
         const errDetail = { message: `Rate limit exceeded for model. Limit: ${tierLimits.rpm} RPM.`, type: errorType, code: errorCode, param: null };
         logErrorToFile(errDetail, request);
         const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0, (relevantTimestamps.find(ts => ts > oneMinuteAgo) || now) + 60000 - now) / 1000));
         response.setHeader('Retry-After', String(retryAfterSeconds)); 
        return response.status(429).json({ error: errDetail, timestamp });
    }

    const requestsLastDay = relevantTimestamps.length;
    if (tierLimits.rpd > 0 && requestsLastDay >= tierLimits.rpd) {
         const errDetail = { message: `Rate limit exceeded for model. Limit: ${tierLimits.rpd} RPD.`, type: errorType, code: errorCode, param: null };
         logErrorToFile(errDetail, request);
         const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0,(relevantTimestamps[0] || now) + 86400000 - now) / 1000));
        response.setHeader('Retry-After', String(retryAfterSeconds)); 
        return response.status(429).json({ error: errDetail, timestamp });
    }
    
    requestTimestamps[apiKey].push(now);
    next(); 
}
 
// --- Routes ---
 
// Groq Chat Completions Route (uses OpenAI path)
router.post('/v4/chat/completions', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
   const routeTimestamp = new Date().toISOString();
   if (!request.apiKey || !request.tierLimits) {
        const errDetail = { message: 'Internal Server Error: Auth data missing after middleware.', type: 'api_error', code: 'internal_server_error' };
        logErrorToFile(errDetail, request);
        return response.status(500).json({ error: 'Internal Server Error', reference: errDetail.message, timestamp: routeTimestamp }); 
   }

   const userApiKey = request.apiKey!;
   let modelId: string = '';
   let requestBody: any; // For error logging if needed

   try {
        requestBody = await extractMessageFromRequest(request); // Use the body from here
        const { messages: rawMessages, model } = requestBody;
        
        if (!model) {
             const errDetail = { message: 'Missing \'model\' field in request body.', type: 'invalid_request_error', code: 'missing_field' };
             logErrorToFile(errDetail, request);
             return response.status(400).json({ error: errDetail, timestamp: new Date().toISOString() });
        }
        modelId = model;
        
        const formattedMessages: IMessage[] = rawMessages.map((msg: any) => ({ content: msg.content, model: { id: modelId } }));
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        const outputTokens = Math.ceil(result.response.length / 4);
        const promptTokens = Math.max(0, totalTokensUsed - outputTokens);

        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        }
        
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
        logErrorToFile(error, request); // Log full error
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
   }
});

export default router; // Export the router 