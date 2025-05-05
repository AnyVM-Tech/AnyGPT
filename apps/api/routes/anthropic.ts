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
  if (!apiKey) {
     // Anthropic error format
     return response.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Missing API key.' }}); 
  }
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          const errorType = statusCode === 429 ? 'rate_limit_error' : 'authentication_error';
          const message = statusCode === 429 ? 'Rate limit reached' : 'Invalid API Key';
          return response.status(statusCode).json({ type: 'error', error: { type: errorType, message: `${message}. ${validationResult.error || ''}`.trim() }}); 
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
       console.error("Anthropic Route - Error during auth/usage check:", error);
       return response.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Internal server error during validation.' }}); 
  }
}

// RATE LIMIT Middleware (Adapted for Anthropic)
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    if (!request.apiKey || !request.tierLimits) { 
        console.error('Anthropic Route - Internal Error: API Key or Tier Limits missing.');
        return response.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Internal server error affecting rate limits.' }}); 
    }
    const apiKey = request.apiKey;
    const tierLimits = request.tierLimits; 
    const now = Date.now();
    requestTimestamps[apiKey] = requestTimestamps[apiKey] || [];
    const timestamps = requestTimestamps[apiKey];
    const oneMinuteAgo = now - 60000;
    const recentTimestamps = timestamps.filter(ts => ts > oneMinuteAgo);
    const requestsLastMinute = recentTimestamps.length;

    // Primary limit: RPM
    if (requestsLastMinute >= tierLimits.rpm) {
         // Anthropic doesn't use Retry-After, just 429
        return response.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: `Rate limit exceeded: You are limited to ${tierLimits.rpm} requests per minute.` }}); 
    }
    
    // Keep track of requests within the window for RPM check
    requestTimestamps[apiKey] = recentTimestamps;
    requestTimestamps[apiKey].push(now);
    next(); 
}
 
// --- Routes ---
 
// Anthropic Messages Route
router.post('/v3/messages', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
   if (!request.apiKey || !request.tierLimits) {
        return response.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Internal Server Error: Auth data missing.' }}); 
   }

   const userApiKey = request.apiKey!;
   let body: any; // Define body outside try block for error handling scope

   try {
        body = await request.json();
        
        // --- Basic Input Validation ---
        if (!body || !body.model || typeof body.model !== 'string') {
             return response.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing or invalid \'model\' parameter.' }});
        }
         if (!Array.isArray(body.messages) || body.messages.length === 0) {
             return response.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing or invalid \'messages\' array.' }});
        }
        // Anthropic requires alternating user/assistant roles, starting with user.
        if (body.messages[0].role !== 'user') {
             return response.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'First message must have role \'user\'.' }});
        }
        // We'll primarily use the *last* user message for our simple handler
        const lastMessage = body.messages[body.messages.length - 1];
         if (!lastMessage || lastMessage.role !== 'user' || typeof lastMessage.content !== 'string' || !lastMessage.content.trim()) {
              return response.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid or empty content in the last user message.' }});
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
        console.error('Anthropic Route - /v1/messages error:', error.message, error.stack);
        
        // Map internal errors to potential Anthropic error formats
        if (error instanceof SyntaxError) return response.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON payload.' }});
        
        if (error.message.includes('Unauthorized') || error.message.includes('Invalid API Key')) {
             return response.status(401).json({ type: 'error', error: { type: 'authentication_error', message: error.message }});
        }
        if (error.message.includes('limit reached') || error.message.includes('Rate limit exceeded')) {
             return response.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: error.message }});
        }
         if (error.message.includes('No currently active provider supports model') || error.message.includes('No provider (active or disabled) supports model')) {
             // Model not found or unavailable via this proxy
             // Use body?.model safely here because body is defined in the outer scope
             return response.status(404).json({ type: 'error', error: { type: 'not_found_error', message: `The requested model '${body?.model ?? 'unknown'}' does not exist or you do not have access to it.` }});
        }
         if (error.message.includes('Failed to process request')) {
              // Generic failure after retries - map to overload or internal error
             return response.status(503).json({ type: 'error', error: { type: 'api_error', message: 'The service is temporarily overloaded. Please try again later.' }});
         }
        // Default internal error
        response.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Internal server error.' }});
   }
});

export default router; // Export the router 