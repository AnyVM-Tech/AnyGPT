import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler.js'; 
import { IMessage } from '../providers/interfaces.js'; 
import { 
    generateUserApiKey, // Now async
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage, // Now async
    TierData // Import TierData type
} from '../modules/userData.js';
import { logError } from '../modules/errorLogger.js'; // Changed import

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
  const apiKey = request.headers['x-goog-api-key'] as string;
  const timestamp = new Date().toISOString();

  if (!apiKey) {
     const errDetail = { message: "API key missing. Please pass an API key in 'x-goog-api-key' header.", code: 401, status: 'UNAUTHENTICATED' };
     await logError(errDetail, request); // Renamed and added await
     if (!response.completed) {
        return response.status(401).json({ error: { code: 401, message: errDetail.message, status: 'UNAUTHENTICATED' }, timestamp }); 
     } else { return; }
  }
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey);
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          const statusText = statusCode === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAUTHENTICATED';
          const logMsg = `API key not valid. ${validationResult.error || 'Please pass a valid API key.'}`;
          await logError({ message: logMsg, details: validationResult.error, apiKey, code: statusCode, status: statusText }, request); // Renamed and added await
          if (!response.completed) {
            return response.status(statusCode).json({ error: { code: statusCode, message: logMsg, status: statusText }, timestamp }); 
          } else { return; }
      }

      // Attach data
      request.apiKey = apiKey;
      request.userId = validationResult.userData.userId;
      request.userRole = validationResult.userData.role;
      request.userTokenUsage = validationResult.userData.tokenUsage; 
      request.userTier = validationResult.userData.tier; 
      request.tierLimits = validationResult.tierLimits; 
      
      // Let flow continue naturally in async middleware for HyperExpress
      next();

  } catch (error: any) {
       await logError(error, request); // Renamed and added await
       console.error("Gemini Route - Error during auth/usage check:", error);
       if (!response.completed) {
         return response.status(500).json({ 
             error: 'Internal Server Error', 
             reference: 'Error during authentication processing.',
             timestamp 
         }); 
       } else { return; }
  }
}

// RATE LIMIT Middleware (Copied and adapted - Synchronous)
// NOTE: Ideally, middleware should be defined centrally and imported.
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    const timestamp = new Date().toISOString(); // For error responses
    if (!request.apiKey || !request.tierLimits) { 
        const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (Gemini rateLimitMiddleware).';
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
    
    const oneDayAgo = now - 86400000;
    const oneMinuteAgo = now - 60000;
    const oneSecondAgo = now - 1000;

    // Keep only relevant timestamps to avoid memory leak
    const relevantTimestamps = currentApiKeyTimestamps.filter(ts => ts > oneDayAgo);
    requestTimestamps[apiKey] = relevantTimestamps;

    const requestsLastDay = relevantTimestamps.length;
    const requestsLastMinute = relevantTimestamps.filter(ts => ts > oneMinuteAgo).length;
    const requestsLastSecond = relevantTimestamps.filter(ts => ts > oneSecondAgo).length;

    const errorStatus = 'RESOURCE_EXHAUSTED'; // Common status for Gemini rate limits

    if (tierLimits.rps > 0 && requestsLastSecond >= tierLimits.rps) {
         const errDetail = { message: `Rate limit exceeded: Max ${tierLimits.rps} RPS. Please try again later.`, code: 429, status: errorStatus };
         logError(errDetail, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
         response.setHeader('Retry-After', '1'); 
         if (!response.completed) {
           return response.status(429).json({ error: errDetail, timestamp });
         } else { return; }
    }
    if (tierLimits.rpm > 0 && requestsLastMinute >= tierLimits.rpm) {
        const errDetail = { message: `Rate limit exceeded: Max ${tierLimits.rpm} RPM. Please try again later.`, code: 429, status: errorStatus };
        logError(errDetail, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
        const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0, (relevantTimestamps.find(ts => ts > oneMinuteAgo) || now) + 60000 - now) / 1000));
        response.setHeader('Retry-After', String(retryAfterSeconds));
        if (!response.completed) {
          return response.status(429).json({ error: errDetail, timestamp });
        } else { return; }
    }
    if (tierLimits.rpd > 0 && requestsLastDay >= tierLimits.rpd) {
        const errDetail = { message: `Rate limit exceeded: Max ${tierLimits.rpd} RPD. Please try again later.`, code: 429, status: errorStatus };
        logError(errDetail, request).catch(e => console.error("Failed background log:",e)); // Log but don't wait
        const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(0,(relevantTimestamps[0] || now) + 86400000 - now) / 1000));
        response.setHeader('Retry-After', String(retryAfterSeconds)); 
        if (!response.completed) {
          return response.status(429).json({ error: errDetail, timestamp });
        } else { return; }
    }
    
    requestTimestamps[apiKey].push(now);
    next(); 
}
 
// --- Routes ---
 
// Gemini Generate Content Route
router.post('/v2/models/:modelId/generateContent', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
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

        let lastUserContent = '';
        const lastContent = body.contents[body.contents.length - 1];
        if (lastContent && lastContent.role === 'user' && Array.isArray(lastContent.parts) && lastContent.parts.length > 0) {
            const textPart = lastContent.parts.find((part: any) => part.text);
            if (textPart && typeof textPart.text === 'string') {
                lastUserContent = textPart.text;
            }
        }
        if (!lastUserContent) {
             const errDetail = { message: "Invalid request body: Could not extract valid user content from 'contents'.", code: 400, status: 'INVALID_ARGUMENT' };
             await logError(errDetail, request); // Renamed and added await
             if (!response.completed) {
                return response.status(400).json({ error: errDetail, timestamp: new Date().toISOString() });
             } else { return; }
        }

        const formattedMessages: IMessage[] = [{ content: lastUserContent, model: { id: modelId } }];
        const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        }
        
        const geminiResponse = {
            candidates: [
                {
                    content: { parts: [{ text: result.response }], role: "model" },
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
             usageMetadata: { totalTokenCount: totalTokensUsed }
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
        } else if (error.message.includes("Invalid request body: Could not extract valid user content")) {
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

const geminiRouter = router;
export default geminiRouter;