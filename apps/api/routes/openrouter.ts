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

// --- Rate Limiting Store --- 
interface RequestTimestamps { [apiKey: string]: number[]; }
const requestTimestamps: RequestTimestamps = {}; 

// --- Request Extension --- 
// Assumed globally declared

// --- Middleware --- 

// AUTH Middleware (OpenAI/OpenRouter Style: Authorization Bearer)
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const authHeader = request.headers['authorization'] || request.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
     // Mimic OpenRouter 401
     return response.status(401).json({ error: { message: 'Invalid Authentication header', code: 'invalid_auth_header' } });
  }
  const apiKey = authHeader.slice(7);
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          const code = statusCode === 429 ? 'rate_limit_exceeded' : 'invalid_api_key';
          const message = `Unauthorized: ${validationResult.error || 'Invalid API Key'}`;
          return response.status(statusCode).json({ error: { message: message, code: code } }); 
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
       console.error("OpenRouter Route - Error during auth/usage check:", error);
       return response.status(500).json({ error: { message: 'Internal server error during validation.', code: 'internal_server_error' }}); 
  }
}

// RATE LIMIT Middleware (Standard RPM/RPS/RPD checks)
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    if (!request.apiKey || !request.tierLimits) { 
        console.error('OpenRouter Route - Internal Error: API Key or Tier Limits missing.');
        return response.status(500).json({ error: { message: 'Internal server error affecting rate limits.', code: 'internal_server_error' }}); 
    }
    const apiKey = request.apiKey;
    const tierLimits = request.tierLimits; 
    const now = Date.now();
    requestTimestamps[apiKey] = requestTimestamps[apiKey] || [];
    const timestamps = requestTimestamps[apiKey];
    const oneDayAgo = now - 86400000; 
    const oneMinuteAgo = now - 60000;
    const oneSecondAgo = now - 1000;
    
    const recentTimestamps = timestamps.filter(ts => ts > oneDayAgo);
    requestTimestamps[apiKey] = recentTimestamps; 

    const requestsLastSecond = recentTimestamps.filter(ts => ts > oneSecondAgo).length;
    if (requestsLastSecond >= tierLimits.rps) {
         response.setHeader('Retry-After', '1'); 
         return response.status(429).json({ error: { message: `Rate limit exceeded. Limit: ${tierLimits.rps} RPS.`, code: 'rate_limit_exceeded' } });
    }
    
    const requestsLastMinute = recentTimestamps.filter(ts => ts > oneMinuteAgo).length;
     if (requestsLastMinute >= tierLimits.rpm) {
         const retryAfterSeconds = Math.ceil(Math.max(0, (recentTimestamps[recentTimestamps.length - tierLimits.rpm] + 60000 - now) / 1000));
         response.setHeader('Retry-After', String(retryAfterSeconds)); 
        return response.status(429).json({ error: { message: `Rate limit exceeded. Limit: ${tierLimits.rpm} RPM.`, code: 'rate_limit_exceeded' } });
    }

    const requestsLastDay = recentTimestamps.length; 
    if (requestsLastDay >= tierLimits.rpd) {
         const retryAfterSeconds = Math.ceil(Math.max(0,(recentTimestamps[0] + 86400000 - now) / 1000)); 
        response.setHeader('Retry-After', String(retryAfterSeconds)); 
        return response.status(429).json({ error: { message: `Rate limit exceeded. Limit: ${tierLimits.rpd} RPD.`, code: 'rate_limit_exceeded' } });
    }
    
    requestTimestamps[apiKey].push(now); 
    next(); 
}
 
// --- Routes ---
 
// OpenRouter Chat Completions Route
router.post('/v6/chat/completions', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
   if (!request.apiKey || !request.tierLimits) {
        return response.status(500).json({ error: { message: 'Internal Server Error: Auth data missing.', code: 'internal_server_error' }}); 
   }

   const userApiKey = request.apiKey!;
   let originalModelId: string | undefined; // Store the originally requested model

   try {
        // Use the standard OpenAI-style extractor
        const { messages: rawMessages, model } = await extractMessageFromRequest(request);
        originalModelId = model; // Store the requested model name

        if (!originalModelId) {
            return response.status(400).json({ error: { message: 'Missing \'model\' field in request body.', code: 'missing_field' } });
        }

        // --- Extract base model ID for internal handler (remove potential prefix) ---
        const modelIdParts = originalModelId.split('/');
        const baseModelId = modelIdParts[modelIdParts.length - 1]; // Take the part after the last '/'

        // --- Map to internal format using BASE model ID ---
        const formattedMessages: IMessage[] = rawMessages.map(msg => ({ content: msg.content, model: { id: baseModelId } }));
 
        // --- Call the central message handler with BASE model ID ---
        const result = await messageHandler.handleMessages(formattedMessages, baseModelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        // Rough estimates for prompt/completion tokens
        const promptTokens = Math.ceil(formattedMessages[formattedMessages.length - 1].content.length / 4); 
        const completionTokens = Math.max(0, totalTokensUsed - promptTokens);

        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        } else {
            console.warn(`OpenRouter Route - Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
        }
        
        // --- Format response like OpenRouter (OpenAI compatible) ---
        const openRouterResponse = {
            id: `or-${Date.now()}${Math.random().toString(16).slice(2)}`, // OpenRouter specific prefix maybe?
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: originalModelId, // Echo the *originally requested* model ID
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.response
                    },
                    finish_reason: "stop",
                    // OpenRouter includes routing info here
                    // We can add placeholders or approximate if needed
                     usage: { 
                       completion_tokens: completionTokens, 
                       prompt_tokens: promptTokens, 
                       total_tokens: totalTokensUsed 
                     }
                }
            ],
            usage: { // Top-level usage is often included too
                 prompt_tokens: promptTokens,
                 completion_tokens: completionTokens,
                 total_tokens: totalTokensUsed
             },
            // Add our custom fields if desired
            _latency_ms: result.latency,
            _provider_id: result.providerId,
            _base_model_used: baseModelId // Indicate which internal model was targeted
        };
 
        response.json(openRouterResponse);
 
   } catch (error: any) { 
        console.error('OpenRouter Route - /api/v1/chat/completions error:', error.message, error.stack);
        
        // Map internal errors to potential OpenRouter/OpenAI error formats
        if (error instanceof SyntaxError) return response.status(400).json({ error: { message: 'Invalid JSON payload.', code: 'invalid_json' }});
        
        if (error.message.includes('Unauthorized') || error.message.includes('Invalid API Key')) {
             return response.status(401).json({ error: { message: error.message, code: 'invalid_api_key' }});
        }
        if (error.message.includes('limit reached') || error.message.includes('Rate limit exceeded')) {
             return response.status(429).json({ error: { message: error.message, code: 'rate_limit_exceeded' }});
        }
         if (error.message.includes('No currently active provider supports model') || error.message.includes('No provider (active or disabled) supports model')) {
             // Model not found
             return response.status(404).json({ error: { message: `Unknown model: \`${originalModelId || 'unknown'}\`. Please use one of the available models.`, code: 'model_not_found' }});
        }
         if (error.message.includes('Failed to process request')) {
             // Generic failure after retries
             return response.status(503).json({ error: { message: 'Service temporarily unavailable. Please try again later.', code: 'service_unavailable' }});
         }
        // Default internal error
        response.status(500).json({ error: { message: 'Internal server error.', code: 'internal_server_error' }});
   }
});

export default router; // Export the router 