import HyperExpress, { Request, Response } from 'hyper-express';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler'; 
import { IMessage } from '../providers/interfaces'; 
import { 
    generateUserApiKey, 
    // Removed unused validateApiKey import
    extractMessageFromRequest, 
    updateUserTokenUsage, 
    getUserTierLimits, // Keep for rateLimitMiddleware
    validateApiKeyAndUsage // Use the new combined validation function
} from '../modules/userData';

dotenv.config();

const server = new HyperExpress.Server();

// --- Rate Limiting In-Memory Store --- 
interface RequestTimestamps {
    [apiKey: string]: number[]; 
}
const requestTimestamps: RequestTimestamps = {};

// Extend Request interface for custom properties
declare module 'hyper-express' {
  interface Request {
    apiKey?: string;
    userId?: string;
    userRole?: string;
    userTokenUsage?: number; // Current cumulative usage
    userTier?: string; 
    // Add tierLimits to request object for easier access in rateLimitMiddleware
    tierLimits?: { 
        rps: number; 
        rpm: number; 
        rpd: number; 
        max_tokens: number | null; 
      }; 
  }
}

// --- Middleware ---

// Combined Auth and Cumulative Usage Check Middleware
function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
  const authHeader = request.headers['authorization'] || request.headers['Authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return response.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
  }

  const apiKey = authHeader.slice(7);
  
  // Use the combined validation function (synchronous)
  const validationResult = validateApiKeyAndUsage(apiKey); 

  if (!validationResult.valid || !validationResult.userData || !validationResult.tierLimits) {
      // Handle different invalid cases
      const statusCode = validationResult.error?.includes('limit reached') ? 429 : 401; // 429 for limit, 401 for others
      return response.status(statusCode).json({ error: `Unauthorized: ${validationResult.error || 'Invalid API key or configuration.'}` });
  }

  // Attach validated data to the request object
  request.apiKey = apiKey;
  request.userId = validationResult.userData.userId;
  request.userRole = validationResult.userData.role;
  request.userTokenUsage = validationResult.userData.tokenUsage; // Attach current usage
  request.userTier = validationResult.userData.tier; 
  request.tierLimits = validationResult.tierLimits; // Attach tier limits
  
  next(); // Proceed if valid and within limits
}

// Rate Limit Middleware (RPS/RPM/RPD) - Now uses tierLimits from request object
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
    // apiKey and tierLimits should be guaranteed by authAndUsageMiddleware success
    if (!request.apiKey || !request.tierLimits) { 
        console.error('Internal Error: API Key or Tier Limits missing after authAndUsageMiddleware.');
        return response.status(500).json({ error: 'Internal Server Error' });
    }

    const apiKey = request.apiKey;
    const tierLimits = request.tierLimits; // Get limits directly from request

    // No need to check if tierLimits exist here, as auth middleware did it

    const now = Date.now();
    requestTimestamps[apiKey] = requestTimestamps[apiKey] || [];
    const timestamps = requestTimestamps[apiKey];

    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneMinuteAgo = now - 60 * 1000;
    const oneSecondAgo = now - 1000;

    const recentTimestamps = timestamps.filter(ts => ts > oneDayAgo);

    const requestsLastDay = recentTimestamps.length;
    const requestsLastMinute = recentTimestamps.filter(ts => ts > oneMinuteAgo).length;
    const requestsLastSecond = recentTimestamps.filter(ts => ts > oneSecondAgo).length;

    // Check RPS/RPM/RPD limits
    if (requestsLastSecond >= tierLimits.rps) {
         response.setHeader('Retry-After', '1'); 
         return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rps} requests per second.` });
    }
     if (requestsLastMinute >= tierLimits.rpm) {
         response.setHeader('Retry-After', String(Math.ceil((recentTimestamps[recentTimestamps.length - tierLimits.rpm] + 60*1000 - now)/1000))); 
        return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rpm} requests per minute.` });
    }
    if (requestsLastDay >= tierLimits.rpd) {
        response.setHeader('Retry-After', String(Math.ceil((recentTimestamps[0] + 24*60*60*1000 - now) / 1000))); 
        return response.status(429).json({ error: `Rate limit exceeded: Max ${tierLimits.rpd} requests per day.` });
    }

    // Add current timestamp and update store 
    recentTimestamps.push(now);
    requestTimestamps[apiKey] = recentTimestamps; 

    next(); 
}

// --- Routes ---

// Generate Key Route - Needs auth middleware, but not rate limiting
server.post('/generate_key', authAndUsageMiddleware, async (request: Request, response: Response) => {
  try {
    // Check role attached by middleware
    if (request.userRole !== 'admin') {
      return response.status(403).json({ error: 'Forbidden: Only admins can generate user API keys' });
    }
    
    const { userId } = await request.json(); 
    if (!userId || typeof userId !== 'string') {
      return response.status(400).json({ error: 'Bad Request: userId (string) is required' });
    }

    const newUserApiKey = generateUserApiKey(userId); // Synchronous
    response.json({ apiKey: newUserApiKey });

  } catch (error: any) {
    console.error('Error generating API key:', error);
    if (error.message.includes('already has an API key')) return response.status(409).json({ error: error.message }); 
    if (error.message.includes('Configuration error')) return response.status(500).json({ error: `Internal Server Error: ${error.message}` }); 
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Bad Request: Invalid JSON' });
    response.status(500).json({ error: 'Internal Server Error generating key' });
  }
});


// Apply combined auth/usage middleware first to all /v1 routes
server.use('/v1', authAndUsageMiddleware); 
// Then apply rate limiting (RPS/RPM/RPD) specifically to chat completions
server.use('/v1/chat/completions', rateLimitMiddleware); 

// Chat Completions Route - Handler remains async
server.post('/v1/chat/completions', async (request: Request, response: Response) => {
  try {
    // Data like apiKey, tierLimits are guaranteed by middleware here
    const userApiKey = request.apiKey!; 
    const tierLimits = request.tierLimits!; 
    
    const { messages: rawMessages, model: modelId, max_tokens: requestedMaxTokens } = await extractMessageFromRequest(request);
    
    // Check request-specific max_tokens against tier's per-request limit (which is also named max_tokens now)
    // This might seem confusing: tierLimits.max_tokens is the CUMULATIVE limit, 
    // BUT we might also want a PER-REQUEST limit defined elsewhere or use a default.
    // For now, let's assume the tier's max_tokens is NOT meant for per-request checks, 
    // and rely on the underlying model's default or a hardcoded value if needed.
    // OR, we rename the cumulative limit in tiers.json to e.g., "cumulative_max_tokens"
    // and keep "max_tokens" for per-request limits.
    
    // --- Let's assume NO per-request check based on tierLimits.max_tokens for now ---
    // if (requestedMaxTokens && tierLimits.max_tokens !== null && requestedMaxTokens > tierLimits.max_tokens) {
    //     return response.status(400).json({ 
    //         error: `Bad Request: Requested max_tokens (${requestedMaxTokens}) exceeds the limit defined for your tier (${tierLimits.max_tokens}).` 
    //     });
    // }

    const formattedMessages: IMessage[] = rawMessages.map(msg => ({
        content: msg.content,
        model: { id: modelId } 
    }));

    const result = await messageHandler.handleMessages(formattedMessages, modelId, userApiKey);

    console.log('Provider Response:', result); 
    const totalTokensUsed = typeof result.tokenUsage === 'number' ? result.tokenUsage : 0;
    if (totalTokensUsed > 0) {
        // Update the cumulative usage count
        updateUserTokenUsage(totalTokensUsed, userApiKey); 
    } else {
        console.warn(`Token usage not reported or zero for request by key: ${userApiKey.substring(0, 6)}...`);
    }

    response.json(result);

  } catch (error: any) { 
    console.error('Error in /v1/chat/completions:', error.message, error.stack);
    if (error.message.startsWith('Invalid request format') || error.message.startsWith('Failed to parse request body')) {
        return response.status(400).json({ error: `Bad Request: ${error.message}` });
    }
    if (error instanceof SyntaxError) {
         return response.status(400).json({ error: 'Bad Request: Invalid JSON' });
     }
    response.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- Server Start ---
const port = parseInt(process.env.PORT || '3000', 10);
if (isNaN(port) || port <= 0) {
    console.error(`Invalid PORT environment variable: ${process.env.PORT}. Using default 3000.`);
}
server.listen(port || 3000)
  .then(() => console.log(`Server listening on port ${port || 3000}`))
  .catch((err) => console.error('Failed to start server:', err));
