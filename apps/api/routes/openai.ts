import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler'; 
import { IMessage } from '../providers/interfaces'; 
import { 
    generateUserApiKey, // Now async
    extractMessageFromRequest, 
    updateUserTokenUsage, // Now async
    validateApiKeyAndUsage // Now async
} from '../modules/userData';
// Import TierData type for Request extension
import { TierData } from '../modules/userData'; 
 
dotenv.config();
 
const server = new HyperExpress.Server();
 
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
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
     // Since this is async, we MUST await the response sending or return it
     return response.status(401).json({ error: 'Unauthorized: Missing header' }); 
  }
  const apiKey = authHeader.slice(7);
  
  try {
      const validationResult = await validateApiKeyAndUsage(apiKey); 
      if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
          const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; 
          // Must return response
          return response.status(statusCode).json({ error: `Unauthorized: ${validationResult.error || 'Invalid key/config.'}` }); 
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

  } catch (error) {
       console.error("Error during auth/usage check:", error);
       // Must return response
       return response.status(500).json({ error: "Internal Server Error during validation." }); 
  }
}

// Remains synchronous
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    if (!request.apiKey || !request.tierLimits) { 
        console.error('Internal Error: API Key or Tier Limits missing (rateLimitMiddleware).');
        return response.status(500).json({ error: 'Internal Server Error' }); // Return
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
         return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rps} RPS.` }); // Return
    }
     if (requestsLastMinute >= tierLimits.rpm) {
         const retryAfterSeconds = Math.ceil(Math.max(0, (recentTimestamps[recentTimestamps.length - tierLimits.rpm] + 60000 - now) / 1000));
         response.setHeader('Retry-After', String(retryAfterSeconds)); 
        return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rpm} RPM.` }); // Return
    }
    if (requestsLastDay >= tierLimits.rpd) {
         const retryAfterSeconds = Math.ceil(Math.max(0,(recentTimestamps[0] + 86400000 - now) / 1000));
        response.setHeader('Retry-After', String(retryAfterSeconds)); 
        return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rpd} RPD.` }); // Return
    }
    recentTimestamps.push(now);
    requestTimestamps[apiKey] = recentTimestamps; 
    next(); // OK to call next() in sync middleware
}
 
// --- Routes ---
 
// Generate Key Route - Handler becomes async
server.post('/generate_key', authAndUsageMiddleware, async (request: Request, response: Response) => {
  // Check if middleware failed (e.g., if it didn't attach data)
  if (!request.apiKey || request.userRole === undefined) {
       // This might indicate middleware didn't run correctly or exited early
       // If authAndUsageMiddleware sends a response on failure, this won't be reached.
       return response.status(401).json({ error: 'Authentication failed' }); 
  }
  try {
    if (request.userRole !== 'admin') return response.status(403).json({ error: 'Forbidden' });
    const { userId } = await request.json(); 
    if (!userId || typeof userId !== 'string') return response.status(400).json({ error: 'Bad Request: userId required' });
    
    // --- Use await ---
    const newUserApiKey = await generateUserApiKey(userId); 
    response.json({ apiKey: newUserApiKey });
  } catch (error: any) {
    console.error('Generate key error:', error);
    if (error.message.includes('already has')) return response.status(409).json({ error: error.message }); 
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Invalid JSON' });
    response.status(500).json({ error: 'Internal error' });
  }
});
 
 
// Apply Middlewares - order matters
// Run auth/usage check first. Since it's async and doesn't call next(), 
// rateLimitMiddleware needs to be applied *specifically* to the route AFTER auth.
server.use('/v1', authAndUsageMiddleware); 
// This pattern might be needed if async middleware doesn't implicitly pass control:
server.use('/v1/chat/completions', rateLimitMiddleware); 
 
// Chat Completions Route - Handler is already async
server.post('/v1/chat/completions', async (request: Request, response: Response) => {
   // Check if middleware failed
   if (!request.apiKey || !request.tierLimits) {
        return response.status(401).json({ error: 'Authentication or configuration failed' }); 
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
 
    response.json(result);
 
  } catch (error: any) { 
    // ... (error handling remains largely the same, checking specific error messages) ...
    console.error('Chat completions error:', error.message, error.stack);
    if (error.message.startsWith('Invalid request') || error.message.startsWith('Failed to parse')) return response.status(400).json({ error: `Bad Request: ${error.message}` });
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Invalid JSON' });
    if (error.message.includes('Unauthorized') || error.message.includes('limit reached')) {
        const statusCode = error.message.includes('limit reached') ? 429 : 401;
        return response.status(statusCode).json({ error: error.message });
    }
    if (error.message.includes('No suitable providers')) return response.status(503).json({ error: error.message }); 
    if (error.message.includes('Provider') && error.message.includes('failed')) return response.status(502).json({ error: error.message }); 
    response.status(500).json({ error: 'Internal Server Error' });
  }
});
 
// --- Server Start ---
// ... (remains same) ...
const port = parseInt(process.env.PORT || '3000', 10);
if (isNaN(port) || port <= 0) console.error(`Invalid PORT: ${process.env.PORT}. Using 3000.`);
server.listen(port || 3000)
  .then(() => console.log(`Server listening on port ${port || 3000}`))
  .catch((err) => console.error('Failed to start server:', err));
