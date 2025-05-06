import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler'; 
import { IMessage } from '../providers/interfaces'; 
import { 
    generateUserApiKey, // Now async
    extractMessageFromRequest, 
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage, // Now async
} from '../modules/userData';
// Import TierData type for Request extension
import { TierData } from '../modules/userData'; 
import { logErrorToFile } from '../modules/errorLogger';
 
dotenv.config();
 
const openaiRouter = new HyperExpress.Router();
 
// --- Rate Limiting Store --- 
interface RequestTimestamps { [apiKey: string]: number[]; }
const requestTimestamps: RequestTimestamps = {};
 
// --- Request Extension ---
declare module 'hyper-express' {
  interface Request {
    apiKey?: string; userId?: string; userRole?: string;
    userTokenUsage?: number; userTier?: string; 
    tierLimits?: TierData; 
  }
}
 
// --- Middleware ---
 
// MUST be async because it calls await validateApiKeyAndUsage
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const authHeader = request.headers['authorization'] || request.headers['Authorization'];
  let apiKey = '';

  // Try Authorization header first (OpenAI style)
  if (authHeader && authHeader.startsWith('Bearer ')) {
     apiKey = authHeader.slice(7);
  } else {
     // Fallback to api-key header (Azure style)
     const apiKeyHeader = request.headers['api-key']; 
     if (typeof apiKeyHeader === 'string' && apiKeyHeader) {
         apiKey = apiKeyHeader;
     } else {
         logErrorToFile({ message: 'Unauthorized: Missing API key' }, request);
         return response.status(401).json({ error: 'Unauthorized: Missing or invalid API key header.', timestamp: new Date().toISOString() }); 
     }
  }
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401;
          const errorMessage = `Unauthorized: ${validationResult.error || 'Invalid key/config.'}`;
          logErrorToFile({ message: errorMessage, statusCode: statusCode, apiKey: apiKey }, request);
          return response.status(statusCode).json({ error: errorMessage, timestamp: new Date().toISOString() }); 
      }

      // Attach data
      request.apiKey = apiKey;
      request.userId = validationResult.userData.userId;
      request.userRole = validationResult.userData.role;
      request.userTokenUsage = validationResult.userData.tokenUsage; 
      request.userTier = validationResult.userData.tier; 
      request.tierLimits = validationResult.tierLimits; 
      
      // In async middleware for HyperExpress, typically you DON'T call next()
      // if you want subsequent route handlers matching the path to run.
      // If you NEED sequential middleware execution guarantee, chaining promises or
      // restructuring might be required. Let's assume for now not calling next() works.
      // If requests hang, this is the place to investigate HyperExpress async middleware patterns.
       // next(); // REMOVED next() call - let flow continue naturally after await

  } catch (error: any) {
       logErrorToFile(error, request);
       console.error("Error during auth/usage check:", error);
       // Generic client message for 500
       return response.status(500).json({ error: "Internal Server Error", reference: "Error during authentication processing.", timestamp: new Date().toISOString() }); 
  }
}

// Remains synchronous
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    if (!request.apiKey || !request.tierLimits) { 
        const errMsg = 'Internal Error: API Key or Tier Limits missing after auth (rateLimitMiddleware).';
        logErrorToFile({ message: errMsg, requestPath: request.path }, request); // Log full error
        console.error(errMsg);
        // Generic client message for 500
        return response.status(500).json({ error: 'Internal Server Error', reference: 'Configuration error for rate limiting.', timestamp: new Date().toISOString() });
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

    if (requestsLastSecond >= tierLimits.rps) {
         response.setHeader('Retry-After', '1'); 
         logErrorToFile({ message: `Rate limit exceeded: Max ${tierLimits.rps} RPS.`, apiKey }, request);
         return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rps} RPS.`, timestamp: new Date().toISOString() });
    }
     if (requestsLastMinute >= tierLimits.rpm) {
         const retryAfterSeconds = Math.ceil(Math.max(0, (recentTimestamps[recentTimestamps.length - tierLimits.rpm] + 60000 - now) / 1000));
         response.setHeader('Retry-After', String(retryAfterSeconds)); 
        logErrorToFile({ message: `Rate limit exceeded: Max ${tierLimits.rpm} RPM.`, apiKey }, request);
        return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rpm} RPM.`, timestamp: new Date().toISOString() });
    }
    if (requestsLastDay >= tierLimits.rpd) {
         const retryAfterSeconds = Math.ceil(Math.max(0,(recentTimestamps[0] + 86400000 - now) / 1000));
        response.setHeader('Retry-After', String(retryAfterSeconds)); 
        logErrorToFile({ message: `Rate limit exceeded: Max ${tierLimits.rpd} RPD.`, apiKey }, request);
        return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rpd} RPD.`, timestamp: new Date().toISOString() });
    }
    recentTimestamps.push(now);
    requestTimestamps[apiKey] = recentTimestamps; 
    next(); // OK to call next() in sync middleware
}
 
// --- Routes ---
 
// Generate Key Route - Handler becomes async
openaiRouter.post('/generate_key', authAndUsageMiddleware, async (request: Request, response: Response) => {
  // Check if middleware failed (e.g., if it didn't attach data)
  if (!request.apiKey || request.userRole === undefined) {
       logErrorToFile({ message: 'Authentication failed in /generate_key route after middleware' }, request);
       return response.status(401).json({ error: 'Authentication failed', timestamp: new Date().toISOString() }); 
  }
  try {
    if (request.userRole !== 'admin') {
        logErrorToFile({ message: 'Forbidden: Non-admin attempt to generate key', userId: request.userId }, request);
        return response.status(403).json({ error: 'Forbidden', timestamp: new Date().toISOString() });
    }
    const { userId } = await request.json(); 
    if (!userId || typeof userId !== 'string') {
        logErrorToFile({ message: 'Bad Request: userId required for key generation' }, request);
        return response.status(400).json({ error: 'Bad Request: userId required', timestamp: new Date().toISOString() });
    }
    
    // --- Use await ---
    const newUserApiKey = await generateUserApiKey(userId); 
    response.json({ apiKey: newUserApiKey });
  } catch (error: any) {
    logErrorToFile(error, request);
    console.error('Generate key error:', error);
    const timestamp = new Date().toISOString();
    if (error.message.includes('already has')) return response.status(409).json({ error: error.message, timestamp }); 
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Invalid JSON', timestamp });
    response.status(500).json({ error: 'Internal Server Error', reference: 'Failed to generate key.', timestamp });
  }
});
 
 
// Apply Middlewares - order matters
// Run auth/usage check first. Since it's async and doesn't call next(), 
// rateLimitMiddleware needs to be applied *specifically* to the route AFTER auth.
openaiRouter.use('/v1', authAndUsageMiddleware); 
// This pattern might be needed if async middleware doesn't implicitly pass control:
openaiRouter.use('/v1/chat/completions', rateLimitMiddleware); 
 
// Chat Completions Route - Handler is already async
openaiRouter.post('/v1/chat/completions', async (request: Request, response: Response) => {
   // Check if middleware failed
   if (!request.apiKey || !request.tierLimits) {
        logErrorToFile({ message: 'Authentication or configuration failed in /v1/chat/completions after middleware' }, request);
        return response.status(401).json({ error: 'Authentication or configuration failed', timestamp: new Date().toISOString() }); 
   }
  try {
    const userApiKey = request.apiKey!; 
    const tierLimits = request.tierLimits!; 
    const { messages: rawMessages, model: modelId } = await extractMessageFromRequest(request);
    
    // Per-request token check logic (remains commented out or implement as needed)

    const formattedMessages: IMessage[] = rawMessages.map(msg => ({ content: msg.content, model: { id: modelId } }));
 
    // messageHandler call is already async
    const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);
 
    const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
    if (totalTokensUsed > 0) {
        // --- Use await ---
        await updateUserTokenUsage(totalTokensUsed, userApiKey); 
    } else {
        console.warn(`Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
    }
 
    // --- Format response strictly like OpenAI --- 
    const openaiResponse = {
        id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000), // Unix timestamp
        model: modelId,
        // system_fingerprint: null, // OpenAI typically includes this. Set to null if not available.
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: result.response,
                },
                logprobs: null, // OpenAI includes this, set to null if not applicable
                finish_reason: "stop", // Assuming stop as default
            }
        ],
        usage: {
            // prompt_tokens: result.promptTokens, // Include if available from messageHandler
            // completion_tokens: result.completionTokens, // Include if available from messageHandler
            total_tokens: totalTokensUsed
        }
        // Custom fields _latency_ms and _provider_id are removed
    };

    response.json(openaiResponse);
 
  } catch (error: any) { 
    logErrorToFile(error, request);
    console.error('Chat completions error:', error.message, error.stack);
    const timestamp = new Date().toISOString();
    let statusCode = 500;
    let clientMessage = 'Internal Server Error';
    let clientReference = 'An unexpected error occurred while processing your chat request.';

    if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse')) {
        statusCode = 400;
        clientMessage = `Bad Request: ${error.message}`;
    } else if (error instanceof SyntaxError) {
        statusCode = 400;
        clientMessage = 'Invalid JSON';
    } else if (error.message.includes('Unauthorized') || error.message.includes('limit reached')) {
        statusCode = error.message.includes('limit reached') ? 429 : 401;
        clientMessage = error.message;
    } else if (error.message.includes('No suitable providers')) {
        statusCode = 503;
        clientMessage = error.message;
    } else if (error.message.includes('Provider') && error.message.includes('failed')) {
        statusCode = 502;
        clientMessage = error.message;
    }
    
    if (statusCode === 500) {
        response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
    } else {
        response.status(statusCode).json({ error: clientMessage, timestamp });
    }
  }
});

// --- Azure OpenAI Compatible Route ---
openaiRouter.post('/openai/deployments/:deploymentId/chat/completions', authAndUsageMiddleware, rateLimitMiddleware, async (request: Request, response: Response) => {
    // Middleware should have attached these if successful
    if (!request.apiKey || !request.tierLimits || !request.params.deploymentId) {
        logErrorToFile({ message: 'Authentication or configuration failed (Azure route) after middleware' }, request);
        return response.status(401).json({ error: 'Authentication or configuration failed (Azure route).', timestamp: new Date().toISOString() }); 
    }

    // Check for api-version query parameter (required by Azure)
    const apiVersion = request.query['api-version'];
    if (!apiVersion || typeof apiVersion !== 'string') {
         logErrorToFile({ message: 'Bad Request: Missing or invalid api-version query parameter (Azure route)' }, request);
         return response.status(400).json({ error: 'Bad Request: Missing or invalid \'api-version\' query parameter.', timestamp: new Date().toISOString() });
    }

    const userApiKey = request.apiKey!;
    const deploymentId = request.params.deploymentId; // Use deploymentId as the modelId
    const tierLimits = request.tierLimits!;

    try {
        // Extract messages using the same logic as the standard route
        const { messages: rawMessages } = await extractMessageFromRequest(request); 

        // Use deploymentId as model identifier for the handler
        const formattedMessages: IMessage[] = rawMessages.map(msg => ({ content: msg.content, model: { id: deploymentId } }));
 
        // Call the central message handler
        const result = await messageHandler.handleMessages(formattedMessages, deploymentId, userApiKey);
 
        const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
        if (totalTokensUsed > 0) {
            await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        } else {
            console.warn(`Azure Route - Token usage not reported/zero for key ${userApiKey.substring(0, 6)}...`);
        }
 
        // --- Format response strictly like OpenAI --- 
        const openaiResponse = {
            id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2)}`, 
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: deploymentId, // Use deployment ID here as the model identifier
            // system_fingerprint: null, // Set to null if not available.
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.response,
                    },
                    logprobs: null, // Set to null if not applicable
                    finish_reason: "stop", 
                }
            ],
            usage: {
                // prompt_tokens: result.promptTokens, // Include if available
                // completion_tokens: result.completionTokens, // Include if available
                total_tokens: totalTokensUsed
            }
            // Custom fields _latency_ms and _provider_id are removed
        };

        response.json(openaiResponse);

    } catch (error: any) {
        logErrorToFile(error, request);
        console.error('Azure Chat completions error:', error.message, error.stack);
        const timestamp = new Date().toISOString();
        let statusCode = 500;
        let clientMessage = 'Internal Server Error';
        let clientReference = 'An unexpected error occurred while processing your Azure chat request.';

        if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse')) {
            statusCode = 400;
            clientMessage = `Bad Request: ${error.message}`;
        } else if (error instanceof SyntaxError) {
            statusCode = 400;
            clientMessage = 'Invalid JSON';
        } else if (error.message.includes('Unauthorized') || error.message.includes('limit reached')) {
            statusCode = error.message.includes('limit reached') ? 429 : 401;
            clientMessage = error.message;
        } else if (error.message.includes('No suitable providers') || error.message.includes('supports model') || error.message.includes('No provider')) {
             statusCode = 404;
             clientMessage = `Deployment not found or model unsupported: ${deploymentId}`;
        } else if (error.message.includes('Provider') && error.message.includes('failed')) {
            statusCode = 502;
            clientMessage = error.message;
        } else if (error.message.includes('Failed to process request')) { 
            statusCode = 503;
            clientMessage = 'Service temporarily unavailable after multiple provider attempts.';
        }
        
        if (statusCode === 500) {
            response.status(statusCode).json({ error: clientMessage, reference: clientReference, timestamp });
        } else {
            response.status(statusCode).json({ error: clientMessage, timestamp });
        }
    }
});
 
export default openaiRouter;
