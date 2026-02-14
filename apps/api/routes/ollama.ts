import HyperExpress, { Request, Response } from '../lib/uws-compat.js';
import dotenv from 'dotenv';
import { messageHandler } from '../providers/handler.js'; 
import { IMessage } from '../providers/interfaces.js'; 
import { 
    updateUserTokenUsage, // Now async
    TierData, // Import TierData type
    // We don\'t use extractMessageFromRequest for Ollama format
} from '../modules/userData.js';
import { RequestTimestampStore } from '../modules/rateLimit.js';
import { runAuthMiddleware, runRateLimitMiddleware } from '../modules/middlewareFactory.js';

dotenv.config();

const router = new HyperExpress.Router(); // Use Router for modularity

// --- Rate Limiting Store --- 
const requestTimestamps: RequestTimestampStore = {}; 

// --- Request Extension --- 
// Assumed globally declared

// --- Middleware --- 

// AUTH Middleware (Using Bearer token for consistency)
async function authAndUsageMiddleware(request: Request, response: Response, next: () => void) {
    return runAuthMiddleware(request, response, next, {
        callNext: false,
        extractApiKey: (req) => {
            const authHeader = req.headers['authorization'] || req.headers['Authorization'];
            return authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        },
        onMissingApiKey: () => ({ status: 401, body: { error: 'Unauthorized: Missing or invalid Bearer token.' } }),
        onInvalidApiKey: (_req, details) => ({ status: details.statusCode, body: { error: `Unauthorized: ${details.error || 'Invalid API Key'}` } }),
        onInternalError: (_req, error) => {
            console.error('Ollama Route - Error during auth/usage check:', error);
            return { status: 500, body: { error: 'Internal server error during validation.' } };
        },
    });
}

// RATE LIMIT Middleware
function rateLimitMiddleware(request: Request, response: Response, next: () => void) {
        return runRateLimitMiddleware(request, response, next, requestTimestamps, {
            onMissingContext: () => {
                console.error('Ollama Route - Internal Error: API Key or Tier Limits missing.');
                return { status: 500, body: { error: 'Internal server error affecting rate limits.' } };
            },
            onDenied: (_req, details) => {
                const windowLabel = details.window === 'rps'
                    ? 'requests per second'
                    : details.window === 'rpm'
                        ? 'requests per minute'
                        : 'requests per day';
                return { status: 429, body: { error: `Rate limit exceeded: You are limited to ${details.limit} ${windowLabel}.` } };
            }
        });
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
        const promptTokens = typeof result.promptTokens === 'number' ? result.promptTokens : Math.ceil(lastUserContent.length / 4); 
        const completionTokens = typeof result.completionTokens === 'number' ? result.completionTokens : Math.max(0, totalTokensUsed - promptTokens); 

        await updateUserTokenUsage(totalTokensUsed, userApiKey); 
        
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