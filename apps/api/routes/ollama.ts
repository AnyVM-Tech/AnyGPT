import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler.js'; 
import { IMessage } from '../providers/interfaces.js'; 
import { 
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage, // Now async
    TierData, // Import TierData type
    // We don\'t use extractMessageFromRequest for Ollama format
} from '../modules/userData.js';

dotenv.config();

const router = new HyperExpress.Router(); // Use Router for modularity

// --- Rate Limiting Store --- 
interface RequestTimestamps { [apiKey: string]: number[]; }
const requestTimestamps: RequestTimestamps = {}; 

// --- Request Extension --- 
// Assumed globally declared

// --- Middleware --- 

// AUTH Middleware (Using Bearer token for consistency)
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const authHeader = request.headers['authorization'] || request.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
     // Generic 401 for missing key
     return response.status(401).json({ error: 'Unauthorized: Missing or invalid Bearer token.' });
  }
  const apiKey = authHeader.slice(7);
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          const message = `Unauthorized: ${validationResult.error || 'Invalid API Key'}`;
          return response.status(statusCode).json({ error: message }); 
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
       console.error("Ollama Route - Error during auth/usage check:", error);
       return response.status(500).json({ error: 'Internal server error during validation.' }); 
  }
}

// RATE LIMIT Middleware
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    if (!request.apiKey || !request.tierLimits) { 
        console.error('Ollama Route - Internal Error: API Key or Tier Limits missing.');
        return response.status(500).json({ error: 'Internal server error affecting rate limits.' }); 
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
        return response.status(429).json({ error: `Rate limit exceeded: You are limited to ${tierLimits.rpm} requests per minute.` }); 
    }
    
    // Keep track
    requestTimestamps[apiKey] = recentTimestamps;
    requestTimestamps[apiKey].push(now);
    next(); 
}
 
// --- Routes ---
 
// Ollama Chat Route
router.post('/v5/api/chat', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
   if (!request.apiKey || !request.tierLimits) {
        return response.status(500).json({ error: 'Internal Server Error: Auth data missing.' }); 
   }

   const userApiKey = request.apiKey!;
   let requestBody: any; 

   try {
        requestBody = await request.json();
        
        // --- Basic Input Validation (Ollama structure) ---
        if (!requestBody || !requestBody.model || typeof requestBody.model !== 'string') {
             return response.status(400).json({ error: 'Missing or invalid \'model\' field.' });
        }
         if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
             return response.status(400).json({ error: 'Missing or invalid \'messages\' array.' });
        }
        // Find the last user message content
        let lastUserContent: string | null = null;
        for (let i = requestBody.messages.length - 1; i >= 0; i--) {
            if (requestBody.messages[i].role === 'user') {
                const content = requestBody.messages[i].content;
                 // Ensure content is a non-empty string
                 if (typeof content === 'string' && content.trim()) {
                    lastUserContent = content;
                    break;
                }
            }
        }
        if (!lastUserContent) {
             return response.status(400).json({ error: 'Could not find valid user content in messages.' });
        }

        const modelId = requestBody.model;
        
        // --- Map to internal format ---
        const formattedMessages: IMessage[] = [{ content: lastUserContent, model: { id: modelId } }];
 
        // --- Call the central message handler ---
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        // Estimate prompt/eval counts (very rough)
        const promptTokens = Math.ceil(lastUserContent.length / 4); 
        const completionTokens = Math.max(0, totalTokensUsed - promptTokens); 

        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        } else {
            console.warn(`Ollama Route - Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
        }
        
        // --- Format response like Ollama ---
        const ollamaResponse = {
            model: modelId,
            created_at: new Date().toISOString(),
            message: {
                role: "assistant",
                content: result.response,
            },
            done: true,
            total_duration: result.latency * 1_000_000, // Convert ms to ns
            load_duration: 0, // Placeholder
            prompt_eval_count: promptTokens, // Estimate
            prompt_eval_duration: 0, // Placeholder
            eval_count: completionTokens, // Estimate
            eval_duration: result.latency * 1_000_000, // Estimate - use total latency for eval
        };
 
        response.json(ollamaResponse);
 
   } catch (error: any) { 
        console.error('Ollama Route - /api/chat error:', error.message, error.stack);
        
        // Map internal errors to potential Ollama error messages (less structured)
        if (error instanceof SyntaxError) return response.status(400).json({ error: 'Invalid JSON payload.' });
        
        if (error.message.includes('Unauthorized') || error.message.includes('Invalid API Key')) {
             return response.status(401).json({ error: error.message });
        }
        if (error.message.includes('limit reached') || error.message.includes('Rate limit exceeded')) {
             return response.status(429).json({ error: error.message });
        }
         if (error.message.includes('No currently active provider supports model') || error.message.includes('No provider (active or disabled) supports model')) {
             // Model not found
             return response.status(404).json({ error: `Model '${requestBody?.model ?? 'unknown'}' not found.` });
        }
         if (error.message.includes('Failed to process request')) {
             // Generic failure after retries
             return response.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
         }
        // Default internal error
        response.status(500).json({ error: 'Internal server error.' });
   }
});

const ollamaRouter = router;
export default ollamaRouter;