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

// --- Rate Limiting Store (Consider sharing or centralizing if needed across routes) --- 
interface RequestTimestamps { [apiKey: string]: number[]; }
const requestTimestamps: RequestTimestamps = {};

// --- Request Extension (Already declared globally in openai.ts, should be accessible) ---
// If running routes separately, this might need re-declaration or centralizing.

// --- Middleware (Assume shared middleware setup from server.ts or copied/adapted) ---

// AUTH Middleware (Copied and adapted - MUST BE ASYNC)
// NOTE: Ideally, middleware should be defined centrally and imported.
// This is a temporary copy for self-containment.
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const apiKey = request.headers['x-goog-api-key'] as string; // Gemini uses x-goog-api-key
  if (!apiKey) {
     // Use double quotes for the outer string to allow inner single quotes
     return response.status(401).json({ error: { code: 401, message: "API key missing. Please pass an API key in 'x-goog-api-key' header.", status: 'UNAUTHENTICATED' }}); 
  }
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          const statusText = statusCode === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAUTHENTICATED';
          return response.status(statusCode).json({ error: { code: statusCode, message: `API key not valid. ${validationResult.error || 'Please pass a valid API key.'}`, status: statusText }}); 
      }

      // Attach data
      request.apiKey = apiKey;
      request.userId = validationResult.userData.userId;
      request.userRole = validationResult.userData.role;
      request.userTokenUsage = validationResult.userData.tokenUsage; 
      request.userTier = validationResult.userData.tier; 
      request.tierLimits = validationResult.tierLimits; 
      
      // Let flow continue naturally in async middleware for HyperExpress

  } catch (error) {
       console.error("Gemini Route - Error during auth/usage check:", error);
       return response.status(500).json({ error: { code: 500, message: 'Internal server error during validation.', status: 'INTERNAL' }}); 
  }
}

// RATE LIMIT Middleware (Copied and adapted - Synchronous)
// NOTE: Ideally, middleware should be defined centrally and imported.
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    if (!request.apiKey || !request.tierLimits) { 
        console.error('Gemini Route - Internal Error: API Key or Tier Limits missing.');
        // Gemini might return 429 for internal errors affecting limits too
        return response.status(429).json({ error: { code: 429, message: 'Internal server error affecting rate limits.', status: 'RESOURCE_EXHAUSTED' }}); 
    }
    const apiKey = request.apiKey;
    const tierLimits = request.tierLimits; 
    const now = Date.now();
    requestTimestamps[apiKey] = requestTimestamps[apiKey] || [];
    const timestamps = requestTimestamps[apiKey];
    const oneDayAgo = now - 86400000; // 24 * 60 * 60 * 1000
    const oneMinuteAgo = now - 60000;
    const oneSecondAgo = now - 1000;
    const recentTimestamps = timestamps.filter(ts => ts > oneDayAgo);
    const requestsLastDay = recentTimestamps.length;
    const requestsLastMinute = recentTimestamps.filter(ts => ts > oneMinuteAgo).length;
    const requestsLastSecond = recentTimestamps.filter(ts => ts > oneSecondAgo).length;

    // Use RPM as the primary limit for Gemini-style API
    if (requestsLastMinute >= tierLimits.rpm) {
         const retryAfterSeconds = Math.ceil(Math.max(0, (recentTimestamps[recentTimestamps.length - tierLimits.rpm] + 60000 - now) / 1000));
         // Gemini doesn't typically use Retry-After header, just returns 429
        return response.status(429).json({ error: { code: 429, message: `Rate limit exceeded. Please try again later. You are limited to ${tierLimits.rpm} requests per minute.`, status: 'RESOURCE_EXHAUSTED' }}); 
    }
    
    // Optional: Add RPD check if needed, though less common for Gemini direct errors
    // if (requestsLastDay >= tierLimits.rpd) { ... }

    recentTimestamps.push(now);
    requestTimestamps[apiKey] = recentTimestamps; 
    next(); 
}
 
// --- Routes ---
 
// Gemini Generate Content Route
router.post('/v2/models/:modelId:generateContent', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
    // Check if middleware failed (e.g., didn't attach required data)
   if (!request.apiKey || !request.tierLimits || !request.params.modelId) {
        // This case might be handled by middleware sending responses, but as a safeguard:
        return response.status(400).json({ error: { code: 400, message: 'Bad Request: Missing API key, tier limits, or model ID after middleware processing.', status: 'INVALID_ARGUMENT' }}); 
   }

   const userApiKey = request.apiKey!;
   const modelId = request.params.modelId;

   try {
        const body = await request.json();
        
        // --- Basic Input Validation ---
        if (!body || !Array.isArray(body.contents) || body.contents.length === 0) {
            // Use double quotes for the outer string
            return response.status(400).json({ error: { code: 400, message: "Invalid request body: Missing or invalid 'contents' array.", status: 'INVALID_ARGUMENT' }});
        }

        // --- Map Gemini format to internal IMessage format ---
        // Assuming simple text input for now, taking the last user message
        let lastUserContent = '';
        const lastContent = body.contents[body.contents.length - 1];
        if (lastContent && lastContent.role === 'user' && Array.isArray(lastContent.parts) && lastContent.parts.length > 0) {
            // Find the first text part
            const textPart = lastContent.parts.find((part: any) => part.text);
            if (textPart) {
                lastUserContent = textPart.text;
            }
        }

        if (!lastUserContent) {
             // Use double quotes for the outer string
             return response.status(400).json({ error: { code: 400, message: "Invalid request body: Could not extract valid user content from the last entry in 'contents'.", status: 'INVALID_ARGUMENT' }});
        }

        const formattedMessages: IMessage[] = [{ content: lastUserContent, model: { id: modelId } }];
 
        // --- Call the central message handler ---
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        } else {
            console.warn(`Gemini Route - Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
        }
        
        // --- Format response like Gemini ---
        const geminiResponse = {
            candidates: [
                {
                    content: {
                        parts: [{ text: result.response }],
                        role: "model"
                    },
                    finishReason: "STOP", // Default - we don't get this detail back
                    index: 0,
                    // Basic safety ratings - replace with actual if available
                    safetyRatings: [
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "NEGLIGIBLE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" },
                        { category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "NEGLIGIBLE" }
                    ]
                }
            ],
            // Basic usage metadata - refine if more detailed token counts become available
             usageMetadata: {
               // promptTokenCount: ???, // We don't have separate counts yet
               // candidatesTokenCount: ???, // We don't have separate counts yet
               totalTokenCount: totalTokensUsed 
             }
        };
 
        response.json(geminiResponse);
 
   } catch (error: any) { 
        console.error('Gemini Route - generateContent error:', error.message, error.stack);
        
        // Map internal errors to potential Gemini error formats
        if (error instanceof SyntaxError) return response.status(400).json({ error: { code: 400, message: 'Invalid JSON payload.', status: 'INVALID_ARGUMENT' }});
        
        if (error.message.includes('Unauthorized') || error.message.includes('API key not valid')) {
             return response.status(401).json({ error: { code: 401, message: error.message , status: 'UNAUTHENTICATED' }});
        }
        if (error.message.includes('limit reached')) {
             return response.status(429).json({ error: { code: 429, message: error.message, status: 'RESOURCE_EXHAUSTED' }});
        }
         if (error.message.includes('No currently active provider supports model') || error.message.includes('No provider (active or disabled) supports model')) {
             // Model not found or unavailable via this proxy
             return response.status(404).json({ error: { code: 404, message: `Model ${modelId} not found or is not supported.`, status: 'NOT_FOUND' }});
        }
         if (error.message.includes('Failed to process request')) {
              // Generic failure after retries
             return response.status(503).json({ error: { code: 503, message: 'The service is currently unavailable. Please try again later.', status: 'UNAVAILABLE' }});
         }
        // Default internal error
        response.status(500).json({ error: { code: 500, message: 'Internal server error.', status: 'INTERNAL' }});
   }
});

export default router; // Export the router 