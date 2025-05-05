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
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
     // Mimic Groq/OpenAI 401
     return response.status(401).json({ error: { message: 'Incorrect API key provided. You can find your API key at https://console.groq.com/keys.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } });
  }
  const apiKey = authHeader.slice(7);
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          const errorType = statusCode === 429 ? 'invalid_request_error' : 'invalid_request_error'; // Groq seems to use this type often
          const code = statusCode === 429 ? 'rate_limit_exceeded' : 'invalid_api_key';
          const message = `${validationResult.error || 'Invalid API Key'}`;
          return response.status(statusCode).json({ error: { message: message, type: errorType, param: null, code: code } }); 
      }

      // Attach data
      request.apiKey = apiKey;
      request.userId = validationResult.userData.userId;
      request.userRole = validationResult.userData.role;
      request.userTokenUsage = validationResult.userData.tokenUsage; 
      request.userTier = validationResult.userData.tier; 
      request.tierLimits = validationResult.tierLimits; 
      
      // Let flow continue

  } catch (error) {
       console.error("Groq Route - Error during auth/usage check:", error);
       return response.status(500).json({ error: { message: 'Internal server error during validation.', type: 'api_error', param: null, code: 'internal_server_error' }}); 
  }
}

// RATE LIMIT Middleware (Standard RPM/RPS/RPD checks)
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    if (!request.apiKey || !request.tierLimits) { 
        console.error('Groq Route - Internal Error: API Key or Tier Limits missing.');
        return response.status(500).json({ error: { message: 'Internal server error affecting rate limits.', type: 'api_error', param: null, code: 'internal_server_error' }}); 
    }
    const apiKey = request.apiKey;
    const tierLimits = request.tierLimits; 
    const now = Date.now();
    requestTimestamps[apiKey] = requestTimestamps[apiKey] || [];
    const timestamps = requestTimestamps[apiKey];
    const oneDayAgo = now - 86400000; 
    const oneMinuteAgo = now - 60000;
    const oneSecondAgo = now - 1000;
    
    // Filter efficiently once
    const recentTimestamps = timestamps.filter(ts => ts > oneDayAgo);
    requestTimestamps[apiKey] = recentTimestamps; // Update stored timestamps

    const requestsLastSecond = recentTimestamps.filter(ts => ts > oneSecondAgo).length;
    if (requestsLastSecond >= tierLimits.rps) {
         response.setHeader('Retry-After', '1'); 
         return response.status(429).json({ error: { message: `Rate limit exceeded for model. Limit: ${tierLimits.rps} RPS.`, type: 'invalid_request_error', param: null, code: 'rate_limit_exceeded' } });
    }
    
    const requestsLastMinute = recentTimestamps.filter(ts => ts > oneMinuteAgo).length;
     if (requestsLastMinute >= tierLimits.rpm) {
         const retryAfterSeconds = Math.ceil(Math.max(0, (recentTimestamps[recentTimestamps.length - tierLimits.rpm] + 60000 - now) / 1000));
         response.setHeader('Retry-After', String(retryAfterSeconds)); 
        return response.status(429).json({ error: { message: `Rate limit exceeded for model. Limit: ${tierLimits.rpm} RPM.`, type: 'invalid_request_error', param: null, code: 'rate_limit_exceeded' } });
    }

    const requestsLastDay = recentTimestamps.length; // No need to filter again
    if (requestsLastDay >= tierLimits.rpd) {
         const retryAfterSeconds = Math.ceil(Math.max(0,(recentTimestamps[0] + 86400000 - now) / 1000)); // Approximates based on oldest req in window
        response.setHeader('Retry-After', String(retryAfterSeconds)); 
        return response.status(429).json({ error: { message: `Rate limit exceeded for model. Limit: ${tierLimits.rpd} RPD.`, type: 'invalid_request_error', param: null, code: 'rate_limit_exceeded' } });
    }
    
    requestTimestamps[apiKey].push(now); // Add current request timestamp AFTER checks pass
    next(); 
}
 
// --- Routes ---
 
// Groq Chat Completions Route (uses OpenAI path)
router.post('/v4/chat/completions', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
   if (!request.apiKey || !request.tierLimits) {
        return response.status(500).json({ error: { message: 'Internal Server Error: Auth data missing.', type: 'api_error' }}); 
   }

   const userApiKey = request.apiKey!;
   let modelId: string = ''; // Initialize modelId

   try {
        // Use the same extractor as OpenAI route
        const { messages: rawMessages, model } = await extractMessageFromRequest(request);
        if (!model) {
             return response.status(400).json({ error: { message: 'Missing \'model\' field in request body.', type: 'invalid_request_error', code: 'missing_field' }});
        }
        modelId = model; // Assign extracted model ID
        
        // --- Map to internal format ---
        const formattedMessages: IMessage[] = rawMessages.map(msg => ({ content: msg.content, model: { id: modelId } }));
 
        // --- Call the central message handler ---
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        // Rough token estimates for usage object
        const outputTokens = Math.ceil(result.response.length / 4); // Estimate based on output
        const promptTokens = Math.max(0, totalTokensUsed - outputTokens);

        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        } else {
            console.warn(`Groq Route - Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
        }
        
        // --- Format response like Groq (OpenAI compatible + x_groq) ---
        const groqResponse = {
            id: `chatcmpl-${Date.now()}${Math.random().toString(16).slice(2)}`, // Groq uses hex IDs
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.response
                    },
                    finish_reason: "stop"
                }
            ],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: outputTokens,
                total_tokens: totalTokensUsed,
                prompt_time: 0, // Placeholder - we don't calculate this
                completion_time: result.latency / 1000, // Approximate completion time in seconds
                total_time: result.latency / 1000 // Approximate total time
            },
            system_fingerprint: null, // Groq often returns null
            x_groq: { // Groq specific extension
                 id: `req_${Date.now()}${Math.random().toString(16).slice(2)}`, // Generate a request ID
                 // We don't have token/time per second info readily available
                 // usage: { ... detailed usage ... } 
            },
            // Add our custom fields if desired
            _latency_ms: result.latency,
            _provider_id: result.providerId
        };
 
        response.json(groqResponse);
 
   } catch (error: any) { 
        console.error('Groq Route - /openai/v1/chat/completions error:', error.message, error.stack);
        
        // Map internal errors to potential Groq/OpenAI error formats
        if (error instanceof SyntaxError) return response.status(400).json({ error: { message: 'Invalid JSON payload.', type: 'invalid_request_error', code: 'invalid_json' }});
        
        if (error.message.includes('Unauthorized') || error.message.includes('Invalid API Key')) {
             return response.status(401).json({ error: { message: error.message, type: 'invalid_request_error', code: 'invalid_api_key' }});
        }
        if (error.message.includes('limit reached') || error.message.includes('Rate limit exceeded')) {
             return response.status(429).json({ error: { message: error.message, type: 'invalid_request_error', code: 'rate_limit_exceeded' }});
        }
         if (error.message.includes('No currently active provider supports model') || error.message.includes('No provider (active or disabled) supports model')) {
             // Use modelId safely here because it's initialized
             return response.status(404).json({ error: { message: `The model \`${modelId || 'unknown'}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' }});
        }
         if (error.message.includes('Failed to process request')) {
             return response.status(503).json({ error: { message: 'Service temporarily unavailable. Please try again later.', type: 'api_error', code: 'service_unavailable' }});
         }
        // Default internal error
        response.status(500).json({ error: { message: 'Internal server error.', type: 'api_error', code: 'internal_server_error' }});
   }
});

export default router; // Export the router 